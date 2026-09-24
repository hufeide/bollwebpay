const { apiBase } = require('../../config.js');

Page({
  data: { status: 'pending', url: '', room: '', limit: 0, count: 0 },
  onLoad(query) {
    this.orderId = query.orderId;
    this.poll();
  },
  poll() {
    const tick = () => {
      wx.request({
        url: apiBase + '/api/order/' + this.orderId,
        success: (res) => {
          const d = res.data || {};
          this.setData({ status: d.status, url: d.url, room: d.room, limit: d.limit, count: d.count });
          if (d.status === 'paid') {
            wx.hideLoading();
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
  copy() {
    if (!this.data.url) return;
    wx.setClipboardData({ data: this.data.url });
  },
  reopen() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
