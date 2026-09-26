const { getApiBase } = require('../../config.js');

// 用 code 换 openid 并缓存(体验/记录/重申请都要用)
function getOpenid() {
  return new Promise((resolve, reject) => {
    const cached = wx.getStorageSync('openid');
    if (cached) return resolve(cached);
    wx.login({
      success: ({ code }) => {
        wx.request({
          url: getApiBase() + '/api/login',
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

// 设备标识: 持久化在小程序本地存储, 用于「每台设备」限制免费体验次数(对齐网页版 getDeviceId,
// 防换账号白嫖)。每个设备只生成一次。
function getDeviceId() {
  let id = wx.getStorageSync('bw_device');
  if (!id) { id = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); wx.setStorageSync('bw_device', id); }
  return id;
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
        url: getApiBase() + '/api/room/new',
        method: 'POST',
        data: { openid, deviceId: getDeviceId() },
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
  // 转发给好友
  onShareAppMessage() {
    return {
      title: 'bollweb 传输助手 - 跨设备免安装传文件',
      path: '/pages/home/home',
    };
  },
  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: 'bollweb 传输助手 - 跨设备免安装传文件',
    };
  },
});
