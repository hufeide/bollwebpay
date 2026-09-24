// crypto-e2e.js — 应用层端到端加密(纯 JS, 局域网 http 下也可用)
//
// 设计要点(对应需求 ①):
//   - 房间码(r, 信令路由用, 会发给服务器)与随机密钥(k, 仅本机)一起放在 URL #fragment。
//   - #fragment 永远不会发给服务器; 服务器只看到房间码(用于把同伴撮合到一起)和密文,
//     无法解密消息内容, 也看不到文件名/聊天文本。
//   - 用 crypto-js 的 AES-256-CBC + HMAC-SHA256(对密文做完整性/密钥校验)。
//   - 每条应用消息被包成信封 { p: "iv:密文:mac" }; 非加密模式(无密钥)下原样发送, 向后兼容。
window.E2E = (() => {
  let cryptoMode = 'plain';   // 'enc' = 端到端加密, 'plain' = 明文
  let aesKey = null;          // CryptoJS WordArray (256-bit)
  let hmacKey = null;         // CryptoJS WordArray

  function genRoom() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
    let s = '';
    for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }
  function genKey() {
    const b = new Uint8Array(32);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin);
  }
  function initCrypto(keyB64) {
    try {
      aesKey = CryptoJS.enc.Base64.parse(keyB64);   // 32 字节 -> 256-bit
      hmacKey = CryptoJS.SHA256(aesKey);
      cryptoMode = 'enc';
      return true;
    } catch (e) {
      cryptoMode = 'plain'; aesKey = null; hmacKey = null;
      console.warn('密钥无效, 回退明文', e);
      return false;
    }
  }

  // seal: 加密对象 -> 文本 "iv:密文:mac"
  function seal(obj) {
    if (cryptoMode !== 'enc' || !aesKey) return null;
    const iv = CryptoJS.lib.WordArray.random(16);
    const pt = CryptoJS.enc.Utf8.parse(JSON.stringify(obj));
    const ct = CryptoJS.AES.encrypt(pt, aesKey, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    const payload = iv.toString(CryptoJS.enc.Base64) + ':' + ct.toString();
    const mac = CryptoJS.HmacSHA256(payload, hmacKey).toString();
    return payload + ':' + mac;
  }
  // open: 解密文本 -> 对象; 密钥不符或篡改返回 null(消息被丢弃)
  function open(str) {
    if (!aesKey || typeof str !== 'string') return null;
    const parts = str.split(':');
    if (parts.length !== 3) return null;
    const payload = parts[0] + ':' + parts[1];
    const mac = CryptoJS.HmacSHA256(payload, hmacKey).toString();
    if (mac !== parts[2]) return null;
    try {
      const bytes = CryptoJS.AES.decrypt(parts[1], aesKey, {
        iv: CryptoJS.enc.Base64.parse(parts[0]), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
      });
      return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    } catch (e) { return null; }
  }

  // wrap: 把应用消息包成信封。加密模式返回 { p }, 否则原样(向后兼容)
  function wrap(msg) {
    if (cryptoMode !== 'enc' || !aesKey) return msg;
    const p = seal(msg);
    return p ? { p } : msg;
  }

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    const out = {};
    if (!h) return out;
    for (const part of h.split('&')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
    }
    return out;
  }
  function shareURL(room, key, name) {
    // 基础地址优先用服务端注入的 window.BASE_URL(部署在 Cloudflare 隧道/反代后,
    // 让二维码输出公网域名而非 localhost); 未配置时回退到当前页面 origin。
    const base = (typeof window !== 'undefined' && window.BASE_URL)
      ? String(window.BASE_URL).replace(/\/+$/, '')
      : location.origin;
    return `${base}/#r=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&n=${encodeURIComponent(name || '')}`;
  }

  return {
    get cryptoMode() { return cryptoMode; },
    genRoom, genKey, initCrypto, seal, open, wrap, parseHash, shareURL,
  };
})();
