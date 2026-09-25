/**
 * server.node.js — bollweb 网页支付的「本地 Node 版」API 服务(不依赖 Cloudflare / wrangler)。
 *
 * 设计原则: 「能抄就抄」。本文件几乎 1:1 复刻 src/worker.js 的 /api 路由逻辑,
 * 但把 Cloudflare Workers 的 Request/Response 换成 Node 原生 http, 把 PAYHTML_KV 换成
 * 本地文件版 KV(src/kv-local.js)。核心支付/记账逻辑仍直接复用:
 *   - src/store.js   (账户 / 套餐 / 房间分发, 逻辑抄自 pay/server.js)
 *   - src/x402.js    (x402 402 响应 + facilitator 校验/结算, 抄自 bolloon)
 * 所以 Worker 版和 Node 版行为完全一致, 只是部署形态不同。
 *
 * 启动:
 *   node src/server.node.js            # 读 .env (若存在) + 进程环境变量
 *   PORT=9000 node src/server.node.js  # 自定义端口
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPaymentRequired, verifyAndSettle, assetFor, toAtomicAmount, caip2For,
} from './x402.js';
import {
  PACKAGES, fmtSize, getPackage, ensureAccount, loadOrder, saveOrder,
  genOrderId, markPaid, newAddress, buildUserInfo, disableRoom, FREE_USES, FREE_MAX_FILE_BYTES,
} from './store.js';
import { createLocalKV } from './kv-local.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// ---------- 配置(与 worker.js cfg 对齐, 但读 process.env) ----------
function loadEnvFile() {
  const p = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 跳过空值 / 明显未填写的占位值(含非 ASCII, 如示例模板里的「你的...」), 避免把无效值塞进 HTTP 头
    if (!val || /[^\x00-\xff]/.test(val)) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function cfg() {
  return {
    network: process.env.NETWORK || 'base-sepolia',
    payTo: process.env.PAY_TO || '',
    facilitatorUrl: process.env.FACILITATOR_URL || 'https://x402.org/facilitator',
    mainBaseUrl: process.env.MAIN_BASE_URL || '',
    mainProvisionToken: process.env.MAIN_PROVISION_TOKEN || '',
    mainPublicBaseUrl: process.env.MAIN_PUBLIC_BASE_URL || process.env.MAIN_BASE_URL || '',
    mock: process.env.MOCK === '1' || process.env.MOCK === 'true',
  };
}

// ---------- HTTP 辅助 ----------
function sendJson(res, obj, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function sendPaymentRequired(res, r) {
  res.writeHead(r.status, {
    'Content-Type': 'application/json',
    'X-Payment-Required': 'true',
    'PAYMENT-REQUIRED': r.headers['PAYMENT-REQUIRED'],
    'Access-Control-Allow-Origin': '*',
  });
  res.end(r.body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

// ---------- 静态资源(前端网页, SPA 回退) ----------
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA: 未知路径回退到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- API 路由(复刻 worker.js 的 /api 分支) ----------
async function handleApi(req, res, url, c, kv) {
  const apiPath = url.pathname.slice('/api/'.length);

  // 前端读取支付配置
  if (apiPath === 'config' && req.method === 'GET') {
    return sendJson(res, {
      network: c.network,
      payTo: c.payTo,
      facilitator: c.facilitatorUrl,
      mock: c.mock,
      freeUses: FREE_USES,
      freeMaxFileBytes: FREE_MAX_FILE_BYTES,
      freeMaxFileText: fmtSize(FREE_MAX_FILE_BYTES),
    });
  }

  // 套餐列表
  if (apiPath === 'packages' && req.method === 'GET') {
    return sendJson(res, {
      packages: PACKAGES.map((p) => ({
        id: p.id, label: p.label, count: p.count,
        priceUsdc: p.priceUsdc, priceText: '$' + p.priceUsdc,
        maxFileBytes: p.maxFileBytes, maxFileText: fmtSize(p.maxFileBytes),
      })),
    });
  }

  // 购买(被 x402 保护的接口)
  if (apiPath === 'buy' && req.method === 'POST') {
    const body = await readJson(req);
    const pkg = getPackage(body.packageId);
    const address = String(body.address || '').toLowerCase();
    if (!pkg) return sendJson(res, { error: '请选择套餐' }, 400);
    if (!address) return sendJson(res, { error: '请先连接钱包' }, 400);

    const isMock = c.mock || body.mock === true;

    // 测试模式: 不走链上, 直接标记已支付并分发房间
    if (isMock) {
      const orderId = genOrderId();
      const order = {
        id: orderId, packageId: pkg.id, address, count: pkg.count,
        priceUsdc: pkg.priceUsdc, maxFileBytes: pkg.maxFileBytes, label: pkg.label,
        status: 'pending', createdAt: Date.now(),
      };
      await saveOrder(kv, order);
      const paid = await markPaid(kv, c, orderId);
      return sendJson(res, {
        orderId, mock: true, status: paid.status,
        url: paid.url, room: paid.room, limit: paid.limit, maxFileBytes: paid.maxFileBytes,
      });
    }

    if (!c.payTo) return sendJson(res, { error: '服务端未配置收款地址 PAY_TO' }, 500);
    if (!c.mainBaseUrl) return sendJson(res, { error: '服务端未配置主服务地址 MAIN_BASE_URL' }, 500);

    // 没有付款头 → 返回 402, 让前端钱包付款后重试
    // 注意: x402 v2 客户端把付款放在 PAYMENT-SIGNATURE 头, v1 才用 X-PAYMENT, 两者都要读
    const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
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
      await saveOrder(kv, order);
      const r = buildPaymentRequired({
        price: pkg.priceUsdc, currency: 'USDC', network: c.network,
        payTo: c.payTo, description: `bollweb ${pkg.label} ×${pkg.count}`, extra: { orderId },
      });
      return sendPaymentRequired(res, r);
    }

    // 有 X-PAYMENT → facilitator 校验+结算
    const payload = (() => {
      try { return JSON.parse(Buffer.from(String(paymentHeader).trim(), 'base64').toString('utf-8')); }
      catch { return null; }
    })();
    const orderId = payload?.accepted?.extra?.orderId || payload?.extra?.orderId || payload?.orderId;
    const order = orderId ? await loadOrder(kv, orderId) : null;
    if (!order) return sendJson(res, { error: '找不到对应订单(可能已过期)' }, 404);

    const outcome = await verifyAndSettle({
      paymentHeader,
      requirements: order.requirements,
      facilitatorUrl: c.facilitatorUrl,
    });
    if (!outcome.ok) return sendJson(res, { error: '支付校验失败: ' + outcome.error, mode: outcome.mode }, 402);

    const paid = await markPaid(kv, c, orderId);
    return sendJson(res, {
      orderId, status: paid.status, url: paid.url, room: paid.room,
      limit: paid.limit, maxFileBytes: paid.maxFileBytes,
      txHash: outcome.txHash, mode: outcome.mode,
    });
  }

  // 免费体验 / 用剩余次数重新申请地址
  if (apiPath === 'room/new' && req.method === 'POST') {
    const body = await readJson(req);
    const address = String(body.address || '').toLowerCase();
    if (!address) return sendJson(res, { error: '请先连接钱包' }, 400);
    if (!c.mainBaseUrl) return sendJson(res, { error: '服务端未配置主服务地址 MAIN_BASE_URL' }, 500);
    try {
      const r = await newAddress(kv, c, address, String(body.deviceId || ''));
      return sendJson(res, r);
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  }

  // 主动禁用某房间(让链接失效)
  const dm = apiPath.match(/^room\/([^/]+)\/disable$/);
  if (dm && req.method === 'POST') {
    const room = decodeURIComponent(dm[1]);
    if (!c.mainBaseUrl) return sendJson(res, { error: '服务端未配置主服务地址 MAIN_BASE_URL' }, 500);
    try {
      const r = await disableRoom(c, room);
      return sendJson(res, r);
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  }

  // 账户信息 / 我的记录
  if (apiPath.startsWith('user/') && req.method === 'GET') {
    const address = decodeURIComponent(apiPath.slice('user/'.length)).toLowerCase();
    if (!address) return sendJson(res, { error: '缺少地址' }, 400);
    const deviceId = url.searchParams.get('device') || '';
    const info = await buildUserInfo(kv, c, address, deviceId);
    return sendJson(res, info);
  }

  return sendJson(res, { error: 'not found' }, 404);
}

// ---------- 启动 ----------
loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const c = cfg();
const kv = createLocalKV(path.join(PROJECT_ROOT, '.data', 'kv.json'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, c, kv);
    } catch (e) {
      console.error('[api] error:', e);
      sendJson(res, { error: 'server error: ' + (e?.message || e) }, 500);
    }
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log('──────── bollweb-pay (Node 本地服务) ────────');
  console.log(`  监听:    http://localhost:${PORT}`);
  console.log(`  网络:    ${c.network}`);
  console.log(`  收款地址: ${c.payTo || '(未配置 PAY_TO)'}`);
  console.log(`  MOCK:    ${c.mock ? '开(跳过链上支付)' : '关(真实 x402 付币)'}`);
  console.log(`  主服务:  ${c.mainBaseUrl || '(未配置 MAIN_BASE_URL)'}`);
  console.log('  数据:    ./.data/kv.json (本地文件 KV)');
  console.log('────────────────────────────────────────────');
});
