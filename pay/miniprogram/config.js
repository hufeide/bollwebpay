// 小程序侧配置
//

// configJsonUrl: 引导用 JSON 地址, 内容为 { "apiBase": "https://<当前隧道>/pay" }。
//   开发期指向本地 pay 服务暴露的 /config.json: start.sh 把当前隧道地址写入环境变量 MP_API_BASE,
//   服务端 /config.json 直接回传它。小程序每次启动/重试自动拉取, 拿到最新 apiBase —— 无需重编译、无需手动改存储。
//   该地址走 localhost, 仅开发者工具本地可达(需勾选「不校验合法域名」)。
//   真机/正式环境: 把它换成【稳定托管】的 JSON(GitHub Pages / Gitee Pages / Cloudflare Pages),
//   并在微信后台把该域名加入 request 合法域名。
const CONFIG_JSON_URL = 'http://localhost:8081/config.json';
// apiBase: 兜底地址。仅当远程配置(localhost /config.json)拉取失败时使用, 建议填你的固定域名/命名隧道,
// 以便真机在不依赖引导 JSON 时也能工作。此处给本地直连作为开发兜底。
const FALLBACK_API_BASE = 'http://localhost:8081';

// 运行时获取当前 apiBase 优先级:
//   ① 开发者工具 Storage 里手动设的 apiBase(隧道一变, 改这里即可, 免重编译, 仅开发用)
//   ② 本次启动从引导 JSON 拉到的值(_remoteApiBase, 由 CONFIG_JSON_URL 指向的 /config.json 提供)
//   ③ 兜底地址 FALLBACK_API_BASE(编译后生效)
let _remoteApiBase = '';
function getApiBase() {
  const s = wx.getStorageSync('apiBase');
  if (s) return s;
  if (_remoteApiBase) return _remoteApiBase;
  return FALLBACK_API_BASE;
}

// 从远程 JSON 拉取最新 apiBase(只存本次会话, 不写持久存储)。
// 配置好 CONFIG_JSON_URL 后, 重启服务只需改那个 JSON 里的 apiBase, 小程序下次会议自动生效,
// 既不用重编, 也不用清缓存。未配置(占位地址)时自动跳过。
function refreshApiBase(cb) {
  if (!CONFIG_JSON_URL || CONFIG_JSON_URL.indexOf('YOUR-STABLE-HOST') >= 0) {
    if (cb) cb();
    return;
  }
  wx.request({
    url: CONFIG_JSON_URL,
    success: (res) => {
      const u = res.data && res.data.apiBase;
      if (u) _remoteApiBase = u;
    },
    complete: () => { if (cb) cb(); },
  });
}

module.exports = { configJsonUrl: CONFIG_JSON_URL, apiBase: FALLBACK_API_BASE, getApiBase, refreshApiBase };
