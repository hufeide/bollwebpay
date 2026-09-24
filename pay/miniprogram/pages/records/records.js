const { apiBase } = require('../../config.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: { openid: '', freeUses: 0, freeRemaining: 0, purchased: 0, used: 0, remaining: 0, addresses: [] },
  onLoad() {
    this.openid = wx.getStorageSync('openid') || '';
    this.setData({ openid: this.openid });
    this.load();
  },
  onShow() { this.load(); },
  load() {
    if (!this.openid) {
      wx.showToast({ title: '请先完成一次支付', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加载中' });
    wx.request({
      url: apiBase + '/api/user/' + this.openid,
      success: (res) => {
        const d = res.data || {};
        const addresses = (d.addresses || []).map((a) => ({
          ...a,
          priceText: (a.priceFen && a.priceFen > 0) ? '¥' + (a.priceFen / 100).toFixed(2) : '免费',
          createdAtText: fmtTime(a.createdAt),
          roomLimit: a.roomLimit || a.limit || 0,
          roomUsed: a.roomUsed || 0,
          roomRemaining: (a.roomRemaining != null) ? a.roomRemaining : (a.roomLimit || a.limit || 0),
        }));
        this.setData({
          freeUses: d.freeUses || 0,
          freeRemaining: d.freeRemaining || 0,
          purchased: d.purchased || 0,
          used: d.used || 0,
          remaining: d.remaining || 0,
          addresses,
        });
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => wx.hideLoading(),
    });
  },
  copy(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.setClipboardData({ data: url });
  },
  // 用剩余次数申请新地址(顶部按钮)
  applyNew() {
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '次数已用完, 请先购买', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '申请中' });
    wx.request({
      url: apiBase + '/api/room/new',
      method: 'POST',
      data: { openid: this.openid },
      success: (res) => {
        const d = res.data || {};
        if (d.url) {
          this.setData({ remaining: d.remaining });
          this.load();
          wx.showToast({ title: '已生成新地址', icon: 'success' });
        } else {
          wx.showToast({ title: d.error || '申请失败', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => wx.hideLoading(),
    });
  },
  // 失效地址下: 用当前套餐剩余次数重新申请(对应套餐沿用账户最高档上限)
  reapply(e) {
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '次数已用完, 请先购买', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '申请中' });
    wx.request({
      url: apiBase + '/api/room/new',
      method: 'POST',
      data: { openid: this.openid },
      success: (res) => {
        const d = res.data || {};
        if (d.url) {
          this.setData({ remaining: d.remaining });
          this.load();
          wx.showToast({ title: '已生成新地址', icon: 'success' });
        } else {
          wx.showToast({ title: d.error || '申请失败', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => wx.hideLoading(),
    });
  },
  goBuy() { wx.navigateTo({ url: '/pages/index/index' }); },
});
