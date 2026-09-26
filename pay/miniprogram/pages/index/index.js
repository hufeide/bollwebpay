const { getApiBase } = require('../../config.js');

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

// 用 code 换 openid 并缓存到本地, 供「我的记录 / 重新申请地址」使用
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

// 接口拉取失败时的静态兜底套餐(与后端 PACKAGES 保持一致)
const FALLBACK_PACKAGES = [
  { id: 'p1',   label: '体验包', count: 10,  priceYuan: '1.00',   maxFileText: '5M' },
  { id: 'p10',  label: '标准包', count: 50,  priceYuan: '10.00',  maxFileText: '20M' },
  { id: 'p100', label: '畅享包', count: 250, priceYuan: '100.00', maxFileText: '500M' },
  { id: 'p200', label: '旗舰包', count: 500, priceYuan: '200.00', maxFileText: '1G' },
];

Page({
  data: {
    packages: [],
    selectedId: '',
    selPrice: '',
    freeUses: 10,
  },
  onLoad() {
    this.loadPackages();
  },
  loadPackages() {
    wx.request({
      url: getApiBase() + '/api/packages',
      success: (res) => {
        const list = (res.data && res.data.packages) || [];
        const pkgs = list.length ? list : FALLBACK_PACKAGES;
        this.setData({ packages: pkgs, selectedId: pkgs.length ? pkgs[0].id : '' }, () => this.syncSelPrice());
      },
      fail: () => {
        this.setData({ packages: FALLBACK_PACKAGES, selectedId: FALLBACK_PACKAGES[0].id }, () => this.syncSelPrice());
      },
    });
  },
  syncSelPrice() {
    const pkg = this.data.packages.find((p) => p.id === this.data.selectedId);
    this.setData({ selPrice: pkg ? pkg.priceYuan : '' });
  },
  selectPackage(e) {
    this.setData({ selectedId: e.currentTarget.dataset.id }, () => this.syncSelPrice());
  },
  pay() {
    const pkg = this.data.packages.find((p) => p.id === this.data.selectedId);
    if (!pkg) { wx.showToast({ title: '请选择套餐', icon: 'none' }); return; }
    if (!checkIosMinVersion()) return;
    wx.showLoading({ title: '准备支付' });
    // 先确保拿到 openid(用于记录/重新申请地址)
    getOpenid().catch(() => {}).finally(() => {
      const openid = wx.getStorageSync('openid') || '';
      wx.login({
        success: ({ code }) => {
          wx.request({
            url: getApiBase() + '/api/order',
            method: 'POST',
            data: { code, packageId: pkg.id, openid },
            success: (res) => {
              const d = res.data || {};
              if (res.statusCode !== 200 || (!d.mock && !d.payData)) {
                wx.hideLoading();
                wx.showToast({ title: (d && d.error) || '下单失败', icon: 'none' });
                return;
              }
              const goto = '/pages/result/result?orderId=' + d.orderId + (openid ? '&openid=' + openid : '');
              // 测试模式: 直接跳转结果页
              if (d.mock) {
                wx.hideLoading();
                wx.redirectTo({ url: goto });
                return;
              }
              // 虚拟支付: 把服务端签好名的 payData 直接交给 wx.requestVirtualPayment
              wx.requestVirtualPayment(Object.assign({}, d.payData, {
                success: () => {
                  wx.hideLoading();
                  wx.redirectTo({ url: goto });
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
    });
  },
  // 转发给好友
  onShareAppMessage() {
    return {
      title: 'bollweb 传输助手 - 跨设备免安装传文件',
      path: '/pages/home/home',
    };
  },
});
