# bollweb-pay — 按对话次数付费(个人主体小程序 · 虚拟支付)

> ⚠️ 个人主体小程序**不能**用标准微信支付 JSAPI，必须通过**虚拟支付**(`wx.requestVirtualPayment`)售卖虚拟商品。
> 本项目售卖的「对话次数」属于虚拟商品，因此这里接入的是**虚拟支付**，不是普通微信支付。

目标：用户在小程序里**填写想买的使用次数**，虚拟支付成功后，系统向 `bollweb` 主服务
（`server.js`）**分发一个带次数上限的新链接**。该链接用尽（对话 + 传输累计达到上限）
后自动失效。

```
微信小程序 ──下单(count)──▶ pay 服务(生成 signData+paySig+signature)──▶ wx.requestVirtualPayment
                                   ▲                                      │
                                   │           支付成功「发货推送」          │
                                   └──── POST /pay/notify(XML) ◀───────────┘
                                         │ 验签(可选) + 幂等(以 wx_order_id 去重)
                                         ▼ 标记已支付
                                   pay 服务 ──POST /api/provision(count)──▶ bollweb 主服务
                                   (兜底: GET /api/order/:id 主动 query_order 补发)
                                   小程序轮询 /api/order/:id ◀───────────────┘ 拿到新链接
```

## 目录

```
pay/
├── server.js              # 支付后端(Express): 下单 / 发货推送 / 兜底查单 / 分发房间
├── virtual-pay.js         # 虚拟支付工具(签名、code2Session、XML 解析、query_order)
├── config.js              # 读取环境变量
├── public/index.html      # 简易测试页(MOCK 模式用)
├── .env.example           # 环境变量示例
├── miniprogram/           # 微信小程序源码(填写次数→虚拟支付→复制链接)
└── README.md
```

## 一、主服务(bollweb)先准备好

`server.js` 已内置「房间额度」能力：每收到一次聊天/文件传输记 1 次使用，达到上限后链接失效。
两个接口：

- `POST /api/provision`（需 `PROVISION_TOKEN`）— 预创建带 `limit=count` 的房间，返回分享链接。
- `GET  /api/room/:room` — 查询剩余次数 / 是否失效。

启动主服务（务必设置，否则生成的链接打不开 / 无法下发房间）：

```bash
PROVISION_TOKEN=你的强随机令牌 \
BASE_URL=https://你的cloudflare域名 \
node server.js
```

## 二、微信侧前置（个人主体虚拟支付开通）

按官方接入指引完成：

1. 小程序主体为**个人**，已完成**认证 + 备案**，服务类目含「工具」。
2. 微信开放平台 → 支付与交易 → 虚拟支付 → **开通**（填写身份信息、提现账户、支付管理员）。
3. 记录：`AppID`（公众平台设置）、`OfferID`（虚拟支付基本配置）、`现网AppKey`（支付密钥）。
4. 虚拟支付 → **道具管理**，创建一个道具（如“对话次数”），记下调用的**道具 ID** 与**单价(分)**，
   该单价须与下面 `PRICE_PER_USE` 一致；总价 = 单价 × 购买次数。
5. 若需 iOS 支付：公众平台 → 账号设置 → 基本信息 配置「小程序简称」，并在虚拟支付开通苹果 IAP。
6. 小程序后台 → 开发管理 → **消息推送**，把「发货推送」URL 设为 `{PAY_NOTIFY_BASE_URL}/pay/notify`。

> 个人主体全终端月支付限额 10 万元；费率 Android 1%、iOS 12%（含 Apple 佣金）。

## 三、配置 pay 服务

```bash
cd pay
npm install
cp .env.example .env   # 然后填好下面的变量
```

关键环境变量（详见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `WX_APPID` / `WX_APP_SECRET` | 小程序 AppID / AppSecret（code 换 openid/session_key） |
| `WX_OFFER_ID` | 虚拟支付 OfferID（商户号） |
| `WX_APP_KEY` | 现网 AppKey（支付密钥，签名/验签用） |
| `WX_PRODUCT_ID` | 道具 ID（后台创建） |
| `PRICE_PER_USE` | 道具单价（分），须与后台道具价格一致 |
| `PAY_NOTIFY_BASE_URL` | pay 服务对外地址，发货推送 URL = `{此地址}/pay/notify` |
| `MAIN_BASE_URL` / `MAIN_PROVISION_TOKEN` | 主服务地址与令牌（须与主服务一致） |
| `VERIFY_NOTIFY_SIG` | 推送验签开关，默认 0（核对公式后再开 1） |
| `MOCK_PAY` | 设为 `1` 时下单即视为已支付，无需微信资质，用于联调 |

## 四、启动与联调

```bash
# 真实虚拟支付
node server.js
# 本地联调(不需要任何微信资质)
MOCK_PAY=1 MAIN_BASE_URL=https://你的cloudflare域名 MAIN_PROVISION_TOKEN=你的令牌 node server.js
```

联调时打开 `http://localhost:8081` 测试页，填次数 → 下单，会立即拿到带额度的新链接。

## 五、微信小程序

1. 微信开发者工具「导入项目」，目录选 `pay/miniprogram/`，填入你的小程序 AppID。
2. 修改 `pay/miniprogram/config.js` 的 `apiBase` 为 pay 服务 HTTPS 地址。
3. 公众平台 → 开发设置 → **服务器域名 → request 合法域名** 加入该 HTTPS 域名。
4. 编译预览：填写次数 → 支付（弹起虚拟支付）→ 跳结果页 → 复制链接 → 发给对方打开即用。

> 小程序虚拟支付走 `wx.requestVirtualPayment`；`MOCK_PAY` 模式下会跳过真实支付直接验证流程。

## 六、部署前检查清单（按官方文末清单）

| 项 | 负责方 | 状态 |
| --- | --- | --- |
| 个人主体 + 身份证 + 类目「工具」+ 认证/备案 | 微信后台 | ⚙️ 需你操作 |
| 已告知用户月限额 10 万元 | 产品/文案 | ✅ 见 README 第二节 |
| 虚拟支付已开通 | 微信后台 | ⚙️ 需你操作 |
| 已拿到 AppID / OfferID / AppKey | 微信后台 | ⚙️ 需你填入 .env |
| iOS 支付已配置小程序简称(如需) | 微信后台 | ⚙️ 按需 |
| 消息推送接收 URL 已部署(`/pay/notify`) | 本服务 | ✅ 已实现 |
| 后台已配置发货推送 URL 并完成测试支付 | 微信后台 + 你 | ⚙️ 需你联调 |
| 服务器验签逻辑通过 | 本服务 | ✅ 已实现；`VERIFY_NOTIFY_SIG=1` 待你核对公式后开启 |
| 发货推送幂等(以 wx_order_id 去重) | 本服务 | ✅ 已实现 |
| 前端 wx.requestVirtualPayment 打通 | 小程序 | ✅ 已实现 |
| 兜底查单(query_order)已就绪 | 本服务 | ✅ 已实现 |
| 已说明退款/结算/费率 | 产品/文案 | ⚙️ 你补充告知用户 |
| 上线小额真单验证(支付→推送→发货→账单一致) | 你 | ⚙️ 上线验证 |

## 七、使用次数口径

主服务在房间内每收到一次「聊天(store-chat)」或「文件传输(store-file)」记 1 次使用。
达到上限后：新加入者被拒绝（`ROOM_DISABLED`），已在房间者收到 `room-expired` 提示，
前端禁用输入框 —— 即“链接失效”。
