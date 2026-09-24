const { apiBase } = require('../../config.js');

// 用 code 换 openid 并缓存(体验/记录/重申请都要用)
function getOpenid() {
  return new Promise((resolve, reject) => {
    const cached = wx.getStorageSync('openid');
    if (cached) return resolve(cached);
    wx.login({
      success: ({ code }) => {
        wx.request({
          url: apiBase + '/api/login',
          method: 'POST',
          data: { code },
          success: (res) => {
            const d = res.data || {};
            if (d.openid) { wx.setStorageSync('openid', d.openid); resolve(d.openid); }
            else reject(d.error || 'login fail');
          },
          fail: () => reject('network'),
        });
      },
      fail: () => reject('login fail'),
    });
  });
}

Page({
  data: {
    pricePerUse: 0.10,
    packCount: 10,
    packPrice: '1.00',
    freeUses: 10,
  },
  // 免费体验: 用赠送的 10 次生成一条传输链接
  experience() {
    wx.showLoading({ title: '准备体验' });
    getOpenid().then((openid) => {
      wx.request({
        url: apiBase + '/api/room/new',
        method: 'POST',
        data: { openid },
        success: (res) => {
          const d = res.data || {};
          if (d.url) {
            wx.hideLoading();
            wx.navigateTo({ url: '/pages/result/result?url=' + encodeURIComponent(d.url) + '&openid=' + openid + '&remaining=' + d.remaining });
          } else {
            wx.hideLoading();
            wx.showToast({ title: d.error || '体验次数已用完, 请购买', icon: 'none' });
          }
        },
        fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'none' }); },
      });
    }).catch(() => { wx.hideLoading(); wx.showToast({ title: '登录失败', icon: 'none' }); });
  },
  onBuy() { wx.navigateTo({ url: '/pages/index/index' }); },
  onRecords() { wx.navigateTo({ url: '/pages/records/records' }); },
});
