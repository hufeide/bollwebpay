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
const orders = new Map(); // outTradeNo -> order

function loadOrders() {
  try {
    const j = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
    if (j && j.orders) for (const o of j.orders) orders.set(o.id, o);
  } catch {}
}
function saveOrders() {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: [...orders.values()] })); } catch {}
}
loadOrders();

function genOrderId() {
  return 'BOLL' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 调用主服务预创建一个带使用上限的房间, 返回 { room, key, url, limit }
async function provisionRoom(count) {
  // 把公网地址经 x-public-base-url 传给主服务: 即便 pay 经由 localhost 调用主服务,
  // 主服务也能据此生成公网可达的房间链接(尤其 cloudflared 临时隧道每次地址都不同)。
  const resp = await fetch(`${config.mainBaseUrl}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.mainProvisionToken}`,
      'x-public-base-url': config.mainBaseUrl,
    },
    body: JSON.stringify({ count, note: 'paid' }),
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
    const room = await provisionRoom(o.count);
    o.room = room.room;
    o.url = room.url;
    o.limit = room.limit;
  } catch (e) {
    console.error('[pay] 分发房间失败', e.message);
    o.status = 'provision_failed';
  }
  saveOrders();
}

const app = express();

// ---- 下单(生成虚拟支付 payData) ----
app.post('/api/order', express.json(), async (req, res) => {
  try {
    const count = Math.max(1, Math.min(100000, parseInt(req.body.count, 10) || 1));
    const outTradeNo = genOrderId();
    const order = {
      id: outTradeNo, count, status: 'pending',
      outTradeNo, description: `bollweb 使用次数 ×${count}`,
      createdAt: Date.now(),
    };
    orders.set(outTradeNo, order);
    saveOrders();

    // 测试模式: 直接标记已支付并分发
    if (config.mockPay) {
      await markPaid(outTradeNo, 'MOCK' + outTradeNo, 'MOCK' + outTradeNo);
      return res.json({ orderId: outTradeNo, mock: true, status: order.status, url: order.url, room: order.room, limit: order.limit });
    }

    if (!config.appid || !config.appKey || !config.offerId || !config.productId) {
      return res.status(500).json({ error: '虚拟支付未配置(缺少 WX_APPID / WX_APP_KEY / WX_OFFER_ID / WX_PRODUCT_ID), 或先用 MOCK_PAY=1 测试' });
    }

    // 小程序 code 换 openid + session_key(用户态签名需要)
    const session = await VP.code2Session(req.body.code, config.appid, config.appSecret);
    if (!session.openid || !session.session_key) return res.status(400).json({ error: '获取 openid/session_key 失败', detail: session });
    order.openid = session.openid;

    // signData 必须是「这个字符串原样」参与两处签名, 字段顺序固定
    const signData = {
      offerId: config.offerId,
      buyQuantity: count,
      env: 0,
      currencyType: 'CNY',
      productId: config.productId,
      goodsPrice: config.pricePerUse, // 单价(分), 需与后台道具价格一致; 总价 = 单价 × buyQuantity
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

  // 兜底: 仍 pending 且已知 openid, 主动查单补发
  if (o.status === 'pending' && o.openid && config.appKey) {
    try {
      const r = await VP.queryOrder(o.openid, o.outTradeNo, config.appKey);
      const txt = JSON.stringify(r);
      // 命中已支付状态则补发(不同终端字段略有差异, 这里做宽松判断)
      if (r && (r.errcode === 0) && /PAID|DELIVERED|SETTLED/.test(txt)) {
        await markPaid(o.outTradeNo, r.order_id || o.outTradeNo, r.wx_order_id || r.order_id);
      }
    } catch (e) { console.warn('[pay] 兜底查单失败', e.message); }
  }

  res.json({
    id: o.id, status: o.status, count: o.count,
    room: o.room || '', url: o.url || '', limit: o.limit || 0,
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
