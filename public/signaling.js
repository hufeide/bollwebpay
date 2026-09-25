// signaling.js — 与后端 WebSocket(/ws) 通信的极简封装(含自动重连 + 心跳)
// 事件: open / joined / peers / peer-join / peer-leave / signal / relay / history / close / reconnecting
const Signaling = (() => {
  let ws = null;
  let reconnectTimer = null;
  let closedByUser = false;
  let reconnectDelay = 1000;
  const MAX_DELAY = 15000;
  const handlers = {};
  function on(type, cb) { (handlers[type] || (handlers[type] = [])).push(cb); }
  function emit(type, m) { (handlers[type] || []).forEach((cb) => cb(m)); }
  function isOpen() { return !!(ws && ws.readyState === 1); }
  function connect() {
    if (closedByUser) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { reconnectDelay = 1000; emit('open'); };
    ws.onclose = () => { emit('close'); scheduleReconnect(); };
    ws.onerror = () => { /* close 事件会随后触发, 统一在 onclose 处理重连 */ };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      emit(m.type, m);
    };
  }
  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return;
    emit('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 2);
      connect();
    }, reconnectDelay);
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function close() { closedByUser = true; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } if (ws) ws.close(); }
  // 客户端心跳: 每 20s 发应用层 ping, 既保持隧道活跃, 也更快发现死连接(服务端收不到会 terminate, 本端 onclose 触发重连)
  setInterval(() => { if (isOpen()) send({ type: 'ping' }); }, 20000);
  return { connect, on, send, close, isOpen };
})();
