// app.js — bollweb 网页支付前端(替换小程序微信支付为去中心化 x402)
//
// 钱包身份 = 浏览器地址(MetaMask)。支付用 @x402/fetch + @x402/evm + viem,
// 与 bolloon 同一套 x402 客户端(仅把服务端私钥换成浏览器钱包)。

const API = ''; // 同域, 用相对路径

const state = {
  config: null,
  address: localStorage.getItem('bw_address') || '',
  packages: [],
  selectedId: '',
};

// 设备标识: 持久化在 localStorage, 用于「每台设备」限制免费体验次数(防换地址白嫖)
function getDeviceId() {
  let id = localStorage.getItem('bw_device');
  if (!id) { id = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('bw_device', id); }
  return id;
}

// ---------- 工具 ----------
function $(id) { return document.getElementById(id); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function showPage(p) {
  ['page-home', 'page-buy', 'page-result', 'page-records'].forEach((x) => hide(x));
  show('page-' + p);
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function fmtSize(bytes) {
  const MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  if (bytes >= GB) return (bytes / GB) + 'G';
  if (bytes >= MB) return Math.round(bytes / MB) + 'M';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'K';
  return bytes + 'B';
}
async function api(path, opts = {}) {
  const res = await fetch(API + '/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

// ---------- 初始化 ----------
async function init() {
  try {
    state.config = await api('/config');
    $('freeUses').textContent = state.config.freeUses;
    $('freeUses2').textContent = state.config.freeUses;
    if ($('freeMax') && state.config.freeMaxFileText) $('freeMax').textContent = state.config.freeMaxFileText;
    if ($('freeMaxHome') && state.config.freeMaxFileText) $('freeMaxHome').textContent = state.config.freeMaxFileText;
  } catch (e) { console.warn('config 加载失败', e); }

  try {
    const p = await api('/packages');
    state.packages = p.packages || [];
    renderPackages();
  } catch (e) { toast('套餐加载失败'); }

  if (state.address) { renderWalletConnected(); refreshFree(); }
  wireEvents();
}

// 刷新「本设备还可免费体验几次」, 同步首页按钮与购买页文案
async function refreshFree() {
  if (!state.address) return;
  try {
    const info = await api('/user/' + state.address + '?device=' + getDeviceId());
    const rem = (info.deviceFreeRemaining != null) ? info.deviceFreeRemaining : (info.freeRemaining ?? 0);
    $('freeUses').textContent = rem;
    $('freeUses2').textContent = rem;
  } catch {}
}

function renderPackages() {
  const list = $('pkgList');
  list.innerHTML = '';
  if (!state.packages.length) return;
  if (!state.selectedId) state.selectedId = state.packages[0].id;
  state.packages.forEach((pkg) => {
    const el = document.createElement('div');
    el.className = 'pkg' + (pkg.id === state.selectedId ? ' pkg-on' : '');
    el.innerHTML = `
      <div class="pkg-main">
        <div class="pkg-name">${pkg.label}</div>
        <div class="pkg-count">${pkg.count} 条</div>
      </div>
      <div class="pkg-side">
        <div class="pkg-price">$${pkg.priceUsdc}</div>
        <div class="pkg-limit">单文件 ≤ ${pkg.maxFileText}</div>
      </div>`;
    el.onclick = () => {
      state.selectedId = pkg.id;
      renderPackages();
      syncSelPrice();
    };
    list.appendChild(el);
  });
  syncSelPrice();
}
function syncSelPrice() {
  const pkg = state.packages.find((p) => p.id === state.selectedId);
  $('selPrice').textContent = pkg ? '$' + pkg.priceUsdc : '';
}
function wireEvents() {
  $('walletBtn').onclick = connectWallet;
  $('btnExperience').onclick = experience;
  $('btnBuy').onclick = () => showPage('buy');
  $('btnRecords').onclick = () => { if (!ensureWallet()) return; loadRecords(); showPage('records'); };
  $('btnPay').onclick = pay;
  $('btnCopy').onclick = copyUrl;
  $('btnHome2').onclick = () => showPage('home');
  $('btnHome3').onclick = () => showPage('home');
  $('btnBuy2').onclick = () => showPage('buy');
  $('btnHomeBuy').onclick = () => showPage('home');
  $('btnUpdateAll').onclick = async () => {
    toast('正在更新全部地址…');
    await loadRecords();
    toast('已更新为当前隧道地址');
  };
}

// ---------- 钱包 ----------
function ensureWallet() {
  if (!state.address) { toast('请先连接钱包'); return false; }
  return true;
}
function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
function renderWalletConnected() {
  const b = $('walletBtn');
  b.textContent = shortAddr(state.address);
  b.classList.add('connected');
}
async function connectWallet() {
  if (!window.ethereum) {
    toast('未检测到浏览器钱包, 请安装 MetaMask');
    window.open('https://metamask.io/download/', '_blank');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    state.address = accounts[0].toLowerCase();
    localStorage.setItem('bw_address', state.address);
    renderWalletConnected();
    refreshFree();
    toast('已连接 ' + shortAddr(state.address));
  } catch (e) { toast('连接钱包被拒绝'); }
}

// Base / Base Sepolia 网络参数(MetaMask 未添加时自动 wallet_addEthereumChain)
const CHAIN_PARAMS = {
  base: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  'base-sepolia': {
    chainId: '0x14a34',
    chainName: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorerUrls: ['https://sepolia.basescan.org'],
  },
};

// 切到目标链(否则 MetaMask 付错网络); 网络未添加时自动添加
async function ensureChain() {
  const net = state.config?.network || 'base-sepolia';
  const params = CHAIN_PARAMS[net] || CHAIN_PARAMS['base-sepolia'];
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: params.chainId }],
    });
  } catch (e) {
    // 4902 = 钱包中还没有这个网络, 自动添加后再切
    if (e?.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [params],
        });
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: params.chainId }],
        });
      } catch (e2) {
        throw new Error('添加/切换 ' + params.chainName + ' 网络失败: ' + (e2?.message || e2));
      }
    }
    // 其他错误(如用户拒绝)不阻断, 可能已在正确网络
  }
}

// ---------- 免费体验 ----------
async function experience() {
  if (!ensureWallet()) return;
  try {
    toast('正在生成免费体验链接…');
    const r = await api('/room/new', {
      method: 'POST',
      body: JSON.stringify({ address: state.address, deviceId: getDeviceId() }),
    });
    showResult(r, true);
  } catch (e) { toast(e.message); }
}

// ---------- 购买(支付) ----------
async function pay() {
  if (!ensureWallet()) return;
  const pkg = state.packages.find((p) => p.id === state.selectedId);
  if (!pkg) { toast('请选择套餐'); return; }

  const useMock = $('mockChk').checked || state.config?.mock;
  if (useMock) {
    try {
      toast('测试模式: 直接分发链接(不付币)…');
      const r = await api('/buy', {
        method: 'POST',
        body: JSON.stringify({ packageId: pkg.id, address: state.address, mock: true }),
      });
      showResult(r, false);
      toast('✅ 测试支付成功（未真实付币）');
    } catch (e) { toast(e.message); }
    return;
  }

  // 真实 x402 支付
  try {
    await ensureChain();
    toast('请在钱包中确认支付(USDC)…');
    const xf = await buildX402Fetch();
    const res = await xf(location.origin + '/api/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: pkg.id, address: state.address }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '支付未成功');
    showResult(data, false);
    toast('✅ 支付成功！专属链接已生成');
  } catch (e) {
    console.error(e);
    toast('支付失败: ' + (e.message || e));
  }
}

// 用 @x402/fetch + @x402/evm + viem 构造带 MetaMask 签名的支付 fetch
// (与 bolloon x402Pay.ts 的 createX402PaymentFetch 同源, 仅私钥换成浏览器钱包)
let _x402FetchCache = null;
async function buildX402Fetch() {
  if (_x402FetchCache) return _x402FetchCache;
  const net = state.config?.network || 'base-sepolia';
  const [{ wrapFetchWithPayment, x402Client }, { ExactEvmScheme, toClientEvmSigner }, viem, chains] = await Promise.all([
    import('https://esm.sh/@x402/fetch@2.25.0'),
    import('https://esm.sh/@x402/evm@2.25.0'),
    import('https://esm.sh/viem@2.56.3'),
    import('https://esm.sh/viem@2.56.3/chains'),
  ]);
  const chain = net === 'base' ? chains.base : chains.baseSepolia;
  const caip2 = net === 'base' ? 'eip155:8453' : 'eip155:84532';

  const walletClient = viem.createWalletClient({
    account: state.address, chain, transport: viem.custom(window.ethereum),
  });
  const publicClient = viem.createPublicClient({ chain, transport: viem.http() });
  const account = {
    address: state.address,
    signTransaction: (tx) => walletClient.signTransaction(tx),
    signMessage: ({ message }) => walletClient.signMessage({ message }),
    signTypedData: (data) => walletClient.signTypedData(data),
  };
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register(caip2, new ExactEvmScheme(signer));
  client.registerV1(net, new ExactEvmScheme(signer));
  _x402FetchCache = wrapFetchWithPayment(fetch, client);
  return _x402FetchCache;
}

// ---------- 结果页 ----------
function showResult(data, isFree) {
  state.lastResult = data;
  showPage('result');
  hide('resultPending'); show('resultBody');
  $('resultOk').textContent = isFree ? '🎁 免费体验链接已生成' : '✅ 支付成功';
  $('resultUrl').textContent = data.url || '';
  // 拉取剩余次数(带设备标识, 反映本设备可用免费次数)
  api('/user/' + state.address + '?device=' + getDeviceId()).then((info) => {
    $('resultRemaining').textContent = `账户剩余 ${info.remaining} 次；每条消息 / 每次传输消耗 1 次（申请地址本身不消耗）。`;
    $('resultLimit').textContent = info.maxFileText ? `当前套餐单文件上限：${info.maxFileText}` : '';
  }).catch(() => {});
}
async function copyUrl() {
  const url = $('resultUrl').textContent;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('链接已复制'); }
  catch { toast('复制失败, 请手动复制'); }
}
// ---------- 我的记录 ----------
async function loadRecords() {
  try {
    const info = await api('/user/' + state.address + '?device=' + getDeviceId());
    $('recFree').textContent = info.freeRemaining ?? info.freeUses ?? 0;
    $('recPurchased').textContent = info.purchased || 0;
    $('recUsed').textContent = info.used || 0;
    $('recRemaining').textContent = info.remaining || 0;

    const list = $('addrList');
    list.innerHTML = '';
    if (!info.addresses || !info.addresses.length) { show('recEmpty'); return; }
    hide('recEmpty');
    // 每个套餐各自一条地址(地址随套餐不同, 且带「次数上限」与「单文件大小上限」)。
    // 链接已由服务端用「当前隧道公网地址」重建, 故每次打开本页即为最新; 也可点「更新地址」手动刷新。
    info.addresses.forEach((ad) => {
      // 直接采用主服务房间的真实额度(limit/used/remaining), 与「用完即失效」的强制逻辑保持一致,
      // 不再用套餐次数覆盖, 避免出现「额度 10 却已用 22」的自相矛盾。
      const remaining = ad.roomRemaining;
      const usable = remaining > 0 && !ad.disabled;
      const badge = ad.disabled ? '已失效' : (usable ? '可用' : '已用完');
      const el = document.createElement('div');
      el.className = 'addr';
      el.innerHTML = `
        <div class="addr-top">
          <div class="pkg">${ad.label || '套餐'}</div>
          <div class="badge ${usable ? 'ok' : 'bad'}">${badge}</div>
        </div>
        <div class="meta">次数：额度 ${ad.roomLimit} · 已用 ${ad.roomUsed} · 剩余 ${remaining}</div>
        <div class="meta">单文件上限：${ad.maxFileText}</div>
        <div class="meta">消费 ${ad.priceText} · ${ad.createdAtText}</div>
        ${usable ? `
        <div class="url">${ad.url}</div>
        <div class="btn-row">
          <button class="copy" data-url="${ad.url}">复制</button>
          <button class="copy btn-update">更新地址</button>
        </div>` : `<div class="hint">${ad.disabled ? '该地址已被禁用。' : '该套餐额度已用完，地址已失效，请重新购买套餐获取新链接。'}</div>`}
      `;
      el.querySelectorAll('button.copy').forEach((b) => {
        b.onclick = (e) => {
          if (e.target.classList.contains('btn-update')) {
            toast('正在刷新地址…'); loadRecords();
          } else {
            navigator.clipboard.writeText(e.target.dataset.url).then(() => toast('已复制')).catch(() => toast('复制失败'));
          }
        };
      });
      list.appendChild(el);
    });
  } catch (e) { toast(e.message); }
}
init();
