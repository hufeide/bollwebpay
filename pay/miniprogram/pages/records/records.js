const { getApiBase, refreshApiBase } = require('../../config.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 登录换取 openid; 与支付流程保持一致: 优先用服务端返回的真实 openid 并缓存,
// 若登录接口异常(如服务端缺 WX_APPID/WX_APP_SECRET 环境变量、或微信侧抖动),
// 回退到本地缓存的 openid, 保证「我的记录」在登录不可用时仍可读, 不会凭空消失。
function getOpenid() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: ({ code }) => {
        wx.request({
          url: getApiBase() + '/api/login',
          method: 'POST',
          data: { code },
          success: (res) => {
            const d = res.data || {};
            if (d.openid) { resolve(d.openid); return; }
            const cached = wx.getStorageSync('openid');
            if (cached) { resolve(cached); return; }
            reject(d.error || 'login fail');
          },
          fail: () => {
            const cached = wx.getStorageSync('openid');
            if (cached) { resolve(cached); return; }
            reject('network');
          },
        });
      },
      fail: () => reject('login fail'),
    });
  });
}

Page({
  data: { openid: '', freeUses: 0, freeRemaining: 0, purchased: 0, used: 0, remaining: 0, addresses: [], netError: false },
  onLoad() {
    this.loadWithLogin();
  },
  onShow() { this.loadWithLogin(); },
  // 自动登录拿 openid 后再加载, 避免「刚进入记录为空、只有点过免费体验才有数据」的问题
  loadWithLogin() {
    this._retried = false;
    this._triedFallback = false;
    getOpenid().then((openid) => {
      this.openid = openid;
      this.setData({ openid });
      this.load();
    }).catch(() => {
      // 登录失败(如刚重启隧道未就绪/地址过期): 优先用本地缓存的 openid 继续加载,
      // 绝不用空 openid 去查 /api/user/(那会让服务端返回空地址, 记录「凭空消失」)。
      const cached = wx.getStorageSync('openid') || '';
      this.openid = cached;
      this.setData({ openid: cached });
      if (cached) this.load();
      else { this.setData({ netError: true }); wx.showToast({ title: '登录失败, 请稍后重试', icon: 'none' }); }
    });
  },
  // showLoading/hideLoading 是全局单例, onLoad + onShow 可能并发触发 load(),
  // 用计数器做成可重入, 避免「showLoading 与 hideLoading 必须配对」告警。
  _loadCount: 0,
  showLoad() { this._loadCount++; if (this._loadCount === 1) wx.showLoading({ title: '加载中' }); },
  hideLoad() { this._loadCount = Math.max(0, this._loadCount - 1); if (this._loadCount === 0) wx.hideLoading(); },
  load() {
    this.showLoad();
    wx.request({
      url: getApiBase() + '/api/user/' + (this.openid || ''),
      success: (res) => {
        // 非 200(如 /pay 反代返回 502)按失败处理: 保留已有记录, 不把列表清空
        if (res.statusCode !== 200) {
          if (!this._retried) { this._retried = true; refreshApiBase(() => this.load()); return; }
          this.setData({ netError: true });
          wx.showToast({ title: '服务暂时不可用, 请稍后重试', icon: 'none' });
          return;
        }
        const d = res.data || {};
        // known:false = 该 openid 在服务器端没有账户。常见于「登录换回的 openid 与历史落库 openid 不一致」
        // (曾清过缓存 / 不同身份登录 / 网页端与小程序端账户不互通)。此时若本地还缓存着另一个 openid,
        // 用缓存的再查一次, 把历史记录找回来(自愈, 无需手动清缓存)。
        if (!d.known && !this._triedFallback) {
          const cached = wx.getStorageSync('openid');
          if (cached && cached !== (this.openid || '')) {
            this._triedFallback = true;
            this.openid = cached;
            this.setData({ openid: cached });
            this.load();
            return;
          }
        }
        if (d.known) { try { wx.setStorageSync('openid', this.openid || ''); } catch (e) {} }
        // 与网页版「我的记录」对齐: 每条地址单独计算可用状态 / 徽标 / 提示,
        // 不再只展示一条「有效地址」, 而是「按套餐」逐条列出(含 url 与复制/更新)。
        const addresses = (d.addresses || []).map((a) => {
          const disabled = !!a.disabled;
          const remaining = (a.roomRemaining != null) ? a.roomRemaining : 0;
          const usable = remaining > 0 && !disabled;
          const badgeText = disabled ? '已失效' : (usable ? '可用' : '已用完');
          const badgeClass = usable ? 'ok' : 'bad';
          const hint = disabled
            ? '该地址已被禁用。'
            : '该套餐额度已用完，地址已失效，请重新购买套餐获取新链接。';
          return {
            ...a,
            priceText: (a.priceFen && a.priceFen > 0) ? '¥' + (a.priceFen / 100).toFixed(2) : '免费',
            createdAtText: fmtTime(a.createdAt),
            roomLimit: a.roomLimit || a.limit || 0,
            roomUsed: a.roomUsed || 0,
            roomRemaining: remaining,
            maxFileText: a.maxFileText || '',
            disabled,
            usable,
            badgeText,
            badgeClass,
            hint,
          };
        });
        this.setData({
          freeUses: d.freeUses || 0,
          freeRemaining: d.freeRemaining || 0,
          purchased: d.purchased || 0,
          used: d.used || 0,
          remaining: d.remaining || 0,
          addresses,
          netError: false,
        });
        if (!d.known) wx.showToast({ title: '未找到该账号(身份不一致), 记录可能无法显示', icon: 'none' });
      },
      fail: () => {
        // 可能 apiBase 过期(重启换了隧道): 拉一次远程配置再重试一次, 否则提示地址已变更
        if (!this._retried) {
          this._retried = true;
          refreshApiBase(() => this.load());
          return;
        }
        this.setData({ netError: true });
        wx.showToast({ title: '网络错误: 服务地址可能已变更', icon: 'none' });
      },
      complete: () => this.hideLoad(),
    });
  },
  copy(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.setClipboardData({ data: url });
  },
  // 刷新全部地址(重新拉取账户信息, 服务端会用当前公网地址重算有效链接)
  // 与网页版一致: 「更新全部地址」与每条地址的「更新地址」都走同一刷新逻辑。
  updateAddr() {
    wx.showToast({ title: '正在刷新地址…', icon: 'none' });
    this._retried = false;
    this._triedFallback = false;
    this.load();
  },
  goBuy() { wx.navigateTo({ url: '/pages/index/index' }); },
  goHome() { wx.navigateBack(); },
});
