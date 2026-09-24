const { apiBase } = require('../../config.js');

function fmtSize(bytes) {
  if (!bytes) return '';
  const MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  if (bytes >= GB) return (bytes / GB) + 'G';
  if (bytes >= MB) return Math.round(bytes / MB) + 'M';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'K';
  return bytes + 'B';
}

Page({
  data: { status: 'pending', url: '', room: '', limit: 0, count: 0, openid: '', remaining: 0, remainingReady: false, maxFileBytes: 0, maxFileText: '' },
  onLoad(query) {
    this.orderId = query.orderId;
    this.openid = query.openid || wx.getStorageSync('openid') || '';
    this.setData({ openid: this.openid });
    // 免费体验 / 重申请后直接带链接进来, 无需轮询订单
    if (query.url) {
      const qRem = Number(query.remaining);
      const hasQ = query.remaining !== undefined && !isNaN(qRem);
      this.setData({
        status: 'paid',
        url: decodeURIComponent(query.url),
        remaining: hasQ ? qRem : 0,
        remainingReady: hasQ,
      });
      this.refreshRemaining();
      return;
    }
    this.poll();
  },
  poll() {
    const tick = () => {
      wx.request({
        url: apiBase + '/api/order/' + this.orderId,
        success: (res) => {
          const d = res.data || {};
          this.setData({ status: d.status, url: d.url, room: d.room, limit: d.limit, count: d.count, maxFileBytes: d.maxFileBytes || 0, maxFileText: fmtSize(d.maxFileBytes || 0) });
          if (d.status === 'paid') {
            wx.hideLoading();
            this.refreshRemaining();
          } else if (d.status === 'provision_failed') {
            wx.showToast({ title: '链接分发失败, 请重试', icon: 'none' });
          } else {
            setTimeout(tick, 1500);
          }
        },
        fail: () => setTimeout(tick, 2000),
      });
    };
    tick();
  },
  // 拉取账户剩余次数(用于「重新申请地址」按钮)
  refreshRemaining() {
    if (!this.openid) return;
    wx.request({
      url: apiBase + '/api/user/' + this.openid,
      success: (res) => {
        const d = res.data || {};
        const rem = (typeof d.remaining === 'number' && !isNaN(d.remaining)) ? d.remaining : 0;
        this.setData({ remaining: rem, remainingReady: true, maxFileBytes: d.maxFileBytes || 0, maxFileText: fmtSize(d.maxFileBytes || 0) });
      },
    });
  },
  copy() {
    if (!this.data.url) return;
    wx.setClipboardData({ data: this.data.url });
  },
  // 用剩余次数重新申请一个地址
  reapply() {
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
        wx.hideLoading();
        if (d.url) {
          const rem = (typeof d.remaining === 'number' && !isNaN(d.remaining)) ? d.remaining : this.data.remaining;
          this.setData({ url: d.url, room: d.room, remaining: rem, remainingReady: true });
          wx.showToast({ title: '已生成新地址', icon: 'success' });
        } else {
          wx.showToast({ title: d.error || '申请失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      },
    });
  },
  reopen() {
    wx.reLaunch({ url: '/pages/home/home' });
  },
});
