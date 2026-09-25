# bollweb 网页支付（去中心化 x402）

在 `bollwebpay/payhtml` 提供一套**网页版**次数购买功能：流程与交互参考原微信小程序（`pay/miniprogram`），但**底层支付用 [bolloon](/home/fei/workspace/bolloon) 的去中心化 x402 支付**（浏览器钱包直接付 USDC / Base 链），不再依赖微信。

- 前端：纯静态网页（首页 / 购买 / 结果 / 我的记录），用 MetaMask 等浏览器钱包付款。
- 后端：Cloudflare Worker，托管前端并把「微信虚拟支付」换成 x402 收款 + 调主服务分发房间。
- 一句话：`POST /api/buy` → 无 `X-PAYMENT` 返回 402（收款要求）→ 前端钱包签名付款并带 `X-PAYMENT` 重试 → Worker 用 facilitator `/verify`+`/settle` 校验链上付款 → 调主服务 `/api/provision` 开带次数上限的加密房间 → 返回分享链接。

## 与小程序实现的对应关系

| 小程序（原） | 本网页（新） |
|---|---|
| 微信 `openid` 标识用户 | **钱包地址**标识用户（`localStorage` 缓存） |
| `wx.requestVirtualPayment` 微信虚拟支付 | `@x402/fetch` + `@x402/evm` + viem，MetaMask 付 USDC |
| `/pay/notify` 异步发货推送 + 轮询取链接 | 同步：付款即返回房间链接，**无需轮询** |
| 服务端微信签名 / `virtual-pay.js` | `src/x402.js`（抄 bolloon 的 `buildPaymentRequired` / `checkAndSettlePayment`） |
| `pay/server.js` 记账 / 分发 | `src/store.js`（用 Cloudflare KV，逻辑同 `pay/server.js`） |

支付核心（`src/x402.js`）直接搬运自 `bolloon/src/agents/x402/paid-info-store.ts` 的 `buildPaymentRequired()` 与 `checkAndSettlePayment()`（facilitator 分支），只去掉了 DIAP 身份信封，保留「生成 402 收款要求」和「facilitator 校验+结算」两段。

## 目录结构

```
payhtml/
├── public/            # 前端静态网页(Cloudflare 静态资源)
│   ├── index.html     # 首页/购买/结果/记录 四个页面(单页切换)
│   ├── app.js         # 钱包连接 + x402 支付 + 页面逻辑
│   └── style.css
├── src/
│   ├── worker.js      # Cloudflare Worker 主入口(API 路由 + 托管静态资源)
│   ├── x402.js        # x402 服务端: 402 响应 + facilitator 校验/结算(抄 bolloon)
│   └── store.js       # KV 账户/套餐/房间分发(逻辑抄 pay/server.js, 用 KV)
├── wrangler.toml      # Cloudflare Worker 配置(静态资源 + KV)
├── package.json
└── .dev.vars.example  # 环境变量示例
```

## 前置条件

1. **Cloudflare 账号** + 安装 `wrangler`：`npm i -g wrangler` 并 `wrangler login`。
2. **主服务在跑**：`bollwebpay/server.js`（`node server.js`），且设置了 `PROVISION_TOKEN`（与下面的 `MAIN_PROVISION_TOKEN` 一致）。房间链接指向它。
3. **一个收款钱包地址**（EVM，如 MetaMask 地址）—— 用户付的 USDC 进这个地址。

## 部署到 Cloudflare

```bash
cd payhtml
npm install                      # 装 wrangler

# 1) 创建 KV 命名空间, 把返回的 id 填进 wrangler.toml 的 PAYHTML_KV.id
wrangler kv namespace create PAYHTML_KV

# 2) 配置变量(线上)。NETWORK 默认 base-sepolia 测试网
wrangler vars set PAY_TO 0x你的收款地址
wrangler vars set NETWORK base-sepolia
wrangler vars set MAIN_BASE_URL https://你的主服务地址
wrangler vars set MAIN_PROVISION_TOKEN 你的PROVISION令牌
wrangler vars set MAIN_PUBLIC_BASE_URL https://你的主服务地址
# FACILITATOR_URL / MOCK 可选

# 3) 部署(前端 + API 一步到位)
wrangler deploy
```

部署完成后，`https://<你的子域>.workers.dev`（或绑定的自定义域名）即网页入口。

## 本地联调（不部署也能跑）

```bash
cp .dev.vars.example .dev.vars   # 填好 PAY_TO / MAIN_BASE_URL / MAIN_PROVISION_TOKEN
npm run dev                       # wrangler dev, 默认 http://localhost:8787
```

本地开发时建议把 `MOCK=1` 打开（或在网页勾选「测试模式」），即可**不连钱包、不付币**直接走通「选套餐 → 分发链接 → 我的记录」全流程。

## 本地 Node 服务（不依赖 Cloudflare）

如果你不想装 wrangler / 不开 Cloudflare 账号，也可以用**纯 Node 跑同一套前后端**。底层逻辑（`store.js` / `x402.js`）和 Worker 版完全共用，只是把 Cloudflare KV 换成本地 JSON 文件（`.data/kv.json`），并用 Node 原生 http 托管前端。

```bash
cd payhtml
cp .env.example .env          # 填好 PAY_TO / MAIN_BASE_URL / MAIN_PROVISION_TOKEN
npm run dev:node              # 或 node src/server.node.js, 默认 http://localhost:8787
# 自定义端口: PORT=9000 node src/server.node.js
```

- 启动后行为、API、前端页面与 Cloudflare 版**完全一致**（同样支持 `MOCK=1` 测试模式、同样的 x402 402 流程）。
- 数据存在 `payhtml/.data/kv.json`，删掉即可清空本地账户/订单。
- 路由：`/api/config`、`/api/packages`、`/api/buy`、`/api/room/new`、`/api/user/:address`，静态页 `/`。
- 变量从 `.env` 或进程环境变量读取，变量名与 Worker 版通用（多了 `PORT`）。

> 适用场景：本地开发、内网演示、或作为自建服务器部署（无需 Cloudflare 边缘）。生产上 Cloudflare 版与 Node 版二选一即可。

## 真实付币测试（Base Sepolia 测试网）

1. 浏览器装 MetaMask，切到 **Base Sepolia** 网络（Chain ID `0x14a34`）。
2. 领取测试网 USDC（Base Sepolia faucet，搜索 "Base Sepolia USDC faucet"）。
3. 网页点「连接钱包」→ 选套餐 →「去支付」→ 在 MetaMask 确认 USDC 转账。
4. 支付成功后自动跳结果页，复制分享链接发给对方即可互传文件。

> 生产环境把 `NETWORK` 改为 `base`（主网，Chain ID `0x2105`），并使用真实 USDC。注意：x402 的 facilitator 负责把付款上链结算（gas 由 facilitator 或付款方承担，视 facilitator 配置）。

## 环境变量说明

| 变量 | 说明 |
|---|---|
| `PAY_TO` | **必填** 收款钱包地址（USDC 到账地址） |
| `NETWORK` | `base-sepolia`（默认, 测试网）或 `base`（主网） |
| `FACILITATOR_URL` | x402 facilitator，默认 `https://x402.org/facilitator` |
| `MAIN_BASE_URL` | 主服务 `server.js` 地址（提供 `/api/provision`、`/api/room`） |
| `MAIN_PROVISION_TOKEN` | 主服务 `PROVISION_TOKEN`，须与主服务一致 |
| `MAIN_PUBLIC_BASE_URL` | 主服务生成房间链接用的公网基础地址（默认同 `MAIN_BASE_URL`） |
| `MOCK` | `1` 时跳过真实链上支付，直接分发（测试用） |

## 安全 / 设计要点（沿用 bolloon）

- **私钥永不暴露**：收款方只需要 `PAY_TO` 地址，无需私钥；付款由用户浏览器钱包签名，服务端只做 facilitator 校验。
- **支付凭据绑定订单**：`extra.orderId` 把付款绑定到具体订单，防止同一笔付款跨订单复用。
- **幂等**：订单已 `paid` 不会重复开房间；facilitator 侧付款单笔单次使用。
- **本地/测试联调**明确标记「非链上」，不会冒充真实付款（对应 bolloon 的 `local-dev`）。



cd payhtml
cp .env.example .env          # 填 PAY_TO / MAIN_BASE_URL / MAIN_PROVISION_TOKEN
npm run dev:node              # 默认 http://localhost:8787
# 或 PORT=9000 node src/server.node.js
http://localhost:8787