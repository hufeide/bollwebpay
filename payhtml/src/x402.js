/**
 * x402 服务端模块 — 抄自 bolloon/src/agents/x402/paid-info-store.ts 的
 * buildPaymentRequired() / checkAndSettlePayment(), 去掉了 DIAP 身份信封,
 * 只保留「生成 402 收款要求」与「facilitator 校验+结算」两段核心。
 *
 * 用在 Cloudflare Worker 里: 让网页付费购买「传输次数」时, 由浏览器钱包(MetaMask)
 * 直接付 USDC 到商户地址, Worker 通过 facilitator 校验这笔链上付款, 再给主服务
 * /api/provision 分发房间链接。
 *
 * 协议: x402 v2 (scheme: exact, EVM / Base / USDC)
 */

// USDC 合约地址(抄 bolloon x402Pay.ts / paid-info-store.ts)
export const USDC_BY_NETWORK = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};
// 原生 ETH 在 x402 里用零地址占位
const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';

// EIP-712 域(name/version) 必须与代币合约完全一致(否则浏览器签名 / facilitator
// 链上验签都会失败)。注意: Base Sepolia 测试网 USDC(0x036C...CF7e) 链上 name() 是
// "USDC"(而非主网 USDC 的 "USD Coin"), version 均为 "2"。name 必须 = 链上 name()。
const ASSET_EIP712_DOMAIN = {
  USDC: { name: 'USDC', version: '2' },
};

export function assetFor(currency, network) {
  if (currency === 'USDC') return USDC_BY_NETWORK[network] || USDC_BY_NETWORK['base-sepolia'];
  return NATIVE_ASSET;
}

// 友好网络名 → CAIP-2(chainID 形式)。x402 v2 的 PaymentRequirements.network
// 必须是 CAIP-2(如 eip155:84532), 不能用 'base-sepolia', 否则客户端选不到 scheme、
// facilitator 也会因 NetworkSchemaV2 校验失败。传入已是 CAIP-2 则原样返回。
const CAIP2_BY_NETWORK = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  mainnet: 'eip155:1',
  sepolia: 'eip155:11155111',
};
export function caip2For(network) {
  return CAIP2_BY_NETWORK[network] || network;
}

// 人类金额 → 原子单位(USDC 6 位 / ETH 18 位), 纯整数运算防浮点误差
export function toAtomicAmount(amount, currency) {
  const decimals = currency === 'USDC' ? 6 : 18;
  const s = String(amount || '0').trim();
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  const int = i.replace(/[^0-9]/g, '') || '0';
  return `${int}${frac}`.replace(/^0+(?=\d)/, '');
}

/**
 * 生成 x402 v2 规范的 402 响应(抄 bolloon buildPaymentRequired)。
 * extra 里塞入 orderId, 把支付凭据绑定到具体订单, 防止同一笔付款被复用到别的资源。
 */
export function buildPaymentRequired({ price, currency = 'USDC', network = 'base-sepolia', payTo, description, extra = {} }) {
  const caip2 = caip2For(network); // v2 必须 CAIP-2
  const bodyObj = {
    x402Version: 2,
    resource: {
      url: description || 'bollweb 传输次数',
      description: description || 'bollweb 传输次数',
      mimeType: 'application/json',
      serviceName: 'bollweb-pay',
    },
    accepts: [{
      scheme: 'exact',
      network: caip2,
      asset: assetFor(currency, network),
      amount: toAtomicAmount(price, currency),
      payTo,
      maxTimeoutSeconds: 60,
      extra: { ...(ASSET_EIP712_DOMAIN[currency] || { name: currency, version: '1' }), ...extra },
    }],
  };
  const body = JSON.stringify(bodyObj);
  // x402 v2: 客户端只从 PAYMENT-REQUIRED 响应头读取支付要求(标准 base64, 非 URL-safe),
  // 不读 body。必须用标准 base64(允许 + / =), 否则被 /^...[+/]*={0,2}$/ 拒绝。
  const paymentRequiredHeader = Buffer.from(body, 'utf8').toString('base64');
  return {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Required': 'true',
      'PAYMENT-REQUIRED': paymentRequiredHeader,
    },
    body,
  };
}

export function decodePaymentHeader(header) {
  try {
    const raw = Buffer.from(String(header || '').trim(), 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function encodePaymentResponse(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

function sha256Hex(s) {
  // Worker 全局有 crypto.subtle; 这里用简单同步方案不可行, 仅 local-dev 用, 提供 fallback
  // 实际 local-dev 我们不走这里, 直接返回随机串即可
  return 'local-' + Math.random().toString(36).slice(2);
}

/**
 * 校验并结算一笔 x402 付款(抄 bolloon checkAndSettlePayment 的 facilitator 分支)。
 * facilitator 模式: POST /verify + /settle, 校验签名并真正上链结算。
 */
export async function verifyAndSettle({ paymentHeader, requirements, facilitatorUrl, allowLocalDev = false }) {
  const req = requirements;
  if (!paymentHeader) return { ok: false, mode: 'none', error: '缺少 X-PAYMENT 头(未付款)' };
  const payload = decodePaymentHeader(paymentHeader);
  if (!payload) return { ok: false, mode: 'none', error: 'X-PAYMENT 不是合法 base64 JSON' };

  // 凭据绑定校验: 防止拿旧回执去换另一条资源
  const boundOrder = payload?.accepted?.extra?.orderId || payload?.extra?.orderId || payload?.orderId;
  if (requirements.extra && requirements.extra.orderId) {
    const expected = requirements.extra.orderId;
    if (!boundOrder) return { ok: false, error: '支付凭据没有绑定 orderId' };
    if (String(boundOrder) !== String(expected)) {
      return { ok: false, error: `支付凭据绑定的订单(${boundOrder})与本次请求(${expected})不一致 — 回执不能跨订单复用` };
    }
  }

  if (facilitatorUrl) {
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: req };
    try {
      const vres = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const v = await vres.json();
      if (!v?.isValid) {
        return { ok: false, mode: 'facilitator', error: `facilitator 校验未通过: ${v?.invalidReason || v?.invalidMessage || 'unknown'}` };
      }
      const sres = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const s = await sres.json();
      if (!s?.success) {
        return { ok: false, mode: 'facilitator', error: `结算失败: ${s?.errorReason || s?.errorMessage || 'unknown'}` };
      }
      const receipt = encodePaymentResponse(s);
      return { ok: true, mode: 'facilitator', receipt, txHash: s.transaction, payer: s.payer || v.payer };
    } catch (e) {
      return { ok: false, mode: 'facilitator', error: `facilitator 不可达: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  // 本机/测试联调: 不真正上链, 只核对声明金额/收款地址(对应 bolloon 的 local-dev)
  if (allowLocalDev) {
    const accepted = payload.accepted || {};
    if (accepted.payTo && String(accepted.payTo).toLowerCase() !== String(req.payTo).toLowerCase()) {
      return { ok: false, mode: 'local-dev', error: '联调: 付款声明收款地址与要求不一致' };
    }
    if (accepted.amount && String(accepted.amount) !== String(req.amount)) {
      return { ok: false, mode: 'local-dev', error: '联调: 付款声明金额与要求不一致' };
    }
    const receiptObj = {
      mode: 'local-dev',
      success: true,
      network: req.network,
      payer: payload.payer || 'local-dev',
      transaction: sha256Hex(JSON.stringify(payload)),
      settledAt: new Date().toISOString(),
      note: '本机联调凭据, 非链上支付',
    };
    return { ok: true, mode: 'local-dev', receipt: encodePaymentResponse(receiptObj), txHash: receiptObj.transaction, payer: receiptObj.payer };
  }

  return { ok: false, mode: 'none', error: '未配置 facilitator 也未开启联调模式 — 无法校验真实付款' };
}
