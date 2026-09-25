// pay/server.js — 个人主体小程序「虚拟支付」接入: 按对话次数付费, 支付成功后向主服务分发新链接
//
// 流程(个人主体必须用虚拟支付, 不能用标准微信支付 JSAPI):
//   小程序填写次数 -> POST /api/order { code, count }
//     -> 微信 code 换 openid/session_key -> 用 AppKey 与 session_key 对 signData 签名
//     -> 返回 payData 给小程序调起 wx.requestVirtualPayment
//   用户支付完成 -> 微信「发货推送」POST /pay/notify(XML)
//     -> 验签(可选) -> 幂等(以 wx_order_id 去重) -> 标记已支付 -> 调主服务 /api/provision 建房间
//   兜底: GET /api/order/:id 在 pending 时主动 query_order 补发
//   小程序轮询 GET /api/order/:id -> 拿到新链接(url), 复制分享即可使用
//
// 测试模式(MOCK_PAY=1): 下单即视为已支付并立即分发房间, 无需微信资质, 用于联调。
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import * as VP from './virtual-pay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const orders = new Map();   // outTradeNo -> order
const accounts = new Map(); // openid -> { freeUses, purchased, addresses:[{room,url,limit,createdAt}], orders:[id] }

// 每个账户赠送的免费体验次数(近似「每台机器 10 次」; 小程序无设备级标识, 以 openid 计)
const FREE_USES = Number(process.env.FREE_USES) || 10;

// 设备级免费额度: 每个设备一个标识, 用于「每台设备只能免费体验一次」(对齐网页版 getDeviceId 机制)。
// 首次免费体验会把整份设备预算(=FREE_USES)用掉, 故实际上每设备只能点一次免费体验, 防换账号白嫖。
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const devices = new Map(); // deviceId -> { id, freeUsed }

// ---- 套餐定义: 每个套餐对应不同的「次数」与「单文件大小上限」 ----
// 微信虚拟支付的 goodsPrice 为「单价(分)」, 总价 = 单价 × count。各套餐统一单价 10 分/条:
//   1元/10条 = 10分/条, 5元/50条 = 10分/条, 25元/250条 = 10分/条, 50元/500条 = 10分/条
// 注: 真实虚拟支付每笔需对应后台「道具」价格; 这里 MOCK 模式直接按套餐下单,
//   真实上线时请为每个套餐在微信后台创建对应价格的道具, 并使 signData.goodsPrice 与之匹配。
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
// 免费体验房单文件上限(对齐网页版 2M, 防止免费用户传超大文件占用带宽); 付费房沿用套餐各自上限
const FREE_MAX_FILE_BYTES = 2 * MB;
const PACKAGES = [
  { id: 'p1',   label: '体验包', count: 10,  priceFen: 100,   maxFileBytes: 5 * MB },
  { id: 'p10',  label: '标准包', count: 50,  priceFen: 500,   maxFileBytes: 20 * MB },
  { id: 'p100', label: '畅享包', count: 250, priceFen: 2500,  maxFileBytes: 500 * MB },
  { id: 'p200', label: '旗舰包', count: 500, priceFen: 5000,  maxFileBytes: 1 * GB },
];
function fmtSize(bytes) {
  if (bytes >= GB) return (bytes / GB) + 'G';
  if (bytes >= MB) return Math.round(bytes / MB) + 'M';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'K';
  return bytes + 'B';
}

function loadOrders() {
  try {
    const j = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
    // orders 可能是数组(当前格式)或对象(旧/空格式), 二者都安全处理, 避免「重启后记录全空」
    const ords = j && j.orders;
    if (Array.isArray(ords)) {
      for (const o of ords) if (o && o.id) orders.set(o.id, o);
    } else if (ords && typeof ords === 'object') {
      for (const [id, o] of Object.entries(ords)) if (o) orders.set(id, o);
    }
    // 账户加载与订单解耦: 即便上面订单解析异常, 也不影响账户恢复(否则重启会丢失全部记录)
    const accs = j && j.accounts;
    if (accs && typeof accs === 'object' && !Array.isArray(accs)) {
      for (const [id, a] of Object.entries(accs)) accounts.set(id, a);
    }
  } catch (e) {
    console.warn('[pay] 加载 orders.json 失败, 将以空数据启动:', e && e.message);
  }
}
function saveOrders() {
  try {
    // 先写临时文件再原子替换, 避免写入中途进程崩溃导致 orders.json 被截断/清空
    const tmp = ORDERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      orders: [...orders.values()],
      accounts: Object.fromEntries(accounts),
    }));
    fs.renameSync(tmp, ORDERS_FILE);
  } catch {}
}
function ensureAccount(openid) {
  if (!openid) return null;
  let a = accounts.get(openid);
  if (!a) {
    // 首次访问即赠送免费次数
    a = { freeUses: FREE_USES, purchased: 0, maxFileBytes: 0, addresses: [], orders: [] };
    accounts.set(openid, a);
  } else if (typeof a.freeUses !== 'number' || a.freeUses < 0) {
    // 兼容旧数据: 早期版本未持久化 freeUses, 会导致重新申请地址时 limit 被算成 1(一次对话即耗尽)
    a.freeUses = FREE_USES;
    saveOrders();
  }
  return a;
}

// 设备级免费额度(对齐网页版 deviceKey / ensureDevice): 每个设备只赠送一份免费「房间使用额度」
function ensureDevice(id) {
  if (!id) return null;
  let d = devices.get(id);
  if (!d) { d = { id: String(id), freeUsed: 0 }; devices.set(id, d); }
  return d;
}
function saveDevices() {
  try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(Object.fromEntries(devices))); } catch {}
}
function loadDevices() {
  try {
    const j = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8'));
    if (j) for (const [id, d] of Object.entries(j)) devices.set(id, d);
  } catch {}
}

// 带超时(3s)地向主服务查询单个房间的已用次数; 失败/超时按 0 计, 不拖死整个接口
async function fetchRoomUsed(room) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${config.mainBaseUrl}/api/room/${room}`, { signal: ctrl.signal });
    const d = await r.json();
    if (d && !d.error && typeof d.used === 'number') return d.used;
    return 0;
  } catch { return 0; }
  finally { clearTimeout(timer); }
}
// 实时统计账户已用次数: 并行累加该用户所有房间的真实消息/传输数(主服务按条计数)
async function computeUsed(openid) {
  const acc = accounts.get(openid);
  if (!acc || !acc.addresses.length) return { used: 0, freeUsed: 0 };
  const usedArr = await Promise.all(acc.addresses.map((ad) => fetchRoomUsed(ad.room)));
  let used = 0, freeUsed = 0;
  acc.addresses.forEach((ad, i) => {
    const u = usedArr[i] || 0;
    used += u;
    // 仅「免费地址」(未付费, priceFen 为空或 0) 的消耗计入免费额度; 付费地址的消耗不算免费
    if (!(ad.priceFen > 0)) freeUsed += u;
  });
  return { used, freeUsed };
}
// 账户剩余次数 = 免费 + 已购 - 已用(每条消息/传输 = 1 次)
async function computeRemaining(openid) {
  const acc = ensureAccount(openid);
  const { used, freeUsed } = await computeUsed(openid);
  const remaining = Math.max(0, (acc.freeUses + acc.purchased) - used);
  return { freeUses: acc.freeUses, purchased: acc.purchased, used, freeUsed, remaining };
}
loadOrders();
loadDevices();
// 启动自检日志: 远端重启后若「账户数=0」, 说明 orders.json 没被持久化(容器/临时磁盘丢失), 记录必然为空。
console.log(`[pay] 启动完成: 已加载订单 ${orders.size} 笔, 账户 ${accounts.size} 个, 设备 ${devices.size} 个`);

function genOrderId() {
  return 'BOLL' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 调用主服务预创建一个带使用上限的房间, 返回 { room, key, url, limit, maxFileBytes }
async function provisionRoom(count, maxFileBytes = 0) {
  // 把公网地址经 x-public-base-url 传给主服务: 即便 pay 经由 localhost 调用主服务,
  // 主服务也能据此生成公网可达的房间链接(尤其 cloudflared 临时隧道每次地址都不同)。
  const resp = await fetch(`${config.mainBaseUrl}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.mainProvisionToken}`,
      'x-public-base-url': config.mainPublicBaseUrl || config.mainBaseUrl,
    },
    body: JSON.stringify({ count, maxFileBytes, note: 'paid' }),
  });
  if (!resp.ok) throw new Error('provision failed: ' + resp.status);
  return resp.json();
}

// 标记订单已支付并分发房间(幂等: 以 wx_order_id 去重)
async function markPaid(outTradeNo, transactionId, wxOrderId) {
  const o = orders.get(outTradeNo);
  if (!o) return;
  if (o.wxOrderId && wxOrderId && o.wxOrderId !== wxOrderId) return;
  if (o.status === 'paid') return;
  o.status = 'paid';
  o.paidAt = Date.now();
  o.transactionId = transactionId;
  o.wxOrderId = wxOrderId || o.wxOrderId;
  try {
    // 先建好房间(幂等: 若已 paid 在入口 return), 成功后才把次数计入账户,
    // 避免「房间建了但账户没记 / 主服务抖动导致购买次数丢失」的不一致
    // 对齐网页版: 每个套餐各自开一个「带次数上限」的房间, 上限 = 套餐自身次数(o.count),
    // 而非账户剩余总次数(否则首购时 rem 只含免费额度, 房间的「额度」会被压成 10, 与套餐不符)。
    const room = await provisionRoom(Math.max(1, o.count || 1), o.maxFileBytes || 0);
    o.room = room.room;
    o.url = room.url;
    o.limit = room.limit;
    o.maxFileBytes = room.maxFileBytes || 0;
    if (o.openid) {
      const acc = ensureAccount(o.openid);
      acc.purchased += o.count;          // 增加已购次数
      // 账户的「单文件上限」取历史购买中的最高档(重申请地址沿用最高档)
      acc.maxFileBytes = Math.max(acc.maxFileBytes || 0, o.maxFileBytes || 0);
      if (!acc.orders.includes(outTradeNo)) acc.orders.push(outTradeNo);
      acc.addresses.push({ room: room.room, url: room.url, limit: room.limit, count: o.count, maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(), label: o.label || '套餐', priceFen: o.priceFen || 0, orderId: outTradeNo });
    }
  } catch (e) {
    console.error('[pay] 分发房间失败', e.message);
    o.status = 'provision_failed';
  }
  saveOrders();
}

// 用账户剩余次数新申请一个地址(地址本身免费, 仅消息/传输消耗次数)。
// 对齐网页版: 免费额度部分走「设备级」限额(每台设备只能免费体验一次),
// 付费(已购)重申请不消耗设备免费预算; 仅当本次用的是「免费」额度时才扣设备预算。
async function newAddress(openid, deviceId) {
  const acc = ensureAccount(openid);
  if (!acc) throw new Error('账户不存在');
  const info = await computeRemaining(openid);
  const remaining = info.remaining;
  if (remaining <= 0) throw new Error('次数已用完, 请先购买');

  // 账户里属于「免费」额度的部分 → 设备级限额 + 账户级兜底(两条都拦, 保证「只能免费体验一次」)
  const freeRemaining = Math.max(0, acc.freeUses - (info.freeUsed || 0));
  let limit = remaining;
  let isFree = false;
  let dev = null;
  if (freeRemaining > 0) {
    // 账户级兜底: 该账户已领过免费体验则直接拦截(不依赖设备存储, 最可靠地保证「只能点一次」)
    const hasFree = acc.addresses.some((ad) => ad.label === '免费体验');
    if (hasFree) throw new Error('已领取过免费体验, 请购买套餐');
    // 设备级限额(对齐网页版 getDeviceId): 同一台设备跨账号也只能免费体验一次, 防换号白嫖
    if (!deviceId) throw new Error('设备标识缺失, 请重试');
    dev = ensureDevice(deviceId);
    const devFreeRemaining = Math.max(0, FREE_USES - (dev.freeUsed || 0));
    if (devFreeRemaining <= 0) throw new Error('本设备免费体验次数已用完, 请购买套餐');
    // 扣减设备免费预算(以「房间使用额度」计), 首次即把整份预算用掉, 故每设备实际上只能免费体验一次
    limit = Math.min(remaining, devFreeRemaining);
    isFree = true;
  }

  // 免费体验房单文件上限 2M; 付费重申请沿用账户已购套餐的上限
  const roomMaxFileBytes = isFree ? FREE_MAX_FILE_BYTES : (acc.maxFileBytes || 0);
  const room = await provisionRoom(limit, roomMaxFileBytes);
  if (dev) {
    dev.freeUsed = (dev.freeUsed || 0) + limit; // 对齐网页版: 按请求额度扣减, 不依赖房间返回字段
    saveDevices();
  }
  const label = acc.purchased > 0 ? '剩余次数重申请' : '免费体验';
  acc.addresses.push({ room: room.room, url: room.url, limit: room.limit, count: room.limit, maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(), label, priceFen: 0, orderId: '' });
  saveOrders();
  return { url: room.url, room: room.room, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, remaining: info.remaining };
}

const app = express();

// ---- 客户端引导配置: 把「当前 apiBase」以 JSON 暴露给小程序 ----
// start.sh 会把本次隧道地址(pay 经主隧道 /pay 反代)写入环境变量 MP_API_BASE,
// 小程序运行时用 wx.request 拉这份 JSON 即可拿到最新地址, 无需重编译、无需手动改存储。
// 注意: 该地址是「引导用」, 仅在开发者工具本地(localhost)可达; 真机/正式环境请改用
// 稳定的 CONFIG_JSON_URL(把同样内容托管到 GitHub Pages 等固定域名)。
app.get('/config.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ apiBase: process.env.MP_API_BASE || '' });
});

// ---- 套餐列表(前端支付页展示用, 单一数据源) ----
app.get('/api/packages', (req, res) => {
  res.json({
    packages: PACKAGES.map((p) => ({
      id: p.id,
      label: p.label,
      count: p.count,
      priceYuan: (p.priceFen / 100).toFixed(2),
      priceFen: p.priceFen,
      maxFileBytes: p.maxFileBytes,
      maxFileText: fmtSize(p.maxFileBytes),
    })),
  });
});

// ---- 下单(生成虚拟支付 payData) ----
app.post('/api/order', express.json(), async (req, res) => {
  try {
    // 优先按套餐下单(前端传 packageId); 无套餐时兼容旧的自填次数
    const pkg = (req.body.packageId && PACKAGES.find((p) => p.id === req.body.packageId)) || null;
    const count = pkg ? pkg.count : Math.max(1, Math.min(100000, parseInt(req.body.count, 10) || 1));
    const maxFileBytes = pkg ? pkg.maxFileBytes : 0;
    const outTradeNo = genOrderId();
    const order = {
      id: outTradeNo, count, status: 'pending', maxFileBytes,
      label: pkg ? pkg.label : '自定义套餐',
      priceFen: pkg ? pkg.priceFen : 0,
      outTradeNo, description: `bollweb ${pkg ? pkg.label : '使用次数'} ×${count}`,
      createdAt: Date.now(),
    };
    orders.set(outTradeNo, order);
    saveOrders();

    // 测试模式: 直接标记已支付并分发
    if (config.mockPay) {
      await markPaid(outTradeNo, 'MOCK' + outTradeNo, 'MOCK' + outTradeNo);
      return res.json({ orderId: outTradeNo, mock: true, status: order.status, url: order.url, room: order.room, limit: order.limit, maxFileBytes: order.maxFileBytes });
    }

    if (!config.appid || !config.appKey || !config.offerId || !config.productId) {
      return res.status(500).json({ error: '虚拟支付未配置(缺少 WX_APPID / WX_APP_KEY / WX_OFFER_ID / WX_PRODUCT_ID), 或先用 MOCK_PAY=1 测试' });
    }

    // 小程序 code 换 openid + session_key(用户态签名需要)
    const session = await VP.code2Session(req.body.code, config.appid, config.appSecret);
    if (!session.openid || !session.session_key) return res.status(400).json({ error: '获取 openid/session_key 失败', detail: session });
    order.openid = session.openid || req.body.openid || '';

    // signData 必须是「这个字符串原样」参与两处签名, 字段顺序固定
    const signData = {
      offerId: config.offerId,
      buyQuantity: count,
      env: 0,
      currencyType: 'CNY',
      productId: config.productId,
      // 单价(分): 套餐取「套餐价/条数」(需与微信后台对应道具价格一致), 否则用默认单价
      goodsPrice: pkg ? Math.round(pkg.priceFen / pkg.count) : config.pricePerUse,
      outTradeNo,
      attach: outTradeNo,             // 透传, 发货推送原样返回
    };
    const signDataStr = JSON.stringify(signData);
    const paySig = VP.calcPaySig(signDataStr, config.appKey);         // 支付签名(AppKey)
    const signature = VP.calcUserSig(signDataStr, session.session_key); // 用户态签名(session_key)

    saveOrders();
    res.json({
      orderId: outTradeNo,
      payData: { mode: 'short_series_goods', signData: signDataStr, paySig, signature },
    });
  } catch (e) {
    console.error('[pay] 下单失败', e);
    res.status(500).json({ error: '下单失败', detail: e.message });
  }
});

// ---- 查询订单 / 取回新链接(并兜底查单补发) ----
app.get('/api/order/:id', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'no such order' });

  // 兜底: 仍 pending 且已知 openid, 主动查单补发(推送丢失时恢复订单)
  if (o.status === 'pending' && o.openid && config.appKey && config.appid && config.appSecret) {
    try {
      const accessToken = await VP.getAccessToken(config.appid, config.appSecret);
      const r = await VP.queryOrder(o.openid, o.outTradeNo, config.appKey, accessToken);
      // order.status: 2-已支付待发货 3-发货中 4-已发货 (5/6/8 为退款/关闭, 不补发)
      if (r && r.errcode === 0 && r.order && [2, 3, 4].includes(r.order.status)) {
        await markPaid(o.outTradeNo, r.order.wx_order_id || r.order.wxpay_order_id || '', r.order.wx_order_id || '');
        // 走兜底路径补发时, 需主动通知微信发货完成(推送路径返回成功即可, 无需调用)
        if (o.status === 'paid') {
          VP.notifyProvideGoods(o.outTradeNo, config.appKey, accessToken)
            .then(() => console.log('[pay] 已通知微信发货完成:', o.outTradeNo))
            .catch((e) => console.warn('[pay] notify_provide_goods 失败(不影响本地发货):', e.message));
        }
      } else if (r && r.errcode !== 0) {
        console.warn('[pay] 兜底查单 errcode=' + r.errcode, r.errmsg || '');
      }
    } catch (e) { console.warn('[pay] 兜底查单失败', e.message); }
  }

  res.json({
    id: o.id, status: o.status, count: o.count,
    room: o.room || '', url: o.url || '', limit: o.limit || 0,
    maxFileBytes: o.maxFileBytes || 0,
  });
});

// ---- 登录: code 换 openid(供「我的记录 / 重新申请地址」) ----
app.post('/api/login', express.json(), async (req, res) => {
  try {
    const session = await VP.code2Session(req.body.code, config.appid, config.appSecret);
    if (!session.openid) return res.status(400).json({ error: '获取 openid 失败', detail: session });
    // 首次登录即开户, 让「我的记录」能立即看到赠送的免费次数(对齐网页版连接钱包后即有额度)
    ensureAccount(session.openid);
    saveOrders();
    res.json({ openid: session.openid });
  } catch (e) {
    res.status(500).json({ error: '登录失败', detail: e.message });
  }
});

// ---- 用剩余次数重新申请地址 ----
app.post('/api/room/new', express.json(), async (req, res) => {
  try {
    const r = await newAddress(req.body.openid, req.body.deviceId);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 房间链接的「公网主机」动态化: cloudflared 临时隧道每次地址都不同, 只影响主机部分,
// 房间号 r / 密钥 k / 名称 n 不变。这里仅替换 url 的 origin 为当前 MAIN_PUBLIC_BASE_URL
// (未配置时回退到本次请求的 Host), 使「更新全部地址」/ 服务重启后, 旧链接也能指向最新隧道,
// 无需逐条重新申请。注意: 若 pay 与聊天主服务不在同一隧道, 必须正确配置 MAIN_PUBLIC_BASE_URL。
function rewriteRoomUrl(url, req) {
  if (!url || typeof url !== 'string') return url;
  let base = config.mainPublicBaseUrl;
  if (!base && req) {
    const host = req.headers && req.headers.host;
    if (host) {
      const proto = (req.headers['x-forwarded-proto'] && String(req.headers['x-forwarded-proto']).split(',')[0].trim()) ||
        (req.socket && req.socket.encrypted ? 'https' : 'http');
      base = `${proto}://${host}`;
    }
  }
  if (!base) return url;
  try {
    const u = new URL(url);
    const b = new URL(base);
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  } catch { return url; }
}

// ---- 账户信息: 免费/已购/已用/剩余次数 + 地址列表(含每个地址的有效性) ----
app.get('/api/user/:openid', async (req, res) => {
  const acc = accounts.get(req.params.openid);
  // known: 该 openid 是否被服务端识别。客户端据此自愈「缓存的 openid 重启/换环境后失效」的问题,
  // 无需用户手动清缓存。
  if (!acc) return res.json({ known: false, freeUses: 0, freeRemaining: 0, purchased: 0, used: 0, remaining: 0, maxFileBytes: 0, addresses: [] });
  const info = await computeRemaining(req.params.openid);
  // 免费剩余: 仅扣除「免费地址」自身的已用, 不把付费地址的消耗算到免费额度上
  const freeRemaining = Math.max(0, acc.freeUses - (info.freeUsed || 0));
  // 逐个地址向主服务查询真实额度(额度=套餐内次数, 已用=每条消息/传输消耗, 剩余=套餐内还剩多少条)
  const latestRoom = acc.addresses.length ? acc.addresses[acc.addresses.length - 1].room : '';
  // 并行查询所有房间状态(带超时容错), 避免「我的记录」因逐个串行 fetch 而缓慢
  const roomStats = await Promise.all(acc.addresses.map(async (ad) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`${config.mainBaseUrl}/api/room/${ad.room}`, { signal: ctrl.signal });
      const d = await r.json();
      if (d && !d.error) return { used: d.used || 0, limit: d.limit || 0, remaining: d.remaining || 0, disabled: !!d.disabled };
    } catch {}
    finally { clearTimeout(timer); }
    return { used: 0, limit: ad.limit || 0, remaining: ad.limit || 0, disabled: false };
  }));
  const addresses = acc.addresses.map((ad, i) => ({
    ...ad,
    url: rewriteRoomUrl(ad.url, req),
    roomUsed: roomStats[i].used,
    roomLimit: roomStats[i].limit,
    roomRemaining: roomStats[i].remaining,
    // 额度: 优先用套餐自身次数(购买时记录), 重申请地址则用房间实际容量; 旧记录无 count 时回退到房间上限
    quota: (ad.count != null) ? ad.count : (roomStats[i].limit || ad.limit || 0),
    // 与网页版「我的记录」对齐: 透传禁用标记与单文件上限文案, 前端据此显示「已失效」徽标与「单文件上限」
    disabled: roomStats[i].disabled,
    maxFileText: fmtSize(ad.maxFileBytes || 0),
    // 有效性: 仅「最新生成的地址」有效; 旧地址一经生成新链接即被取代, 视为失效
    valid: ad.room === latestRoom,
  }));
  res.json({
    known: true,
    freeUses: acc.freeUses,
    freeRemaining,
    purchased: info.purchased,
    used: info.used,
    remaining: info.remaining,
    maxFileBytes: acc.maxFileBytes || 0,
    addresses,
  });
});

// ---- 微信发货推送(支付成功后平台主动调用) ----
app.post('/pay/notify', express.text({ type: '*/*' }), (req, res) => {
  const raw = req.body || '';
  const ok = (xml) => res.send(VP.buildXml(xml));
  try {
    const parsed = VP.parseXml(raw);
    const root = parsed.xml || parsed;
    if (config.verifyNotifySig && !VP.verifyPushSig(parsed, config.appKey)) {
      console.warn('[pay] 推送验签失败, 原文:', raw);
      return ok({ ErrCode: 1, ErrMsg: 'sign verify failed' });
    }
    // 仅处理发货通知
    if (root.Event !== 'xpay_goods_deliver_notify') return ok({ ErrCode: 0, ErrMsg: 'success' });

    const outTradeNo = String(root.OutTradeNo || '');
    const wxOrderId = String((root.WeChatPayInfo && root.WeChatPayInfo.MchOrderNo) || '');
    markPaid(outTradeNo, wxOrderId, wxOrderId).then(() => {
      ok({ ErrCode: 0, ErrMsg: 'success' });
    });
  } catch (e) {
    console.error('[pay] 推送处理失败', e);
    ok({ ErrCode: 1, ErrMsg: 'handle failed' });
  }
});

// ---- 简单的联调/测试页(主要用于 MOCK_PAY 模式) ----
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.port, () => {
  console.log(`[pay] 虚拟支付服务已启动: http://localhost:${config.port}`);
  console.log(`[pay] 模式: ${config.mockPay ? 'MOCK(测试, 不真正调微信)' : '真实虚拟支付'}`);
  console.log(`[pay] 主服务: ${config.mainBaseUrl || '(未配置 MAIN_BASE_URL)'}`);
});
