/**
 * server.js — bollwebnew 后端(方案B: WebRTC 信令 + 兜底中转)
 *
 * 职责(尽量轻量):
 *   1) 托管静态网页(public/)
 *   2) WebSocket 信令(/ws): 同房间内的 SDP/ICE 交换, 撮合浏览器之间建立 WebRTC
 *   3) 兜底中转(relay): 当两端 WebRTC 直连打不通时, 应用消息经本服务器转发(保证"一定连得上")
 *   4) 房间聊天/文件历史(只存文本与文件名, 不存文件内容)
 *
 * 真正的聊天与文件数据默认走浏览器之间的 WebRTC DataChannel(P2P), 服务器不碰。
 * 只有 P2P 失败才走 relay, 因此正常情况服务器带宽≈0。
 *
 * 部署: node server.js (可选 PORT / ICE 环境变量)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;

// ICE 服务器(前端建立 RTCPeerConnection 用)。默认公共 STUN; 生产可加 TURN。
const ICE = JSON.parse(
  process.env.ICE ||
  '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"stun:stun1.l.google.com:19302"}]'
);

// 付费模式: 仅允许通过 /api/provision 付费分发的房间, 直接打开首页输入房间码将被拒绝。
const REQUIRE_PAID_ROOM = process.env.REQUIRE_PAID_ROOM === '1' || process.env.REQUIRE_PAID_ROOM === 'true';

// 分享链接的基础地址(可选)。部署在 Cloudflare 隧道/反代后, 设此变量可让二维码
// 输出公网域名而非 localhost(否则手机扫到的还是 localhost 打不开)。
const BASE_URL = process.env.BASE_URL || '';
const BASE_URL_SCRIPT = (
  (BASE_URL ? `<script>window.BASE_URL=${JSON.stringify(BASE_URL)};</script>` : '') +
  (REQUIRE_PAID_ROOM ? `<script>window.PAID_ONLY=1;</script>` : '')
);

// ---- 房间与历史(都在内存, 重启即清空; 历史额外落盘) ----
// rooms: roomId -> Map(peerId -> { ws, name })
const rooms = new Map();
// history: roomId -> [{ type:'chat'|'file', name, text?, fname?, size?, ts }]
const history = new Map();
const HISTORY_FILE = path.join(__dirname, 'history.json');
let historySaveTimer = null;

function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (j && j.rooms) for (const [r, list] of Object.entries(j.rooms)) history.set(r, list);
  } catch {}
}
function saveHistory() {
  const obj = { rooms: Object.fromEntries(history) };
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj)); } catch {}
}
function pushHistory(room, entry) {
  if (!room) return;
  let list = history.get(room);
  if (!list) { list = []; history.set(room, list); }
  list.push(entry);
  if (list.length > 500) list.splice(0, list.length - 500);
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(saveHistory, 800);
}
loadHistory();

// ---- 房间使用额度(付费分发的房间带次数上限; 达到上限则链接失效) ----
// roomLimits: roomId -> { limit, used, disabled, createdAt, note }
const roomLimits = new Map();
const LIMITS_FILE = path.join(__dirname, 'limits.json');
function loadLimits() {
  try {
    const j = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf-8'));
    if (j && j.rooms) for (const [r, v] of Object.entries(j.rooms)) roomLimits.set(r, v);
  } catch {}
}
function saveLimits() {
  const obj = { rooms: Object.fromEntries(roomLimits) };
  try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(obj)); } catch {}
}
loadLimits();

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
function genRoomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  return s;
}
function genKeyB64() {
  return crypto.randomBytes(32).toString('base64'); // 32 字节 -> 256-bit 端到端密钥
}
function fmtSize(bytes) {
  const MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  if (bytes >= GB) return (bytes / GB) + 'G';
  if (bytes >= MB) return Math.round(bytes / MB) + 'M';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'K';
  return bytes + 'B';
}

// 增加房间使用计数(每次对话/传输 = 1 次); 达到上限则标记失效并通知在线同伴
function incrementUsage(room, n = 1) {
  const lim = roomLimits.get(room);
  if (!lim || lim.disabled) return;
  lim.used += n;
  if (lim.used >= lim.limit) {
    lim.disabled = true;
    const rm = rooms.get(room);
    if (rm) for (const [, p] of rm) send(p.ws, { type: 'room-expired', used: lim.used, limit: lim.limit });
  }
  saveLimits();
}

function rid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---- 静态文件托管 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/')) { handleApi(req, res, urlPath); return; }
  let fp = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(fp).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC, safe);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    let out = data;
    const isHtml = path.extname(filePath) === '.html' || fp === '/index.html';
    if (isHtml && BASE_URL_SCRIPT) {
      out = data.toString('utf-8').replace('<!--BASE_URL-->', BASE_URL_SCRIPT);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(out);
  });
});

// ---- 管理 API(预创建付费房间 / 查询房间额度) ----
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const PROVISION_TOKEN = process.env.PROVISION_TOKEN || '';

async function handleApi(req, res, urlPath) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }
  const cors = () => res.setHeader('Access-Control-Allow-Origin', '*');

  // 房间额度查询: GET /api/room/:room
  const m = urlPath.match(/^\/api\/room\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const room = decodeURIComponent(m[1]);
    const lim = roomLimits.get(room);
    if (!lim) return sendJson(res, 404, { error: 'no such room limit' });
    cors();
    return sendJson(res, 200, {
      room, limit: lim.limit, used: lim.used,
      remaining: Math.max(0, lim.limit - lim.used),
      maxFileBytes: lim.maxFileBytes || 0,
      disabled: !!lim.disabled, createdAt: lim.createdAt,
    });
  }

  // 主动禁用房间(需管理员令牌): POST /api/room/:room/disable —— 让链接立即失效
  const md = urlPath.match(/^\/api\/room\/([^/]+)\/disable$/);
  if (md && req.method === 'POST') {
    cors();
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-admin-token'] || '');
    if (!PROVISION_TOKEN || token !== PROVISION_TOKEN) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const room = decodeURIComponent(md[1]);
    const lim = roomLimits.get(room);
    if (!lim) return sendJson(res, 404, { error: 'no such room limit' });
    lim.disabled = true;
    const rm = rooms.get(room);
    if (rm) for (const [, p] of rm) send(p.ws, { type: 'room-expired', used: lim.used, limit: lim.limit });
    saveLimits();
    return sendJson(res, 200, { ok: true, room, disabled: true });
  }

  // 预创建带额度的房间(需管理员令牌): POST /api/provision { count, room?, note? }
  if (urlPath === '/api/provision' && req.method === 'POST') {
    cors();
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-admin-token'] || '');
    if (!PROVISION_TOKEN || token !== PROVISION_TOKEN) {
      return sendJson(res, 401, { error: 'unauthorized', hint: '设置 PROVISION_TOKEN 并在请求头携带 Authorization: Bearer <token>' });
    }
    const body = await readBody(req);
    const count = Math.max(1, Math.min(100000, parseInt(body.count, 10) || 1));
    const maxFileBytes = Number(body.maxFileBytes) || 0; // 单文件大小上限(按套餐), 0 = 不限
    let room = String(body.room || '').toUpperCase();
    while (!room || roomLimits.has(room) || rooms.has(room)) room = genRoomCode();
    const key = genKeyB64(); // 密钥只随链接下发, 服务器不存储
    roomLimits.set(room, { limit: count, used: 0, disabled: false, createdAt: Date.now(), note: body.note || 'paid', maxFileBytes });
    saveLimits();
    // 链接基础地址: 优先用调用方显式传入的公网地址(如 pay 服务填的 MAIN_BASE_URL),
    // 否则从本次请求的 Host / 协议推导(cloudflared 等隧道会把真实公网域名放在 Host 头),
    // 再回退到 BASE_URL 环境变量。保证生成的房间链接一定是公网可达的。
    const pubBase =
      (req.headers['x-public-base-url'] && String(req.headers['x-public-base-url']).trim()) ||
      (() => {
        const host = req.headers.host;
        if (!host) return (BASE_URL || '').replace(/\/+$/, '');
        const proto = (req.headers['x-forwarded-proto'] && String(req.headers['x-forwarded-proto']).split(',')[0].trim()) ||
          (req.socket.encrypted ? 'https' : 'http');
        return `${proto}://${host}`;
      })();
    const base = pubBase.replace(/\/+$/, '');
    const url = `${base}/#r=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&n=${encodeURIComponent('我')}`;
    return sendJson(res, 200, { room, key, url, limit: count, maxFileBytes, base });
  }

  sendJson(res, 404, { error: 'not found' });
}

// ---- WebSocket 信令 / 中转 ----
const wss = new WebSocketServer({ server, path: '/ws' });
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// 心跳: 每 25s 向所有客户端发 ping, 未回 pong 的判定为死连接并 terminate。
// 作用: 1) 防止 Cloudflare / 隧道 / 路由器掐断空闲 WebSocket; 2) 让 peer-leave 及时触发, 在线列表更准确。
const HEARTBEAT_MS = 25000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null; ws.peerId = null; ws.name = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    switch (m.type) {
      case 'join': {
        const room = String(m.room || 'default');
        const lim = roomLimits.get(room);
        // 付费模式: 未付费分发(无额度记录)的房间一律拒绝, 防止直接打开网址白嫖
        if (REQUIRE_PAID_ROOM && !lim) {
          send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: '房间不存在或未开通。请通过对方分享的付费链接进入。' });
          return;
        }
        if (lim && lim.disabled) {
          // 达到使用上限: 该房间(链接)已失效, 拒绝进入
          send(ws, { type: 'error', code: 'ROOM_DISABLED', message: '该链接使用次数已用尽，已失效，请重新获取新的链接。' });
          return;
        }
        const name = String(m.name || '匿名').slice(0, 32);
        const peerId = m.peerId || rid();
        ws.room = room; ws.peerId = peerId; ws.name = name;
        let rm = rooms.get(room);
        if (!rm) { rm = new Map(); rooms.set(room, rm); }
        const existing = [...rm.entries()].map(([id, p]) => ({ peerId: id, name: p.name }));
        rm.set(peerId, { ws, name });
        send(ws, { type: 'joined', peerId, peers: existing, iceServers: ICE, history: history.get(room) || [] });
        // 通知已在房间里的同伴: 有新同伴加入(由他们发起 WebRTC offer, 避免 glare)
        for (const [id, p] of rm) if (id !== peerId) send(p.ws, { type: 'peer-join', peerId, name });
        break;
      }
      case 'signal': {
        const rm = rooms.get(ws.room); if (!rm) return;
        const t = rm.get(m.to); if (t) send(t.ws, { type: 'signal', from: ws.peerId, data: m.data });
        break;
      }
      case 'relay': {
        // 兜底: P2P 打不通时, 应用消息经服务器转发
        const rm = rooms.get(ws.room); if (!rm) return;
        const t = rm.get(m.to); if (t) send(t.ws, { type: 'relay', from: ws.peerId, data: m.data });
        break;
      }
      case 'store-chat': {
        // 加密房间只存密文 p(服务器无法解密); 非加密房间存明文
        if (m.p) pushHistory(ws.room, { type: 'chat', p: String(m.p), ts: m.ts || Date.now() });
        else pushHistory(ws.room, { type: 'chat', name: m.name, text: String(m.text || ''), ts: m.ts || Date.now() });
        incrementUsage(ws.room, 1); // 一次对话 = 一次使用
        break;
      }
      case 'store-file': {
        // 单文件大小上限(按套餐): 超出则拒绝本次传输, 不计次数、不记入历史
        const lim = roomLimits.get(ws.room);
        if (lim && lim.maxFileBytes && m.size && m.size > lim.maxFileBytes) {
          send(ws, { type: 'error', code: 'FILE_TOO_LARGE', message: `单个文件不能超过 ${fmtSize(lim.maxFileBytes)}（当前套餐上限），请压缩或分包后再传。` });
          return;
        }
        if (m.pf) pushHistory(ws.room, { type: 'file', pf: String(m.pf), ts: m.ts || Date.now() });
        else pushHistory(ws.room, { type: 'file', name: m.name, fname: m.fname, size: m.size || 0, ts: m.ts || Date.now() });
        incrementUsage(ws.room, 1); // 一次传输 = 一次使用
        break;
      }
    }
  });
  ws.on('close', () => {
    const rm = rooms.get(ws.room);
    if (rm) {
      rm.delete(ws.peerId);
      for (const [, p] of rm) send(p.ws, { type: 'peer-leave', peerId: ws.peerId });
      if (rm.size === 0) rooms.delete(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[bollwebnew] web + 信令服务已启动: http://localhost:${PORT}`);
  console.log(`[bollwebnew] 浏览器直接打开上面的地址即可, 无需安装任何东西`);
});
