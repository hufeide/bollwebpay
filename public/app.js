// app.js — bollwebnew 前端主逻辑: 房间/同伴、聊天、历史、文件 UI、多选下载
const $ = (id) => document.getElementById(id);
let myName = '';
let myId = '';
let room = '';
const roomPeers = new Map();        // peerId -> name
const peerState = new Map();        // peerId -> connected(bool)
const fileStore = new Map();        // cardId -> { id, name, blob, url, checked, cb }
let fileSeq = 0;
const msgBox = $('messages');

function rid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---------- 收到同伴的应用消息(无论走 DataChannel 还是 relay) ----------
async function onApp(from, msg) {
  // 端到端加密: 信封 { p } 先解密; 密钥不符/被篡改则丢弃
  if (E2E.cryptoMode === 'enc' && msg.p) {
    const inner = await E2E.open(msg.p);
    if (!inner) { addSystem('⚠️ 收到无法解密的消息（密钥不符或被篡改）'); return; }
    msg = inner;
  }
  if (!msg || !msg.k) return;
  if (msg.k === 'chat') addMsg(msg.name, msg.text, msg.name === myName);
  else FT.handle(from, msg);
}
function onPeerState(peerId, connected) {
  peerState.set(peerId, connected);
  renderPeers();
}

// ---------- 进入房间 ----------
function enter() {
  myName = $('name').value.trim();
  room = $('room').value.trim();
  const key = $('key').value.trim();
  if (!myName || !room) { $('loginErr').textContent = '请填写昵称和房间码'; return; }
  // 端到端加密: 有密钥则初始化, 并把 房间码+密钥+昵称 写回 URL #fragment(仅本机, 不发给服务器)
  if (key) {
    if (!E2E.initCrypto(key)) { $('loginErr').textContent = '密钥无效'; return; }
    location.hash = `r=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&n=${encodeURIComponent(myName)}`;
  }
  myId = rid();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('meName').textContent = myName;

  Signaling.connect();
  Signaling.on('open', () => Signaling.send({ type: 'join', room, name: myName, peerId: myId }));
  Signaling.on('joined', async (m) => {
    RTC.init({ myId, iceServers: m.iceServers, onApp, onPeerState });
    $('status').textContent = '已加入房间 ' + room + (E2E.cryptoMode === 'enc' ? '（端到端加密已开启）' : '') + '，正在建立 P2P 连接…';
    roomPeers.clear(); peerState.clear();
    for (const p of m.peers) roomPeers.set(p.peerId, p.name);
    renderPeers();
    for (const e of (m.history || [])) {
      if (e.type === 'file') {
        if (e.pf) { const o = await E2E.open(e.pf); if (o) addHistoryFile({ type: 'file', name: o.name, fname: o.fname, size: o.size }); }
        else addHistoryFile(e);
      } else {
        if (e.p) { const o = await E2E.open(e.p); if (o) addMsg(o.name, o.text, o.name === myName); }
        else addMsg(e.name, e.text, e.name === myName);
      }
    }
  });
  Signaling.on('peer-join', (m) => {
    roomPeers.set(m.peerId, m.name);
    RTC.createPeer(m.peerId, m.name, true);   // 我们作为已在房间的一方, 主动发起 offer
    renderPeers();
    addSystem(`🔗 ${m.name} 加入了房间`);
  });
  Signaling.on('peer-leave', (m) => {
    RTC.closePeer(m.peerId);
    const nm = roomPeers.get(m.peerId);
    roomPeers.delete(m.peerId); peerState.delete(m.peerId);
    renderPeers();
    if (nm) addSystem(`⚪ ${nm} 离开了房间`);
  });
  Signaling.on('signal', (m) => RTC.handleSignal(m.from, m.data));
  Signaling.on('relay', (m) => onApp(m.from, m.data));
  Signaling.on('close', () => { $('status').textContent = '与信令服务器断开，请刷新页面重连'; });
  // 链接失效(额度用尽): 退回登录页并提示
  Signaling.on('error', (m) => {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('loginErr').textContent = (m && m.message) || '无法进入该房间';
  });
  // 使用中额度耗尽: 禁用输入并提示(链接已失效)
  Signaling.on('room-expired', (m) => {
    addSystem('⛔ 该链接使用次数已用尽，已失效，可重新获取新的链接。');
    $('msgInput').disabled = true;
    $('sendBtn').disabled = true;
    const fi = $('fileInput'); if (fi) fi.disabled = true;
    const comp = document.querySelector('.composer'); if (comp) comp.style.opacity = '0.5';
  });
}
$('enter').onclick = enter;
$('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

function renderPeers() {
  $('peerCount').textContent = roomPeers.size;
  const ul = $('peerList'); ul.innerHTML = '';
  if (roomPeers.size === 0) {
    const li = document.createElement('li'); li.style.color = '#6b7280';
    li.textContent = '（暂无，等待同房间同伴）'; ul.appendChild(li);
    return;
  }
  for (const [pid, name] of roomPeers) {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (peerState.get(pid) ? ' on' : '');
    const txt = document.createElement('span'); txt.textContent = name;
    li.appendChild(dot); li.appendChild(txt);
    ul.appendChild(li);
  }
}

// ---------- 消息渲染 ----------
function addMsg(name, text, mine) {
  const div = document.createElement('div'); div.className = 'msg ' + (mine ? 'me' : 'them');
  const who = document.createElement('div'); who.className = 'who';
  who.textContent = mine ? (myName || '我') : (name || '对方');
  const body = document.createElement('div'); body.textContent = text;
  div.appendChild(who); div.appendChild(body);
  msgBox.appendChild(div); scroll();
}
function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system'; div.textContent = text;
  msgBox.appendChild(div); scroll();
}
// 历史里的文件记录: 只存了文件名/大小(无字节), 仅作信息展示
function addHistoryFile(e) {
  const div = document.createElement('div'); div.className = 'msg ' + (e.name === myName ? 'me' : 'them');
  const who = document.createElement('div'); who.className = 'who'; who.textContent = e.name || '对方';
  const body = document.createElement('div'); body.className = 'file-hist';
  body.textContent = `📎 ${e.fname || '文件'} (${(e.size / 1024).toFixed(1)} KB) · 历史记录(已离线，需重新传输)`;
  div.appendChild(who); div.appendChild(body);
  msgBox.appendChild(div); scroll();
}
function scroll() { msgBox.scrollTop = msgBox.scrollHeight; }

// ---------- 发送聊天 ----------
function sendChat() {
  const text = $('msgInput').value.trim();
  if (!text) return;
  addMsg('我', text, true);
  const msg = { k: 'chat', name: myName, text, ts: Date.now() };
  RTC.broadcast(E2E.wrap(msg));   // 加密模式自动包成信封 { p }
  // 历史: 加密时只存密文 p(服务器无法读取), 否则存明文
  if (E2E.cryptoMode === 'enc') Signaling.send({ type: 'store-chat', p: E2E.seal(msg) });
  else Signaling.send({ type: 'store-chat', name: myName, text, ts: Date.now() });
  $('msgInput').value = '';
}
$('sendBtn').onclick = sendChat;
$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---------- 房间码输入框: 粘贴完整分享链接时自动解析出 房间码/密钥/昵称 ----------
$('room').addEventListener('input', () => {
  const v = $('room').value.trim();
  if (!v.includes('#r=') && !/^https?:\/\//.test(v)) return;
  try {
    const u = new URL(v);
    const hp = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (hp.get('r')) $('room').value = hp.get('r');
    if (hp.get('k')) $('key').value = hp.get('k');
    if (hp.get('n')) $('name').value = hp.get('n');
  } catch {}
});

// ---------- 创建房间 -> 生成 房间码+密钥 -> 二维码(手机扫码加入) ----------
function shareURL(room, key, name) { return E2E.shareURL(room, key, name); }
function createRoom() {
  const room = E2E.genRoom();
  const key = E2E.genKey();
  const name = $('name').value.trim() || '我';
  E2E.initCrypto(key);
  location.hash = `r=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&n=${encodeURIComponent(name)}`;
  $('room').value = room; $('key').value = key; $('name').value = name;
  showQR(room, key, name);
}
function showQR(room, key, name) {
  const url = shareURL(room, key, name);
  $('qrUrl').textContent = url;
  $('qrModal').classList.remove('hidden');
  const c = $('qrCanvas');
  if (window.QRCode && QRCode.toCanvas) {
    QRCode.toCanvas(c, url, { width: 240, margin: 1 }, () => {});
  }
}
$('createRoom').onclick = createRoom;
$('qrClose').onclick = () => $('qrModal').classList.add('hidden');
$('qrCopy').onclick = () => {
  const url = $('qrUrl').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => {
    $('qrCopy').textContent = '已复制'; setTimeout(() => $('qrCopy').textContent = '复制链接', 1500);
  });
};

// ---------- 进入页面: 解析 URL #fragment, 预填并(若是分享链接)自动加入 ----------
(() => {
  const hp = E2E.parseHash();
  if (hp.k) E2E.initCrypto(hp.k);
  if (hp.r) $('room').value = hp.r;
  if (hp.n) $('name').value = hp.n;
  if (hp.k) $('key').value = hp.k;
  // 完整分享链接(房间码+密钥都在)则自动进入; 否则只预填, 等用户点“进入房间”
  if (hp.r && hp.k) {
    const tryEnter = () => { if (Signaling) enter(); };
    tryEnter();
  }
})();

// ---------- 文件选择 ----------
$('fileInput').onchange = () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  FT.sendFile(file);
  $('fileInput').value = '';
};

// ---------- 传输进度条 UI ----------
function makeTransfer(rec, name, kind) {
  rec.name = name; rec.kind = kind; rec.cancelled = false;
  const wrap = document.createElement('div'); wrap.className = 'transfer';
  const top = document.createElement('div'); top.className = 't-top';
  const label = document.createElement('div'); label.className = 't-label';
  const btn = document.createElement('button'); btn.className = 't-cancel'; btn.textContent = '取消';
  top.appendChild(label); top.appendChild(btn);
  const bar = document.createElement('div'); bar.className = 'bar';
  const fill = document.createElement('div'); fill.className = 'fill';
  bar.appendChild(fill); wrap.appendChild(top); wrap.appendChild(bar);
  $('transfers').appendChild(wrap);
  rec.el = wrap; rec.fill = fill; rec.label = label; rec.cancelBtn = btn;
  btn.onclick = () => FT.cancelTransfer(rec);
  updateTransfer(rec, 0, rec.total || 1, '准备');
}
function updateTransfer(rec, cur, total, status) {
  const pct = total ? Math.round((cur / total) * 100) : 0;
  if (rec.fill) rec.fill.style.width = pct + '%';
  if (rec.label) rec.label.textContent = `${rec.kind} ${rec.name} — ${pct}% · ${status} · ${((rec.size || 0) / 1024).toFixed(0)}KB`;
  const terminal = ['发送完成', '接收完成', '失败', '已取消', '对端已取消'].includes(status);
  if (terminal) {
    if (rec.cancelBtn) { rec.cancelBtn.remove(); rec.cancelBtn = null; }
    setTimeout(() => { if (rec.el) rec.el.remove(); }, 4000);
  }
}

// ---------- 文件卡片(图片内联/音视频可播放/其余下载链接) + 多选下载 ----------
function appendFileCard(name, url, size, mine, blob) {
  const id = ++fileSeq;
  const div = document.createElement('div'); div.className = 'msg ' + (mine ? 'me' : 'them');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'f-sel'; cb.dataset.id = id;
  const rec = { id, name, blob: blob || null, url, checked: false, cb };
  cb.onchange = () => { rec.checked = cb.checked; refreshDlBtn(); };
  div.appendChild(cb);
  fileStore.set(id, rec);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const imgExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
  const vidExt = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'avi', 'mkv'];
  const audExt = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];
  const who = document.createElement('div'); who.className = 'who';
  who.textContent = mine ? (myName || '我') : '对方';
  div.appendChild(who);
  if (imgExt.includes(ext)) {
    const img = document.createElement('img'); img.className = 'media'; img.src = url; img.alt = name; div.appendChild(img);
  } else if (vidExt.includes(ext)) {
    const v = document.createElement('video'); v.className = 'media'; v.src = url; v.controls = true; div.appendChild(v);
  } else if (audExt.includes(ext)) {
    const a = document.createElement('audio'); a.className = 'media-audio'; a.src = url; a.controls = true; div.appendChild(a);
  }
  const a = document.createElement('a'); a.className = 'dl'; a.href = url; a.download = name;
  a.textContent = `📥 下载 ${name} (${(size / 1024).toFixed(1)} KB)`;
  div.appendChild(a);
  msgBox.appendChild(div); scroll();
  refreshDlBtn();
}
function refreshDlBtn() {
  const sel = [...fileStore.values()].filter((r) => r.checked).length;
  const btn = $('dlSelected'); if (btn) btn.textContent = `📦 下载选中 (${sel})`;
}
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
async function downloadSelected() {
  const sel = [...fileStore.values()].filter((r) => r.checked && r.blob);
  if (!sel.length) { alert('请先勾选要下载的文件'); return; }
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of sel) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cen.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true); cdv.setUint16(10, 0, true); cdv.setUint16(12, 0, true); cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true); cdv.setUint32(20, data.length, true); cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true); cdv.setUint16(30, 0, true); cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true); cdv.setUint16(36, 0, true); cdv.setUint32(38, 0, true); cdv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  let centralSize = 0; const centralBufs = [];
  for (const c of central) { centralBufs.push(c); centralSize += c.length; }
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(4, 0, true); edv.setUint16(6, 0, true);
  edv.setUint16(8, sel.length, true); edv.setUint16(10, sel.length, true);
  edv.setUint32(12, centralSize, true); edv.setUint32(16, offset, true); edv.setUint16(20, 0, true);
  const zip = new Blob([...parts, ...centralBufs, end], { type: 'application/zip' });
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a'); a.href = url; a.download = 'bollweb-selected.zip'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('dlSelected').onclick = downloadSelected;
$('selAll').onchange = () => {
  const all = $('selAll').checked;
  for (const r of fileStore.values()) { r.checked = all; if (r.cb) r.cb.checked = all; }
  refreshDlBtn();
};
