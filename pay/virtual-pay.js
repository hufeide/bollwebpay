// virtual-pay.js — 微信小程序「虚拟支付」(个人主体) 服务端工具
// 资料: https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person
//
// 与标准微信支付不同, 个人主体小程序售卖虚拟商品(如本项目的「对话次数」)必须用虚拟支付:
//   - 前端 wx.requestVirtualPayment
//   - 服务端下单生成 signData + paySig + signature
//   - 支付成功后微信「发货推送」(/pay/notify) 通知发货, 也可 query_order 兜底查单
import crypto from 'crypto';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const API = 'https://api.weixin.qq.com';

export function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf-8').digest('hex');
}

// 支付签名 paySig: HMAC_SHA256(AppKey, "requestVirtualPayment&" + signData 字符串)
export function calcPaySig(signDataStr, appKey) {
  return hmacSha256(appKey, 'requestVirtualPayment&' + signDataStr);
}

// 用户态签名 signature: HMAC_SHA256(sessionKey, signData 字符串)
export function calcUserSig(signDataStr, sessionKey) {
  return hmacSha256(sessionKey, signDataStr);
}

// code 换 openid + session_key(用于用户态签名)
export async function code2Session(code, appid, appSecret) {
  const url = `${API}/sns/jscode2session?appid=${appid}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
  const resp = await fetch(url);
  return resp.json();
}

// 发货推送验签: 把所有参数(含嵌套)扁平化为 k=v, 按 key 排序后用 AppKey 做 HMAC-SHA256。
// 注: 虚拟支付推送签名的具体字段集合请以官方文档为准; 核对一致后再开 VERIFY_NOTIFY_SIG。
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, prefix + k + '.'));
    else out[prefix + k] = String(v);
  }
  return out;
}
export function verifyPushSig(parsedXml, appKey) {
  const root = parsedXml.xml || parsedXml;
  const sign = root.Sign || root.sign;
  if (!sign) return false;
  const flat = flatten(root);
  const keys = Object.keys(flat).filter((k) => k !== 'Sign' && k !== 'sign').sort();
  const str = keys.map((k) => `${k}=${flat[k]}`).join('&');
  const calc = hmacSha256(appKey, str);
  return calc.toLowerCase() === String(sign).toLowerCase();
}

export function parseXml(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  return parser.parse(xml);
}
export function buildXml(obj) {
  const builder = new XMLBuilder({ format: false, ignoreAttributes: false });
  return builder.build({ xml: obj });
}

// 兜底查单: 服务端主动调微信 query_order; uri 固定 /xpay/query_order
export async function queryOrder(openid, orderId, appKey) {
  const body = JSON.stringify({ openid, env: 0, order_id: orderId });
  const paySig = hmacSha256(appKey, '/xpay/query_order&' + body);
  const resp = await fetch(`${API}/xpay/query_order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid, env: 0, order_id: orderId, pay_sig: paySig }),
  });
  return resp.json();
}
