// webrtc.js — 浏览器之间的 WebRTC Mesh: 每个同伴一条 RTCPeerConnection + DataChannel
// 发送应用消息优先走 DataChannel; 打不通时由调用方回退到 Signaling.relay。
const RTC = (() => {
  const peers = new Map();            // peerId -> { pc, dc, name, connected, pending[], making }
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let myId = '';
  let onApp = () => {};               // (fromPeerId, msg) => void
  let onPeerState = () => {};         // (peerId, connected) => void

  function init(opts) {
    myId = opts.myId;
    iceServers = opts.iceServers && opts.iceServers.length ? opts.iceServers : iceServers;
    onApp = opts.onApp || onApp;
    onPeerState = opts.onPeerState || onPeerState;
  }

  function createPeer(peerId, name, initiator) {
    if (peers.has(peerId)) return peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers });
    const p = { pc, dc: null, name: name || '?', connected: false, pending: [], making: false };
    peers.set(peerId, p);

    pc.onicecandidate = (e) => { if (e.candidate) Signaling.send({ type: 'signal', to: peerId, data: { ice: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') { p.connected = false; onPeerState(peerId, false); }
    };

    if (initiator) {
      p.dc = pc.createDataChannel('data');
      setupDc(p, peerId);
      pc.onnegotiationneeded = async () => {
        if (p.making) return;
        p.making = true;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          Signaling.send({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
        } catch (e) { /* ignore */ } finally { p.making = false; }
      };
    } else {
      pc.ondatachannel = (e) => { p.dc = e.channel; setupDc(p, peerId); };
    }
    return p;
  }

  function setupDc(p, peerId) {
    const dc = p.dc;
    dc.onopen = () => { p.connected = true; onPeerState(peerId, true); };
    dc.onclose = () => { p.connected = false; onPeerState(peerId, false); };
    dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onApp(peerId, m); };
  }

  // 收到对端发来的 SDP / ICE(由信令服务器转发)
  function handleSignal(from, data) {
    let p = peers.get(from);
    if (!p) p = createPeer(from, '?', false);   // 我们是响应方
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        (async () => {
          try {
            await p.pc.setRemoteDescription(data.sdp);
            const ans = await p.pc.createAnswer();
            await p.pc.setLocalDescription(ans);
            Signaling.send({ type: 'signal', to: from, data: { sdp: p.pc.localDescription } });
            flushCandidates(p);
          } catch (e) { /* ignore */ }
        })();
      } else if (data.sdp.type === 'answer') {
        p.pc.setRemoteDescription(data.sdp).then(() => flushCandidates(p)).catch(() => {});
      }
    }
    if (data.ice) {
      if (p.pc.remoteDescription && p.pc.remoteDescription.type) p.pc.addIceCandidate(data.ice).catch(() => {});
      else p.pending.push(data.ice);
    }
  }
  function flushCandidates(p) { for (const c of p.pending) p.pc.addIceCandidate(c).catch(() => {}); p.pending = []; }

  // 发送: 优先 DataChannel, 成功返回 true; 失败(未开/缓冲溢出抛异常)返回 false(调用方回退 relay)
  function send(peerId, msg) {
    const p = peers.get(peerId);
    if (p && p.dc && p.dc.readyState === 'open') {
      try { p.dc.send(JSON.stringify(msg)); return true; }
      catch (e) { return false; }   // DataChannel 缓冲满/发送失败 -> 回退 relay, 避免块丢失卡死
    }
    return false;
  }
  // 广播给所有同伴; 每个同伴独立选择 P2P 或 relay
  function broadcast(msg) {
    for (const [id, p] of peers) {
      if (p.dc && p.dc.readyState === 'open') {
        try { p.dc.send(JSON.stringify(msg)); continue; } catch (e) { /* 回退 relay */ }
      }
      Signaling.send({ type: 'relay', to: id, data: msg });
    }
  }
  function list() { return [...peers.keys()]; }
  function isConnected(peerId) { const p = peers.get(peerId); return !!(p && p.dc && p.dc.readyState === 'open'); }
  function closePeer(peerId) { const p = peers.get(peerId); if (p) { try { p.pc.close(); } catch {} peers.delete(peerId); } }

  return { init, createPeer, handleSignal, send, broadcast, list, isConnected, closePeer };
})();
