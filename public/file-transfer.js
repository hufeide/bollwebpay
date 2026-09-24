// file-transfer.js — 分块 + 窗口 ACK 流控 + 进度条 + 取消(复用 bollweb 思路, 适配 WebRTC/relay)
// 发送端: 每个(同伴, 文件)一条上传记录; 接收端: 每个(发送方, 文件)一条接收记录。
// 应用消息优先走 RTC DataChannel, 走不通时由 RTC.send 返回 false 后改走 Signaling.relay。
const FT = (() => {
  const CHUNK = 64 * 1024;          // 64KB(WebRTC DataChannel 安全上限内)
  const WINDOW = 32;                // 在途窗口: 最多 32 块未确认
  const ACK_TIMEOUT = 2500;         // 单块超时未确认则重传
  const uploads = new Map();        // key "peerId:fileId" -> rec
  const incoming = new Map();       // key "fromPeerId:fileId" -> inc

  function sendTo(peerId, msg) {
    const env = E2E.wrap(msg);   // 加密模式自动包成信封 { p }
    if (!RTC.send(peerId, env)) Signaling.send({ type: 'relay', to: peerId, data: env });
  }

  function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const c = 0x8000;
    for (let i = 0; i < bytes.length; i += c) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + c));
    return btoa(binary);
  }
  function b64ToUint8(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    return arr;
  }
  function readChunk(file, off, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.readAsArrayBuffer(file.slice(off, off + CHUNK));
  }

  // ---- 发送端 ----
  function sendFile(file) {
    const peers = RTC.list();
    if (!peers.length) { alert('房间里还没有其他同伴，无法发送文件'); return; }
    // 单文件大小上限(按套餐): 发送前拦截, 避免无效传输与扣次数
    const max = window.roomMaxBytes || 0;
    if (max && file.size > max) {
      const MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
      const txt = max >= GB ? (max / GB) + 'G' : max >= MB ? Math.round(max / MB) + 'M' : Math.round(max / 1024) + 'K';
      alert(`单个文件不能超过 ${txt}（当前套餐上限），请压缩或分包后再传。`);
      return;
    }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const total = Math.ceil(file.size / CHUNK);
    // 历史: 加密时只存密文 pf(服务器无法读取文件名/大小), 否则存明文
    if (E2E.cryptoMode === 'enc') Signaling.send({ type: 'store-file', pf: E2E.seal({ name: myName, fname: file.name, size: file.size }) });
    else Signaling.send({ type: 'store-file', name: myName, fname: file.name, size: file.size, ts: Date.now() });
    for (const pid of peers) {
      const rec = {
        peerId: pid, id, file, name: file.name, size: file.size, total, chunkSize: CHUNK,
        sent: 0, acked: 0, offset: 0, index: 0, done: false, inflight: new Map(), lastAckTs: Date.now(), cancelled: false,
      };
      uploads.set(pid + ':' + id, rec);
      makeTransfer(rec, file.name, '发送');
      sendTo(pid, { k: 'file-start', id, name: file.name, size: file.size, total, chunkSize: CHUNK });
      pump(pid, rec);
    }
  }

  function pump(pid, rec) {
    if (!rec || rec.done || rec.cancelled) return;
    while (rec.inflight.size < WINDOW && rec.offset < rec.size) {
      const idx = rec.index, off = rec.offset;
      rec.inflight.set(idx, Date.now());
      rec.sent++; rec.offset += rec.chunkSize; rec.index++;
      readChunk(rec.file, off, (buf) => {
        sendTo(pid, { k: 'file-chunk', id: rec.id, index: idx, data: abToB64(buf) });
        updateTransfer(rec, rec.sent, rec.total, '发送中');
      });
    }
    if (rec.offset >= rec.size && rec.inflight.size === 0 && !rec.done) {
      rec.done = true;
      sendTo(pid, { k: 'file-end', id: rec.id, name: rec.file.name });
      updateTransfer(rec, rec.total, rec.total, '发送完成');
      appendFileCard(rec.file.name, URL.createObjectURL(rec.file), rec.file.size, true, rec.file);
    }
  }

  // 发送端看门狗: 在途块超时未确认 -> 重传
  setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of uploads) {
      if (rec.done || rec.cancelled || rec.inflight.size === 0) continue;
      if (now - rec.lastAckTs > ACK_TIMEOUT) {
        for (const [idx, ts] of rec.inflight) {
          if (now - ts > ACK_TIMEOUT) {
            rec.inflight.set(idx, now);
            const off = idx * rec.chunkSize;
            readChunk(rec.file, off, (buf) => sendTo(rec.peerId, { k: 'file-chunk', id: rec.id, index: idx, data: abToB64(buf) }));
          }
        }
      }
    }
  }, 500);

  // ---- 接收端 ----
  function deliver(from, id) {
    const f = incoming.get(from + ':' + id);
    if (!f || f.delivering) return;
    f.delivering = true;
    const parts = [];
    let ok = true;
    for (let i = 0; i < f.total; i++) {
      const b64 = f.chunks[i];
      if (!b64) { ok = false; break; }
      parts.push(b64ToUint8(b64));
    }
    if (!ok) { updateTransfer(f, f.received, f.total, '失败'); addSystem(`⚠️ 文件 ${f.name} 接收不完整，无法拼装`); incoming.delete(from + ':' + id); return; }
    const blob = new Blob(parts);
    const url = URL.createObjectURL(blob);
    appendFileCard(f.name, url, f.size, false, blob);
    updateTransfer(f, f.total, f.total, '接收完成');
    incoming.delete(from + ':' + id);
  }
  function requestMissing(from, id) {
    const f = incoming.get(from + ':' + id);
    const missing = [];
    for (let i = 0; i < f.total; i++) if (f.chunks[i] === undefined) missing.push(i);
    if (!missing.length) { deliver(from, id); return; }
    sendTo(from, { k: 'file-request', id, missing });
  }

  // ---- 统一处理来自身份为 from 的文件类应用消息 ----
  function handle(from, msg) {
    // 端到端加密: 信封 { p } 先解密; 失败直接丢弃
    if (E2E.cryptoMode === 'enc' && msg.p) {
      const inner = E2E.open(msg.p);
      if (!inner) return;
      msg = inner;
    }
    if (msg.k === 'file-start') {
      const inc = {
        from, peerId: from, id: msg.id, name: msg.name, size: msg.size, total: msg.total,
        chunkSize: msg.chunkSize || CHUNK, chunks: {}, received: 0, pendingEnd: false, delivering: false, cancelled: false,
      };
      incoming.set(from + ':' + msg.id, inc);
      makeTransfer(inc, msg.name, '接收');
    } else if (msg.k === 'file-chunk') {
      const f = incoming.get(from + ':' + msg.id);
      if (!f) return;
      if (f.chunks[msg.index] === undefined) {
        f.chunks[msg.index] = msg.data; f.received++;
        updateTransfer(f, f.received, f.total, '接收中');
        sendTo(from, { k: 'file-ack', id: msg.id, index: msg.index });
        if (f.pendingEnd && f.received >= f.total) deliver(from, msg.id);
      }
    } else if (msg.k === 'file-end') {
      const f = incoming.get(from + ':' + msg.id);
      if (!f) return;
      if (f.received >= f.total) deliver(from, msg.id);
      else { f.pendingEnd = true; requestMissing(from, msg.id); }
    } else if (msg.k === 'file-ack') {
      const rec = uploads.get(from + ':' + msg.id);
      if (rec && !rec.done && rec.inflight.delete(msg.index)) { rec.acked++; rec.lastAckTs = Date.now(); pump(rec.peerId, rec); }
    } else if (msg.k === 'file-request') {
      const rec = uploads.get(from + ':' + msg.id);
      if (rec) for (const idx of (msg.missing || [])) {
        const off = idx * rec.chunkSize;
        readChunk(rec.file, off, (buf) => sendTo(from, { k: 'file-chunk', id: rec.id, index: idx, data: abToB64(buf) }));
      }
    } else if (msg.k === 'file-cancel') {
      const rec = uploads.get(from + ':' + msg.id);
      if (rec && !rec.cancelled) { rec.cancelled = true; rec.done = true; rec.inflight.clear(); updateTransfer(rec, rec.sent, rec.total, '对端已取消'); }
      const inc = incoming.get(from + ':' + msg.id);
      if (inc && !inc.cancelled) { inc.cancelled = true; updateTransfer(inc, inc.received, inc.total, '对端已取消'); incoming.delete(from + ':' + msg.id); }
    }
  }

  // 取消: 本端停, 并通知对端
  function cancelTransfer(rec) {
    if (!rec || rec.cancelled) return;
    rec.cancelled = true;
    sendTo(rec.peerId, { k: 'file-cancel', id: rec.id });
    if (rec.kind === '发送') { rec.done = true; rec.inflight.clear(); }
    else { incoming.delete(rec.from + ':' + rec.id); }
    updateTransfer(rec, rec.kind === '发送' ? rec.sent : rec.received, rec.total || 1, '已取消');
  }

  return { sendFile, handle, cancelTransfer };
})();
