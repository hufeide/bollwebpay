(base) fei@feigpu:~/workspace$ timeout 20 cloudflared tunnel --url http://localhost:8787 2>&1 | grep -iE "trycloudflare\.com|1015|429|created"
2026-09-25T01:15:15Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
2026-09-25T01:15:15Z INF Requesting new quick Tunnel on trycloudflare.com...
quick tunnel provisioning failed with status 429: error code: 1015
(base) fei@feigpu:~/workspace$ dig NS abrdns.com

; <<>> DiG 9.18.1-1ubuntu1.2-Ubuntu <<>> NS abrdns.com
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 37424
;; flags: qr rd ad; QUERY: 1, ANSWER: 4, AUTHORITY: 0, ADDITIONAL: 0
;; WARNING: recursion requested but not available

;; QUESTION SECTION:
;abrdns.com.                    IN      NS

;; ANSWER SECTION:
abrdns.com.             0       IN      NS      ns73.cloudns.net.
abrdns.com.             0       IN      NS      ns71.cloudns.net.
abrdns.com.             0       IN      NS      ns72.cloudns.com.
abrdns.com.             0       IN      NS      ns74.cloudns.uk.

;; Query time: 250 msec
;; SERVER: 172.28.32.1#53(172.28.32.1) (UDP)
;; WHEN: Fri Sep 25 09:40:22 CST 2026
;; MSG SIZE  rcvd: 157

(base) fei@feigpu:~/workspace$ dig finai.abrdns.com

; <<>> DiG 9.18.1-1ubuntu1.2-Ubuntu <<>> finai.abrdns.com
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 46284
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0

;; QUESTION SECTION:
;finai.abrdns.com.              IN      A

;; Query time: 350 msec
;; SERVER: 172.28.32.1#53(172.28.32.1) (UDP)
;; WHEN: Fri Sep 25 09:40:43 CST 2026
;; MSG SIZE  rcvd: 34

(base) fei@feigpu:~/workspace$ cloudflared tunnel login
A browser window should have opened at the following URL:

https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2FleBClKjWeTmtOz45wTYFLV4TCXbpVkS_A6RRyYUyUk8%3D

If the browser failed to open, please visit the URL above directly in your browser.
2026-09-25T01:43:41Z INF You have successfully logged in.
If you wish to copy your credentials to a server, they have been saved to:
/home/fei/.cloudflared/cert.pem

(base) fei@feigpu:~/workspace$ cloudflared tunnel list
No tunnels were found for the given filter flags. You can use 'cloudflared tunnel create' to create a tunnel.
(base) fei@feigpu:~/workspace$ cloudflared tunnel create bollwebpay
Tunnel credentials written to /home/fei/.cloudflared/4b21c0ac-5efc-4c91-a547-86556636e040.json. cloudflared chose this file based on where your origin certificate was found. Keep this file secret. To revoke these credentials, delete the tunnel.

Created tunnel bollwebpay with id 4b21c0ac-5efc-4c91-a547-86556636e040
2026-09-25T01:44:25Z WRN Your version 2026.9.1 is outdated. We recommend upgrading it to 2026.9.3
(base) fei@feigpu:~/workspace$ cloudflared tunnel list
You can obtain more detailed information for each tunnel with `cloudflared tunnel info <name/uuid>`
ID                                   NAME       CREATED              CONNECTIONS 
4b21c0ac-5efc-4c91-a547-86556636e040 bollwebpay 2026-09-25T01:44:25Z             
(base) fei@feigpu:~/workspace$ mkdir -p ~/.cloudflared 
nano ~/.cloudflared/config.yml
(base) fei@feigpu:~/workspace$ ls -l ~/.cloudflared/
total 12
-r-------- 1 fei fei 175 Sep 25 09:44 4b21c0ac-5efc-4c91-a547-86556636e040.json
-rw------- 1 fei fei 282 Sep 25 09:43 cert.pem
-rw-r--r-- 1 fei fei 173 Sep 25 09:47 config.yml
(base) fei@feigpu:~/workspace$ curl http://localhost:8080
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>bollweb · P2P 消息与文件</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="login" class="login">
    <h1>bollweb</h1>
    <p class="sub">P2P 消息与文件传输 · 端到端加密 · 同一房间码自动互连</p>
    <div class="field"><label>昵称</label><input id="name" placeholder="你的昵称" /></div>
    <div class="field"><label>房间码</label><input id="room" placeholder="可粘贴完整分享链接自动解析" /></div>
    <div class="field"><label>密钥</label><input id="key" placeholder="分享链接里的密钥（端到端加密用）" /></div>
    <div class="btn-row">
      <button id="enter">进入房间</button>
      <button id="createRoom" class="btn-secondary">创建房间 → 二维码</button>
    </div>
    <p id="loginErr" class="err"></p>
    <p class="hintline">点“创建房间”生成二维码，手机扫码即可加入；消息用密钥端到端加密，服务器无法读取内容。</p>
  </div>

  <div id="app" class="app hidden">
    <aside class="sidebar">
      <div class="me">我: <span id="meName"></span></div>
      <div class="peers-title">在线同伴 (<span id="peerCount">0</span>)</div>
      <ul id="peerList" class="peer-list"></ul>
      <div class="status" id="status"></div>
    </aside>
    <main class="main">
      <div id="transfers" class="transfers"></div>
      <div id="dlBar" class="dl-bar">
        <label class="sel-all"><input type="checkbox" id="selAll" /> 全选</label>
        <button id="dlSelected">📦 下载选中 (0)</button>
      </div>
      <div id="messages" class="messages"></div>
      <div class="composer">
        <input id="msgInput" placeholder="输入消息，回车发送" />
        <button id="sendBtn">发送</button>
        <label class="filebtn">📎 文件<input type="file" id="fileInput" hidden /></label>
      </div>
    </main>
  </div>

  <div id="qrModal" class="modal hidden">
    <div class="modal-box">
      <h3>扫码加入房间</h3>
      <canvas id="qrCanvas" width="240" height="240"></canvas>
      <p id="qrUrl" class="qr-url"></p>
      <div class="btn-row">
        <button id="qrCopy">复制链接</button>
        <button id="qrClose" class="btn-secondary">关闭</button>
      </div>
      <p class="hintline">把此二维码/链接发给同伴，他们打开即自动进入同一加密房间。</p>
    </div>
  </div>

  <script>window.BASE_URL="https://cash-chelsea-symptoms-suspected.trycloudflare.com";</script><script>window.PAID_ONLY=1;</script>
  <script src="vendor/qrcode.js"></script>
  <script src="vendor/crypto-js.js"></script>
  <script src="crypto-e2e.js"></script>
  <script src="signaling.js"></script>
  <script src="webrtc.js"></script>
  <script src="file-transfer.js"></script>
  <script src="app.js"></script>
</body>
</html>
(base) fei@feigpu:~/workspace$ cloudflared tunnel run bollwebpay
2026-09-25T01:48:52Z INF Starting tunnel tunnelID=4b21c0ac-5efc-4c91-a547-86556636e040
2026-09-25T01:48:52Z INF Version 2026.9.1 (Checksum 03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc)
2026-09-25T01:48:52Z INF GOOS: linux, GOVersion: go1.26.8, GoArch: amd64
2026-09-25T01:48:52Z INF Settings: map[cred-file:/home/fei/.cloudflared/4b21c0ac-5efc-4c91-a547-86556636e040.json credentials-file:/home/fei/.cloudflared/4b21c0ac-5efc-4c91-a547-86556636e040.json]
2026-09-25T01:48:52Z INF cloudflared will not automatically update when run from the shell. To enable auto-updates, run cloudflared as a service: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/configure-tunnels/local-management/as-a-service/
2026-09-25T01:48:52Z INF Generated Connector ID: 0d6fb6ab-5440-4d00-855f-8b0ab6b02eb7
2026-09-25T01:48:52Z INF Initial protocol quic
2026-09-25T01:48:52Z INF ICMP proxy will use 172.28.32.133 as source for IPv4
2026-09-25T01:48:52Z INF ICMP proxy will use fe80::215:5dff:feb5:ddf0 in zone eth0 as source for IPv6
2026-09-25T01:48:52Z WRN The user running cloudflared process has a GID (group ID) that is not within ping_group_range. You might need to add that user to a group within that range, or instead update the range to encompass a group the user is already in by modifying /proc/sys/net/ipv4/ping_group_range. Otherwise cloudflared will not be able to ping this network error="Group ID 1000 is not between ping group 1 to 0"
2026-09-25T01:48:52Z WRN ICMP proxy feature is disabled error="cannot create ICMPv4 proxy: Group ID 1000 is not between ping group 1 to 0 nor ICMPv6 proxy: socket: permission denied"
2026/09/25 09:48:52 failed to sufficiently increase receive buffer size (was: 208 kiB, wanted: 7168 kiB, got: 416 kiB). See https://github.com/quic-go/quic-go/wiki/UDP-Buffer-Sizes for details.
2026-09-25T01:48:52Z INF ICMP proxy will use 172.28.32.133 as source for IPv4
2026-09-25T01:48:52Z INF ICMP proxy will use fe80::215:5dff:feb5:ddf0 in zone eth0 as source for IPv6
2026-09-25T01:48:52Z INF Starting metrics server on 127.0.0.1:20241/metrics
2026-09-25T01:48:52Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=0 event=0 ip=198.41.192.77
2026-09-25T01:48:52Z INF Registered tunnel connection connIndex=0 connection=92a54a6f-5028-4476-a2f0-7bc83c9faab2 event=0 ip=198.41.192.77 location=lax11 protocol=quic
2026-09-25T01:48:52Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=1 event=0 ip=198.41.200.53
2026-09-25T01:48:53Z INF Registered tunnel connection connIndex=1 connection=5bff2afb-65be-48b4-859c-83c7e99768d4 event=0 ip=198.41.200.53 location=lax01 protocol=quic
2026-09-25T01:48:53Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=2 event=0 ip=198.41.192.167
2026-09-25T01:48:54Z INF Registered tunnel connection connIndex=2 connection=750c8bf3-19e9-4cee-9828-0bd9026138ff event=0 ip=198.41.192.167 location=lax09 protocol=quic
2026-09-25T01:48:54Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=3 event=0 ip=198.41.200.73
2026-09-25T01:48:59Z INF +-------------------------------------------------------------------------------------+
2026-09-25T01:48:59Z INF |                               CONNECTIVITY PRE-CHECKS                               |
2026-09-25T01:48:59Z INF +-------------------------------------------------------------------------------------+
2026-09-25T01:48:59Z INF |  COMPONENT         TARGET                     STATUS  DETAILS                       |
2026-09-25T01:48:59Z INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully     |
2026-09-25T01:48:59Z INF |  DNS Resolution    region2.v2.argotunnel.com  PASS    DNS Resolved successfully     |
2026-09-25T01:48:59Z INF |  UDP Connectivity  region1.v2.argotunnel.com  PASS    QUIC connection successful    |
2026-09-25T01:48:59Z INF |  UDP Connectivity  region2.v2.argotunnel.com  PASS    QUIC connection successful    |
2026-09-25T01:48:59Z INF |  TCP Connectivity  region1.v2.argotunnel.com  PASS    HTTP/2 connection successful  |
2026-09-25T01:48:59Z INF |  TCP Connectivity  region2.v2.argotunnel.com  PASS    HTTP/2 connection successful  |
2026-09-25T01:48:59Z INF |  Cloudflare API    api.cloudflare.com:443     PASS    API is reachable              |
2026-09-25T01:48:59Z INF |                                                                                     |
2026-09-25T01:48:59Z INF |  SUMMARY: Environment is healthy. cloudflared will use 'quic' as primary protocol.  |
2026-09-25T01:48:59Z INF +-------------------------------------------------------------------------------------+
2026-09-25T01:48:59Z INF precheck component="DNS Resolution" details="DNS Resolved successfully" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region1.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="DNS Resolution" details="DNS Resolved successfully" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region2.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="UDP Connectivity" details="QUIC connection successful" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region1.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="UDP Connectivity" details="QUIC connection successful" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region2.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="TCP Connectivity" details="HTTP/2 connection successful" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region1.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="TCP Connectivity" details="HTTP/2 connection successful" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=region2.v2.argotunnel.com
2026-09-25T01:48:59Z INF precheck component="Cloudflare API" details="API is reachable" run_id=b845deea-965b-485e-85cb-4ef279b4b10f status=pass target=api.cloudflare.com:443
2026-09-25T01:48:59Z INF precheck complete hard_fail=false run_id=b845deea-965b-485e-85cb-4ef279b4b10f suggested_protocol=quic
2026-09-25T01:48:59Z WRN Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=3 event=0 ip=198.41.200.73
2026-09-25T01:48:59Z INF Retrying connection in up to 2s connIndex=3 event=0 ip=198.41.200.73
2026-09-25T01:49:00Z WRN Connection terminated error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=3
2026-09-25T01:49:16Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=3 event=0 ip=198.41.200.23
2026-09-25T01:49:17Z INF Registered tunnel connection connIndex=3 connection=fe2f2aea-a2ad-4f7e-badd-e663ae9d2c67 event=0 ip=198.41.200.23 location=lax01 protocol=quic