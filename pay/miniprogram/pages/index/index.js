const { apiBase } = require('../../config.js');

// iOS 需微信客户端 >= 8.0.68 才支持虚拟支付
function checkIosMinVersion() {
  try {
    const info = wx.getSystemInfoSync();
    if (info.platform === 'ios') {
      const v = (info.version || '').split('.');
      const need = [8, 0, 68];
      for (let i = 0; i < need.length; i++) {
        const a = parseInt(v[i] || '0', 10);
        if (a > need[i]) return true;
        if (a < need[i]) {
          wx.showModal({ title: '请更新微信', content: 'iOS 端需微信 8.0.68 及以上才支持支付，请先更新微信。', showCancel: false });
          return false;
        }
      }
    }
  } catch (e) {}
  return true;
}

Page({
  data: {
    count: 10,
    unit: 0.10,   // 与后端 PRICE_PER_USE(分)/100 对应(道具单价)
    price: '1.00',
  },
  onLoad() { this.calc(); },
  onCountInput(e) {
    const count = parseInt(e.detail.value, 10) || 0;
    this.setData({ count }, () => this.calc());
  },
  calc() {
    const c = this.data.count || 0;
    this.setData({ price: (c * this.data.unit).toFixed(2) });
  },
  pay() {
    const count = this.data.count;
    if (!count || count < 1) { wx.showToast({ title: '请输入次数', icon: 'none' }); return; }
    if (!checkIosMinVersion()) return;
    wx.showLoading({ title: '准备支付' });
    wx.login({
      success: ({ code }) => {
        wx.request({
          url: apiBase + '/api/order',
          method: 'POST',
          data: { code, count },
          success: (res) => {
            const d = res.data || {};
            if (res.statusCode !== 200 || (!d.mock && !d.payData)) {
              wx.hideLoading();
              wx.showToast({ title: (d && d.error) || '下单失败', icon: 'none' });
              return;
            }
            // 测试模式: 直接跳转结果页
            if (d.mock) {
              wx.hideLoading();
              wx.redirectTo({ url: '/pages/result/result?orderId=' + d.orderId });
              return;
            }
            // 虚拟支付: 把服务端签好名的 payData 直接交给 wx.requestVirtualPayment
            wx.requestVirtualPayment(Object.assign({}, d.payData, {
              success: () => {
                wx.hideLoading();
                wx.redirectTo({ url: '/pages/result/result?orderId=' + d.orderId });
              },
              fail: (err) => {
                wx.hideLoading();
                wx.showToast({ title: '支付未完成', icon: 'none' });
                console.log('requestVirtualPayment fail', err);
              },
            }));
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '网络错误', icon: 'none' });
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '登录失败', icon: 'none' });
      },
    });
  },
});
