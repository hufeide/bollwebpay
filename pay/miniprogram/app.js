const { refreshApiBase } = require('./config.js');

App({
  globalData: {},
  onLaunch() {
    // 启动即拉取最新 apiBase(若已配置远程配置), 之后所有请求自动用新地址
    refreshApiBase();
  },
});
