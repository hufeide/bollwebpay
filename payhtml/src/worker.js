/**
 * worker.js — bollweb 网页支付(Cloudflare Worker)
 *
 * 把小程序里的「微信虚拟支付」整套替换成 bolloon 的去中心化 x402 支付:
 *   - 用户在前端用 MetaMask 付 USDC( Base / Base-Sepolia )
 *   - 本 Worker 收到带 X-PAYMENT 的请求后, 用 facilitator 校验+结算这笔链上付款
 *   - 校验通过即调主服务 /api/provision 开一个带次数上限的加密房间, 把分享链接返回前端
 *
 * 同时托管前端静态资源(public/), 一个 wrangler deploy 搞定前后端。
 */

import { buildPaymentRequired, verifyAndSettle, assetFor, toAtomicAmount, caip2For, decodePaymentHeader } from './x402.js';
import {
  PACKAGES, fmtSize, getPackage, ensureAccount, loadOrder, saveOrder,
  genOrderId, markPaid, newAddress, buildUserInfo, FREE_USES,
} from './store.js';

function cfg(env) {
  return {
    network: env.NETWORK || 'base-sepolia',
    payTo: env.PAY_TO || '',
    facilitatorUrl: env.FACILITATOR_URL || 'https://x402.org/facilitator',
    mainBaseUrl: env.MAIN_BASE_URL || '',
    mainProvisionToken: env.MAIN_PROVISION_TOKEN || '',
    mainPublicBaseUrl: env.MAIN_PUBLIC_BASE_URL || env.MAIN_BASE_URL || '',
    mock: env.MOCK === '1' || env.MOCK === 'true',
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...extraHeaders },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
  });
}

function readBody(req) {
  return req.json().catch(() => ({}));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = cfg(env);

    if (request.method === 'OPTIONS') return corsPreflight();

    // ---------- API ----------
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/\/api\//, '');

      // 前端读取支付配置(网络 / 商户地址 / 是否测试模式)
      if (path === 'config' && request.method === 'GET') {
        return json({
          network: c.network,
          payTo: c.payTo,
          facilitator: c.facilitatorUrl,
          mock: c.mock,
          freeUses: FREE_USES,
        });
      }

      // 套餐列表
      if (path === 'packages' && request.method === 'GET') {
        return json({
          packages: PACKAGES.map((p) => ({
            id: p.id, label: p.label, count: p.count,
            priceUsdc: p.priceUsdc, priceText: '$' + p.priceUsdc,
            maxFileBytes: p.maxFileBytes, maxFileText: fmtSize(p.maxFileBytes),
          })),
        });
      }

      // 购买(被 x402 保护的接口)
      if (path === 'buy' && request.method === 'POST') {
        const body = await readBody(request);
        const pkg = getPackage(body.packageId);
        const address = String(body.address || '').toLowerCase();
        if (!pkg) return json({ error: '请选择套餐' }, 400);
        if (!address) return json({ error: '请先连接钱包' }, 400);

        const isMock = c.mock || body.mock === true;

        // 测试模式: 不走链上, 直接标记已支付并分发房间
        if (isMock) {
          const orderId = genOrderId();
          const order = {
            id: orderId, packageId: pkg.id, address, count: pkg.count,
            priceUsdc: pkg.priceUsdc, maxFileBytes: pkg.maxFileBytes, label: pkg.label,
            status: 'pending', createdAt: Date.now(),
          };
          await saveOrder(env.PAYHTML_KV, order);
          const paid = await markPaid(env.PAYHTML_KV, c, orderId);
          return json({
            orderId, mock: true, status: paid.status,
            url: paid.url, room: paid.room, limit: paid.limit, maxFileBytes: paid.maxFileBytes,
          });
        }

        if (!c.payTo) return json({ error: '服务端未配置收款地址 PAY_TO' }, 500);
        if (!c.mainBaseUrl) return json({ error: '服务端未配置主服务地址 MAIN_BASE_URL' }, 500);

        // 没有付款头 → 返回 402, 让前端钱包付款后重试
        // x402 v2 用 PAYMENT-SIGNATURE 头, v1 用 X-PAYMENT, 两者都读
        const paymentHeader = request.headers.get('x-payment') || request.headers.get('payment-signature');
        if (!paymentHeader) {
          const orderId = genOrderId();
          const requirements = {
            scheme: 'exact',
            network: caip2For(c.network),
            asset: assetFor('USDC', c.network),
            amount: toAtomicAmount(pkg.priceUsdc, 'USDC'),
            payTo: c.payTo,
            maxTimeoutSeconds: 60,
            extra: { name: 'USDC', version: '2', orderId },
          };
          const order = {
            id: orderId, packageId: pkg.id, address, count: pkg.count,
            priceUsdc: pkg.priceUsdc, maxFileBytes: pkg.maxFileBytes, label: pkg.label,
            status: 'pending', requirements, createdAt: Date.now(),
          };
          await saveOrder(env.PAYHTML_KV, order);
          const r = buildPaymentRequired({
            price: pkg.priceUsdc, currency: 'USDC', network: c.network,
            payTo: c.payTo, description: `bollweb ${pkg.label} ×${pkg.count}`, extra: { orderId },
          });
          return new Response(r.body, { status: r.status, headers: r.headers });
        }

        // 有 X-PAYMENT → 校验+结算
        const payload = decodePaymentHeader(paymentHeader);
        const orderId = payload?.accepted?.extra?.orderId || payload?.extra?.orderId || payload?.orderId;
        const order = orderId ? await loadOrder(env.PAYHTML_KV, orderId) : null;
        if (!order) return json({ error: '找不到对应订单(可能已过期)' }, 404);

        const outcome = await verifyAndSettle({
          paymentHeader,
          requirements: order.requirements,
          facilitatorUrl: c.facilitatorUrl,
        });
        if (!outcome.ok) return json({ error: '支付校验失败: ' + outcome.error, mode: outcome.mode }, 402);

        const paid = await markPaid(env.PAYHTML_KV, c, orderId);
        return json({
          orderId, status: paid.status, url: paid.url, room: paid.room,
          limit: paid.limit, maxFileBytes: paid.maxFileBytes,
          txHash: outcome.txHash, mode: outcome.mode,
        });
      }

      // 免费体验 / 用剩余次数重新申请地址
      if (path === 'room/new' && request.method === 'POST') {
        const body = await readBody(request);
        const address = String(body.address || '').toLowerCase();
        if (!address) return json({ error: '请先连接钱包' }, 400);
        if (!c.mainBaseUrl) return json({ error: '服务端未配置主服务地址 MAIN_BASE_URL' }, 500);
        try {
          const r = await newAddress(env.PAYHTML_KV, c, address, String(body.deviceId || ''));
          return json(r);
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }

      // 账户信息 / 我的记录
      if (path.startsWith('user/') && request.method === 'GET') {
        const address = decodeURIComponent(path.slice('user/'.length)).toLowerCase();
        if (!address) return json({ error: '缺少地址' }, 400);
        const deviceId = new URL(request.url).searchParams.get('device') || '';
        const info = await buildUserInfo(env.PAYHTML_KV, c, address, deviceId);
        return json(info);
      }

      return json({ error: 'not found' }, 404);
    }

    // ---------- 静态资源(前端网页) ----------
    // 非 /api 请求交给 Workers Static Assets 处理
    return env.ASSETS.fetch(request);
  },
};
