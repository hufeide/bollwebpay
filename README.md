# bollwebnew — 网页版 P2P 消息与文件传输(方案 B)

**目标**：任何手机/电脑，打开一个网址，填相同的房间码，就能聊天、传文件。
**零安装**：不需要 Node.js、不需要 Termux、不需要 Docker、不需要装 App。
**低成本**：正常情况下数据走设备之间的 WebRTC 直连，服务器只做“撮合”，几乎不耗带宽。

## 架构

```
           云服务器(一台低配 VPS)
   ┌──────────────────────────────────┐
   │  HTTPS 静态网页                    │
   │  WebSocket 信令(/ws)              │
   │  STUN(公共, 免费)                 │
   │  TURN(可选, 仅当 P2P 打不通时兜底) │
   └──────────────┬───────────────────┘
                  │  只交换 SDP/ICE/房间信息
      ┌───────────┴───────────┐
      ▼                       ▼
  📱 手机(Safari/Chrome)   💻 电脑(Chrome/Edge/Firefox)
      └──────── WebRTC P2P(DataChannel) ────────┘
            聊天 / 文件 直接传输, 不经过服务器
```

- **WebRTC DataChannel** 在浏览器之间直传聊天与文件（P2P）。
- 若两端 NAT 太严、直连失败，应用消息自动**回退到服务器中转(relay)**，保证“一定连得上”（此时服务器会经手流量，作为兜底）。
- 服务端**不存储聊天内容与文件**，只在内存里维护房间/同伴关系；聊天文本与文件名会按房间落盘到 `history.json` 以便回看历史（不含文件内容）。

## 本地运行

```bash
cd bollwebnew
npm install
npm start
# 浏览器打开 http://localhost:8080
```

- **推荐用法**：登录页点“创建房间 → 二维码”，把二维码/链接发给同伴，手机扫码即自动进入同一加密房间。
- **手动用法**：两端在“房间码”框填**相同的房间码**即可互连；也可把对方发来的完整分享链接直接粘贴进“房间码”框，会自动解析出房间码/密钥/昵称。
- 消息默认端到端加密（“端到端加密已开启”显示在状态栏）。

## 部署到公网（推荐 Docker + Caddy）

```bash
# 一键部署(HTTP 或 附带 HTTPS 反代):
./deploy.sh                 # 仅 Docker 启动
./deploy.sh caddy 你的域名   # Docker + Caddy HTTPS 自动签发证书

# 或手动:
docker compose up -d        # 起服务(或 node server.js)
caddy run --config Caddyfile  # Caddy 做 HTTPS 反代(把 Caddyfile 里的域名改成你的)
```

### 分享链接的基础地址（重要）

创建房间生成的二维码/链接默认用“当前页面地址”(`location.origin`)。如果你**通过反代/隧道（如 Cloudflare Tunnel）对外暴露**，而自己却用 `localhost` 打开管理页面，二维码里还是会写成 `localhost`，手机打不开。

解决：启动服务时设置环境变量 `BASE_URL` 为对外公网地址，服务端会自动注入页面，二维码即输出该域名：

```bash
# 直接 node
BASE_URL=https://你的域名 npm start

# Docker（在 docker-compose.yml 的 environment 里加一行）
environment:
  - BASE_URL=https://你的域名

# Cloudflare 临时隧道示例
BASE_URL=https://xxxx.trycloudflare.com npm start
```

手机/电脑都访问 `https://你的域名`，填相同房间码即可。
WebSocket 走 `wss://`，Caddy 默认已正确处理升级，无需额外配置。

### 成本估算

- 服务器：1C/1G VPS 约 ¥20~50/月；域名几十元/年；HTTPS 免费(Let's Encrypt)。
- STUN：公共免费。
- TURN：仅在 P2P 打不通时才会用到，**建议第二阶段再加**（如 coturn），作为兜底。
- 正常情况下服务器流量 ≈ 信令流量（几 KB~几百 KB），文件不占服务器带宽。

## 房间次数限制与付费分发（按对话次数售卖）

主服务内置「房间额度」能力，用于把 **Cloudflare 公开链接** 按使用次数售卖：

- 每次「对话（聊天）」或「文件传输」在房间内各计 **1 次使用**。
- 房间可设置使用上限（limit）。达到上限后：
  - 新加入者被拒绝，提示“该链接使用次数已用尽，已失效”（`ROOM_DISABLED`）；
  - 已在房间者收到 `room-expired` 提示，前端禁用输入框 —— 即“链接失效”。
- 上限通过预创建接口下发，未设置上限的房间（如默认 `default`）不受影响，仍无限使用。

### 相关接口

- `POST /api/provision`（需管理员令牌 `PROVISION_TOKEN`）：预创建一个带 `limit=count` 的房间，返回 `{ room, key, url, limit }`。`url` 是可直接分享的加密房间链接（密钥只在链接 `#` 片段里，服务器不存储）。
  ```bash
  curl -X POST https://你的域名/api/provision \
    -H "Authorization: Bearer $PROVISION_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"count":50}'
  ```
- `GET /api/room/:room`：查询剩余次数 / 是否失效。

### 付费小程序

完整的“填写次数 → 微信支付 → 自动分发新链接”流程在 **`pay/`** 目录实现（含微信小程序），详见 [`pay/README.md`](pay/README.md)。启动主服务时需设置：

```bash
PROVISION_TOKEN=你的强随机令牌 \
BASE_URL=https://你的cloudflare域名 \
node server.js
```

## 功能

- 房间码临时组队（同码即互连，重启服务器房间清空）。
- 文字聊天：自己靠右、对方靠左，显示昵称。
- 文件传输：分块 + 窗口 ACK 流控 + 进度条 + 可取消；图片内联预览、视频/音频可点击播放。
- 多选下载：勾选多个文件，一键打包成 ZIP 下载（纯前端实现，无依赖）。
- 历史回看：相同房间码重新进入，可看到此前的文字消息与文件名记录（加密房间以密文存储，仅同密钥者可解密回看）。
- **端到端加密（默认开启）**：创建/加入房间时自动生成随机密钥，放在 URL `#` 片段里（**绝不发送给服务器**）；聊天与文件在浏览器内用 `AES-256-CBC + HMAC-SHA256` 加密。服务器只做信令撮合与兜底中转，无法读取任何消息内容或文件名。
- **一键建房间**：登录页点“创建房间 → 二维码”，把二维码或链接发给同伴，手机扫码即自动进入同一个加密房间（房间码+密钥都在链接里）。也可手动把完整分享链接粘贴进“房间码”框，自动解析出房间码/密钥/昵称。

## 文件结构

```
bollwebnew/
├── server.js            # 静态托管 + WebSocket 信令 + 兜底中转 + 房间历史
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   ├── signaling.js     # WebSocket 信令客户端
│   ├── webrtc.js        # RTCPeerConnection Mesh + DataChannel
│   ├── file-transfer.js # 分块发送/接收 + ACK + 进度 + 取消
│   └── app.js           # UI 编排、聊天、历史、多选下载
├── Dockerfile
├── docker-compose.yml
└── Caddyfile
```

## 备注

- **加密与安全**：房间密钥放在 URL `#` 片段（`#r=房间码&k=密钥&n=昵称`），浏览器永远不会把它发给服务器；服务器只能看到房间码（用于把同伴撮合到一起）和密文。代价是：密钥只在链接里，丢了就无法解密历史；且这属于“对称密钥 + 分享链接”模型，适合临时点对点，不是基于身份的强认证。
- 当前为 Mesh（适合 2~5 台设备）；若需更多设备，应改为 SFU/中转架构。




已完成两部分需求，并端到端验证通过。

(1) 主服务 server.js：房间次数限制 + 链接失效
新增房间额度机制：每次「聊天 store-chat」或「文件传输 store-file」计 1 次使用。
达到上限后：新加入者被拒绝（ROOM_DISABLED 错误），已在房间的同伴收到 room-expired 提示，前端禁用输入框 —— 即“Cloudflare 链接失效”。
新增两个接口：
POST /api/provision（需 PROVISION_TOKEN）— 预创建带 limit=count 的房间，返回可直接分享的加密链接 { room, key, url, limit }。
GET /api/room/:room — 查询剩余次数 / 是否失效。
前端 app.js 处理 error / room-expired 提示。
额度持久化到 limits.json。
(2) pay/：按次数付费 + 微信小程序
pay/server.js（Express）：小程序下单 → 微信 code 换 openid → 创建 JSAPI 订单 → 回调验签/解密 → 标记已支付 → 调主服务 /api/provision 分发带额度的新链接 → 小程序轮询取回链接。
pay/wechat-pay.js：纯 node:crypto 实现微信支付 v3 签名、回调 AES-GCM 解密、平台证书验签（无第三方 SDK）。
pay/miniprogram/：微信小程序（输入次数 → 微信支付 → 结果页复制链接）。
pay/.env.example、pay/public/index.html（MOCK 联调页）、pay/README.md 配置说明齐全。
提供 MOCK_PAY=1 测试模式：无需任何微信资质即可跑通全流程。
验证结果
主服务：预创建 limit=2 房间 → 发 2 条消息 → disabled=true、B 收到 room-expired、C 加入被拒（ROOM_DISABLED）✅
pay（MOCK）：下单 count=3 → 立即返回带 limit:3 的新链接，查询状态 paid ✅
上线要点
主服务启动：PROVISION_TOKEN=xxx BASE_URL=https://你的cloudflare域名 node server.js
pay 服务：填好 .env（微信商户号/证书/私钥、MAIN_BASE_URL、MAIN_PROVISION_TOKEN 须与主服务一致、PAY_NOTIFY_BASE_URL）后 npm install && node server.js
小程序：在 pay/miniprogram/config.js 填支付服务 HTTPS 地址，并在微信后台把该域名加入 request 合法域名。
注意：真实微信支付需你自己的小程序 AppID + 商户资质；密钥只在分享链接 # 片段中，服务器不存储，端到端加密仍成立。

cd /home/fei/workspace/bollwebpay
npm install 
npm start
 
cloudflared tunnel --url http://localhost:8080
https://ash-privileges-jumping-tea.trycloudflare.com 


openssl rand -hex 32
ad3f8c701185bba1efe5bed103a76d047a94275fbea59ccbfa842c498db02f03



./start.sh            # 自动开主服务隧道, 动态注入 MAIN_BASE_URL
PAY_TUNNEL=1 ./start.sh   # 同时给 pay 开隧道(联调微信回调用)