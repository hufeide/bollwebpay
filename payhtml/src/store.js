/**
 * store.js — 账户 / 套餐 / 房间分发(抄 bolloon 的 pay/server.js 逻辑,
 * 但用 Cloudflare KV 持久化, 并以「钱包地址」代替微信 openid 作为用户标识)。
 *
 * 主服务(WebRTC 信令 + /api/provision)仍由 bollwebpay/server.js 提供,
 * 这里只负责: 套餐定义、按地址记账、调用主服务开房间、统计剩余次数。
 */

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// 套餐: 次数 + 单文件上限(抄小程序 PACKAGES, 价格改为 USDC)
export const PACKAGES = [
  { id: 'p1',   label: '体验包', count: 10,  priceUsdc: '0.10',  maxFileBytes: 5 * MB },
  { id: 'p10',  label: '标准包', count: 50,  priceUsdc: '1.00',  maxFileBytes: 20 * MB },
  { id: 'p100', label: '畅享包', count: 250, priceUsdc: '5.00',  maxFileBytes: 500 * MB },
  { id: 'p200', label: '旗舰包', count: 500, priceUsdc: '10.00', maxFileBytes: 1 * GB },
];

export function fmtSize(bytes) {
  if (bytes >= GB) return (bytes / GB) + 'G';
  if (bytes >= MB) return Math.round(bytes / MB) + 'M';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'K';
  return bytes + 'B';
}

export function getPackage(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

// 由价格反查套餐次数(用于老记录未存 count 时, 仍按「单个套餐次数」展示额度而非累加值)
function countByPrice(price) {
  const p = PACKAGES.find((x) => String(x.priceUsdc) === String(price));
  return p ? p.count : null;
}

// 每个地址赠送的免费体验次数(抄小程序 FREE_USES=10)
export const FREE_USES = 10;
// 免费体验房单文件上限(防止免费用户传超大文件占用带宽); 付费房沿用套餐各自上限
export const FREE_MAX_FILE_BYTES = 2 * MB;

function accountKey(address) { return 'account:' + String(address || '').toLowerCase(); }
function orderKey(id) { return 'order:' + id; }

// 设备级免费额度: 用浏览器生成的设备标识(存 localStorage)做 key, 防止用户靠
// 切换钱包地址无限白嫖免费房。每台设备总共只赠送 FREE_USES 次「房间使用额度」。
function deviceKey(id) { return 'device:' + String(id || '').toLowerCase(); }
export async function ensureDevice(kv, id) {
  if (!id) return null;
  let d = await kv.get(deviceKey(id), 'json');
  if (!d) { d = { id: String(id), freeUsed: 0 }; await kv.put(deviceKey(id), JSON.stringify(d)); }
  return d;
}
export async function saveDevice(kv, d) { if (d && d.id) await kv.put(deviceKey(d.id), JSON.stringify(d)); }
async function loadDevice(kv, id) { return id ? ((await kv.get(deviceKey(id), 'json')) || null) : null; }

export async function loadAccount(kv, address) {
  if (!address) return null;
  const a = await kv.get(accountKey(address), 'json');
  return a || null;
}

export async function ensureAccount(kv, address) {
  if (!address) return null;
  let a = await kv.get(accountKey(address), 'json');
  if (!a) {
    a = { address: String(address).toLowerCase(), freeUses: FREE_USES, purchased: 0, maxFileBytes: 0, addresses: [], orders: [] };
    await kv.put(accountKey(address), JSON.stringify(a));
  } else if (typeof a.freeUses !== 'number' || a.freeUses < 0) {
    a.freeUses = FREE_USES;
    await kv.put(accountKey(address), JSON.stringify(a));
  }
  return a;
}

export async function saveAccount(kv, a) {
  await kv.put(accountKey(a.address), JSON.stringify(a));
}

export async function loadOrder(kv, id) {
  return (await kv.get(orderKey(id), 'json')) || null;
}

export async function saveOrder(kv, o) {
  await kv.put(orderKey(o.id), JSON.stringify(o));
}

export function genOrderId() {
  return 'BOLL' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 调主服务预创建带使用上限的房间(抄 pay/server.js provisionRoom)
export async function provisionRoom(cfg, count, maxFileBytes = 0) {
  const resp = await fetch(`${cfg.mainBaseUrl}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.mainProvisionToken}`,
      'x-public-base-url': cfg.mainPublicBaseUrl || cfg.mainBaseUrl,
    },
    body: JSON.stringify({ count, maxFileBytes, note: 'paid' }),
  });
  if (!resp.ok) throw new Error('provision failed: ' + resp.status);
  return resp.json();
}

// 主动禁用某房间(让链接立即失效): 调主服务 /api/room/:room/disable
export async function disableRoom(cfg, room) {
  const resp = await fetch(`${cfg.mainBaseUrl}/api/room/${encodeURIComponent(room)}/disable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.mainProvisionToken}`,
    },
  });
  if (!resp.ok) throw new Error('disable failed: ' + resp.status);
  return resp.json();
}

// 并行查单个房间的已用次数(带 3s 超时容错)
async function fetchRoomUsed(cfg, room) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${cfg.mainBaseUrl}/api/room/${room}`, { signal: ctrl.signal });
    const d = await r.json();
    if (d && !d.error && typeof d.used === 'number') return d.used;
    return 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

export async function computeUsed(kv, cfg, address) {
  const acc = await loadAccount(kv, address);
  if (!acc || !acc.addresses.length) return { used: 0, freeUsed: 0 };
  const usedArr = await Promise.all(acc.addresses.map((ad) => fetchRoomUsed(cfg, ad.room)));
  let used = 0, freeUsed = 0;
  acc.addresses.forEach((ad, i) => {
    const u = usedArr[i] || 0;
    used += u;
    if (!(ad.priceUsdc > 0)) freeUsed += u;
  });
  return { used, freeUsed };
}

export async function computeRemaining(kv, cfg, address) {
  const acc = await ensureAccount(kv, address);
  const { used, freeUsed } = await computeUsed(kv, cfg, address);
  const remaining = Math.max(0, (acc.freeUses + acc.purchased) - used);
  return { freeUses: acc.freeUses, purchased: acc.purchased, used, freeUsed, remaining };
}

// 标记订单已支付并分发房间(幂等)
export async function markPaid(kv, cfg, orderId) {
  const o = await loadOrder(kv, orderId);
  if (!o) return null;
  if (o.status === 'paid') return o;
  o.status = 'paid';
  o.paidAt = Date.now();
  try {
    // 每笔购买按「套餐自身次数」开房(体验包=10), 而不是账户剩余总次数,
    // 否则多次购买会把额度累加进单间房, 记录页显示成 39/29 这种累加值。
    const count = Math.max(1, o.count || 1);
    const room = await provisionRoom(cfg, count, o.maxFileBytes || 0);
    o.room = room.room;
    o.url = room.url;
    o.limit = room.limit;
    o.maxFileBytes = room.maxFileBytes || 0;
    if (o.address) {
      const acc = await ensureAccount(kv, o.address);
      acc.purchased += o.count;
      acc.maxFileBytes = Math.max(acc.maxFileBytes || 0, o.maxFileBytes || 0);
      if (!acc.orders.includes(orderId)) acc.orders.push(orderId);
      acc.addresses.push({
        room: room.room, url: room.url, limit: room.limit, count,
        maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(),
        label: o.label || '套餐', priceUsdc: o.priceUsdc || 0, orderId,
      });
      await saveAccount(kv, acc);
    }
  } catch (e) {
    console.error('[pay] 分发房间失败', e.message);
    o.status = 'provision_failed';
  }
  await saveOrder(kv, o);
  return o;
}

// 用账户剩余次数新申请一个地址(MOCK / 免费体验共用)
// deviceId: 浏览器生成的设备标识, 用于「每台设备」限制免费体验次数。付费(已购)重申请
//   不消耗设备免费额度; 仅当本次用的是「免费」额度时才扣设备预算。
export async function newAddress(kv, cfg, address, deviceId) {
  const acc = await ensureAccount(kv, address);
  if (!acc) throw new Error('账户不存在');
  const info = await computeRemaining(kv, cfg, address);
  const remaining = info.remaining;
  if (remaining <= 0) throw new Error('次数已用完, 请先购买');

  // 账户里属于「免费」额度的部分 → 走设备级限额(防换地址白嫖/无限开房)
  const freeRemaining = Math.max(0, acc.freeUses - (info.freeUsed || 0));
  let limit = remaining;
  let isFree = false;
  if (freeRemaining > 0) {
    if (!deviceId) throw new Error('设备标识缺失, 请刷新页面后重试');
    const dev = await ensureDevice(kv, deviceId);
    const devFreeRemaining = Math.max(0, FREE_USES - (dev.freeUsed || 0));
    if (devFreeRemaining <= 0) throw new Error('本设备免费体验次数已用完, 请购买套餐');
    // 扣减设备免费预算(以「房间使用额度」计, 而非房间个数), 跨地址共享同一份
    limit = Math.min(remaining, devFreeRemaining);
    dev.freeUsed = (dev.freeUsed || 0) + limit;
    await saveDevice(kv, dev);
    isFree = true;
  }

  // 免费体验房单文件上限 2M; 付费重申请沿用账户已购套餐的上限
  const roomMaxFileBytes = isFree ? FREE_MAX_FILE_BYTES : (acc.maxFileBytes || 0);
  const room = await provisionRoom(cfg, limit, roomMaxFileBytes);
  const label = acc.purchased > 0 ? '剩余次数重申请' : '免费体验';
  acc.addresses.push({ room: room.room, url: room.url, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, createdAt: Date.now(), label, priceUsdc: 0, orderId: '' });
  await saveAccount(kv, acc);
  return { url: room.url, room: room.room, limit: room.limit, maxFileBytes: room.maxFileBytes || 0, remaining: acc.purchased - acc.addresses.length };
}

// 账户信息: 免费/已购/已用/剩余 + 每个地址有效性(抄 pay/server.js /api/user)
// deviceId: 透传设备标识, 用于返回「本设备还可免费体验几次」(deviceFreeRemaining)
export async function buildUserInfo(kv, cfg, address, deviceId) {
  const acc = await loadAccount(kv, address);
  if (!acc) return { freeUses: 0, freeRemaining: 0, purchased: 0, used: 0, remaining: 0, maxFileBytes: 0, addresses: [], deviceFreeRemaining: deviceId ? FREE_USES : null };
  const info = await computeRemaining(kv, cfg, address);
  const freeRemaining = Math.max(0, acc.freeUses - (info.freeUsed || 0));
  let deviceFreeRemaining = null;
  if (deviceId) {
    const d = await loadDevice(kv, deviceId);
    deviceFreeRemaining = Math.max(0, FREE_USES - (d?.freeUsed || 0));
  }
  // 展示用的「免费剩余」取设备级与账户级较小值(设备级更严格)
  const shownFreeRemaining = deviceFreeRemaining != null ? Math.min(freeRemaining, deviceFreeRemaining) : freeRemaining;
  const latestRoom = acc.addresses.length ? acc.addresses[acc.addresses.length - 1].room : '';
  const roomStats = await Promise.all(acc.addresses.map(async (ad) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`${cfg.mainBaseUrl}/api/room/${ad.room}`, { signal: ctrl.signal });
      const d = await r.json();
      if (d && !d.error) return { used: d.used || 0, limit: d.limit || 0, remaining: d.remaining || 0, disabled: !!d.disabled };
    } catch {}
    finally { clearTimeout(timer); }
    return { used: 0, limit: ad.limit || 0, remaining: ad.limit || 0, disabled: false };
  }));
  // 用「当前」公网地址重建房间链接: 链接创建时把当时的隧道域名烤进了 url, 而 quick
  // tunnel 每次重启换域名, 旧链接会失效。这里只替换域名部分, 保留房间参数(#r/k/n),
  // 保证记录页显示的有效链接始终指向当前在线的隧道, 可正常打开(房间 ID 仍在同一主服务实例)。
  const base = (cfg.mainPublicBaseUrl || cfg.mainBaseUrl || '').replace(/\/+$/, '');
  const addresses = acc.addresses.map((ad, i) => {
    let url = ad.url || '';
    if (base && url.includes('#')) url = base + '/#' + url.split('#')[1];
    return {
      ...ad,
      url,
      roomUsed: roomStats[i].used,
      roomLimit: roomStats[i].limit,
      roomRemaining: roomStats[i].remaining,
      valid: ad.room === latestRoom,
      disabled: roomStats[i].disabled,
      maxFileText: fmtSize(ad.maxFileBytes || 0),
      priceText: (ad.priceUsdc > 0) ? '$' + Number(ad.priceUsdc).toFixed(2) : '免费',
      createdAtText: new Date(ad.createdAt).toLocaleString('zh-CN'),
    };
  });
  return {
    freeUses: FREE_USES,
    freeRemaining: shownFreeRemaining,
    deviceFreeRemaining,
    purchased: info.purchased,
    used: info.used,
    remaining: info.remaining,
    maxFileBytes: acc.maxFileBytes || 0,
    maxFileText: fmtSize(acc.maxFileBytes || 0),
    addresses,
  };
}
