#!/usr/bin/env bash
# bollwebnew 一键部署脚本
#
# 用法:
#   ./deploy.sh                 # 仅用 Docker 启动(HTTP, 适合内网/LAN 直连测试)
#   ./deploy.sh caddy DOMAIN    # 同时用 Caddy 做 HTTPS 反代(自动签发 Let's Encrypt 证书)
#
# 说明:
#   - 服务端只做信令撮合与兜底中转, 正常情况不碰消息内容(端到端加密在浏览器内完成)。
#   - 公网部署务必用 HTTPS(第二个用法), 否则手机等设备的部分能力受限, 且分享链接的密钥也更安全。
#   - 需要 TURN 做更稳的跨 NAT 兜底时, 在 docker-compose.yml 里取消 ICE 注释并填入你的 TURN。
set -euo pipefail

cd "$(dirname "$0")"

build_and_up() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ 未检测到 docker，请先安装: https://docs.docker.com/get-docker/"
    exit 1
  fi
  echo "🐳 用 Docker 构建并启动 bollwebnew ..."
  docker compose up -d --build
  echo "✅ 已启动，本机访问: http://localhost:8080"
}

setup_caddy() {
  local domain="$1"
  if [ -z "$domain" ]; then
    echo "❌ 请指定域名: $0 caddy your-domain.com"
    exit 1
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    echo "❌ 未检测到 caddy，请先安装: https://caddyserver.com/docs/install"
    exit 1
  fi
  echo "🔐 配置 Caddy HTTPS 反代 -> $domain"
  cat > Caddyfile.gen <<EOF
$domain {
  reverse_proxy localhost:8080
}
EOF
  # 后台运行 Caddy; 用 nohup 避免脚本退出后被子进程信号影响
  nohup caddy run --config Caddyfile.gen --adapter caddyfile > caddy.log 2>&1 &
  sleep 2
  echo "✅ HTTPS 已就绪，访问: https://$domain  （手机/电脑填相同房间码即可互相连接）"
}

case "${1:-}" in
  caddy)
    build_and_up
    setup_caddy "${2:-}"
    ;;
  "")
    build_and_up
    ;;
  *)
    echo "用法: $0 [caddy DOMAIN]"
    exit 1
    ;;
esac
