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

// ---- 套餐定义: 每个套餐对应不同的「次数」与「单文件大小上限」 ----
// 微信虚拟支付的 goodsPrice 为「单价(分)」, 总价 = 单价 × count。各套餐统一单价 10 分/条:
//   1元/10条 = 10分/条, 5元/50条 = 10分/条, 25元/250条 = 10分/条, 50元/500条 = 10分/条
// 注: 真实虚拟支付每笔需对应后台「道具」价格; 这里 MOCK 模式直接按套餐下单,
//   真实上线时请为每个套餐在微信后台创建对应价格的道具, 并使 signData.goodsPrice 与之匹配。
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
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
    if (j && j.orders) for (const o of j.orders) orders.set(o.id, o);
    if (j && j.accounts) for (const [id, a] of Object.entries(j.accounts)) accounts.set(id, a);
  } catch {}
}
function saveOrders() {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify({
      orders: [...orders.values()],
      accounts: Object.fromEntries(accounts),
    }));
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

// 实时统计账户已用次数: 累加该用户所有房间的真实消息/传输数(主服务按条计数)
async function computeUsed(openid) {
  const acc = accounts.get(openid);
  if (!acc || !acc.addresses.length) return { used: 0, freeUsed: 0 };
  let used = 0, freeUsed = 0;
  for (const ad of acc.addresses) {
    let u = 0;
    try {
      const r = await fetch(`${config.mainBaseUrl}/api/room/${ad.room}`);
      const d = await r.json();
      if (d && typeof d.used === 'number') u = d.used;
    } catch {}
    used += u;
    // 仅「免费地址」(未付费, priceFen 为空或 0) 的消耗计入免费额度; 付费地址的消耗不算免费
    if (!(ad.priceFen > 0)) freeUsed += u;
  }
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
      'x-public-base-url': config.mainBaseUrl,
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
    const rem = o.openid ? (await computeRemaining(o.openid)).remaining : o.count;
    const room = await provisionRoom(Math.max(1, rem), o.maxFileBytes || 0);
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
      acc.addresses.push({ room: room.room, url: room.url, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(), label: o.label || '套餐', priceFen: o.priceFen || 0, orderId: outTradeNo });
    }
  } catch (e) {
    console.error('[pay] 分发房间失败', e.message);
    o.status = 'provision_failed';
  }
  saveOrders();
}

// 用账户剩余次数新申请一个地址(地址本身免费, 仅消息/传输消耗次数)
async function newAddress(openid) {
  const acc = ensureAccount(openid);
  if (!acc) throw new Error('账户不存在');
  const { remaining } = await computeRemaining(openid);
  if (remaining <= 0) throw new Error('次数已用完, 请先购买');
  const room = await provisionRoom(remaining, acc.maxFileBytes || 0);
  const label = acc.purchased > 0 ? '剩余次数重申请' : '免费体验';
  acc.addresses.push({ room: room.room, url: room.url, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(), label, priceFen: 0, orderId: '' });
  saveOrders();
  return { url: room.url, room: room.room, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, remaining: acc.purchased - acc.addresses.length };
}

const app = express();

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
    ensureAccount(session.openid);
    res.json({ openid: session.openid });
  } catch (e) {
    res.status(500).json({ error: '登录失败', detail: e.message });
  }
});

// ---- 用剩余次数重新申请地址 ----
app.post('/api/room/new', express.json(), async (req, res) => {
  try {
    const r = await newAddress(req.body.openid);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 账户信息: 免费/已购/已用/剩余次数 + 地址列表(含每个地址的有效性) ----
app.get('/api/user/:openid', async (req, res) => {
  const acc = accounts.get(req.params.openid);
  if (!acc) return res.json({ freeUses: 0, freeRemaining: 0, purchased: 0, used: 0, remaining: 0, maxFileBytes: 0, addresses: [] });
  const info = await computeRemaining(req.params.openid);
  // 免费剩余: 仅扣除「免费地址」自身的已用, 不把付费地址的消耗算到免费额度上
  const freeRemaining = Math.max(0, acc.freeUses - (info.freeUsed || 0));
  // 逐个地址向主服务查询真实额度(额度=套餐内次数, 已用=每条消息/传输消耗, 剩余=套餐内还剩多少条)
  const latestRoom = acc.addresses.length ? acc.addresses[acc.addresses.length - 1].room : '';
  const addresses = [];
  for (const ad of acc.addresses) {
    let st = { used: 0, limit: ad.limit || 0, remaining: ad.limit || 0, disabled: false };
    try {
      const r = await fetch(`${config.mainBaseUrl}/api/room/${ad.room}`);
      const d = await r.json();
      if (d && !d.error) {
        st = { used: d.used || 0, limit: d.limit || 0, remaining: d.remaining || 0, disabled: !!d.disabled };
      }
    } catch {}
    addresses.push({
      ...ad,
      roomUsed: st.used,
      roomLimit: st.limit,
      roomRemaining: st.remaining,
      // 有效性: 仅「最新生成的地址」有效; 旧地址一经生成新链接即被取代, 视为失效
      valid: ad.room === latestRoom,
    });
  }
  res.json({
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
