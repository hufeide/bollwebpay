// config.js — pay 服务配置(全部来自环境变量, 见 README / .env.example)
//
// 注意: 个人主体小程序无法使用标准微信支付 JSAPI, 必须使用「虚拟支付」(wx.requestVirtualPayment)。
// 因此这里配置的是虚拟支付凭证, 而非商户号/APIv3/证书。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PAY_PORT) || 8081,

  // ---- 微信小程序(个人主体) ----
  appid: process.env.WX_APPID || '',
  appSecret: process.env.WX_APP_SECRET || '',   // 用于 code 换 session_key / openid

  // ---- 虚拟支付(微信开放平台 -> 支付与交易 -> 虚拟支付 -> 基本配置) ----
  offerId: process.env.WX_OFFER_ID || '',        // OfferID(虚拟支付商户号)
  appKey: process.env.WX_APP_KEY || '',          // 现网 AppKey(支付密钥, 用于签名/验签)
  productId: process.env.WX_PRODUCT_ID || '',    // 道具 ID(在「道具管理」创建)
  pricePerUse: Number(process.env.PRICE_PER_USE) || 10, // 道具单价(分), 需与后台道具价格一致

  // ---- 主服务 bollweb(由 server.js 提供 /api/provision) ----
  // 内部通信地址: pay 与主服务同机时, 直接走 localhost(最快最稳, 避免「我的记录」被公网隧道抖动拖慢)。
  // 跨机部署请用 MAIN_BASE_URL 指向主服务内网/公网地址。
  mainBaseUrl: (process.env.MAIN_BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  // 主服务「对外公网地址」: 仅用于告诉主服务生成公网可达的房间链接(房间 url / 小程序访问),
  // 与上面的内部通信地址分离, 以免房间 url 变成 localhost 而外部打不开。
  mainPublicBaseUrl: (process.env.MAIN_PUBLIC_BASE_URL || process.env.MAIN_BASE_URL || '').replace(/\/+$/, ''),
  mainProvisionToken: process.env.MAIN_PROVISION_TOKEN || '',

  // ---- 回调 ----
  // 本支付服务对外地址; 微信发货推送 URL 需在小程序后台配置为 {此地址}/pay/notify
  notifyBaseUrl: (process.env.PAY_NOTIFY_BASE_URL || '').replace(/\/+$/, ''),

  // 推送验签开关: 默认关闭。代码已实现标准 HMAC-SHA256 验签, 但虚拟支付推送签名公式需
  // 你用一笔测试支付与官方文档核对一致后再置 1, 否则可能误拒真实推送。
  verifyNotifySig: process.env.VERIFY_NOTIFY_SIG === '1',

  // ---- 测试模式 ----
  // 设为 1 时, 下单即视为已支付并立即分发房间, 无需任何微信资质, 用于联调。
  mockPay: process.env.MOCK_PAY === '1' || process.env.MOCK_PAY === 'true',
};
