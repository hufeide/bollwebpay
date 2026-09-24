// signaling.js — 与后端 WebSocket(/ws) 通信的极简封装
// 事件: open / joined / peers / peer-join / peer-leave / signal / relay / history / close
const Signaling = (() => {
  let ws = null;
  const handlers = {};
  function on(type, cb) { (handlers[type] || (handlers[type] = [])).push(cb); }
  function emit(type, m) { (handlers[type] || []).forEach((cb) => cb(m)); }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => emit('open');
    ws.onclose = () => { emit('close'); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      emit(m.type, m);
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  return { connect, on, send };
})();
