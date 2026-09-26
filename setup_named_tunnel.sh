#!/usr/bin/env bash
# 一次性初始化「命名隧道(named tunnel)」: 创建隧道、写配置、绑定 DNS 到固定域名。
# 前置: 已执行 `cloudflared login` 并勾选包含目标域名的 zone(生成 ~/.cloudflared/cert.pem)。
#
# 用法:
#   ./setup_named_tunnel.sh                 # 隧道名 bollweb, 域名 finaitech.dpdns.org
#   ./setup_named_tunnel.sh mytunnel x.y.z  # 自定义隧道名与域名
set -e

CF_DIR="${CF_DIR:-$HOME/.cloudflared}"
mkdir -p "$CF_DIR"
TUNNEL_NAME="${1:-bollweb}"
HOST="${2:-finaitech.dpdns.org}"
ORIGIN="${CF_ORIGIN:-http://localhost:8080}"

if [ ! -f "$CF_DIR/cert.pem" ]; then
  echo "[setup] 未找到 $CF_DIR/cert.pem, 请先运行: cloudflared login" >&2
  exit 1
fi

# 若隧道已存在则复用, 否则创建(避免和 Cloudflare 上已有的 bollwebpay 等冲突)
if cloudflared tunnel list 2>/dev/null | awk 'NR>1{print $2}' | grep -qw "$TUNNEL_NAME"; then
  echo "[setup] 复用已有隧道: $TUNNEL_NAME"
else
  echo "[setup] 创建隧道: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
fi

UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" 'NR>1 && $2==n {print $1}')"
CRED="$CF_DIR/$UUID.json"
echo "[setup] 隧道 $TUNNEL_NAME -> $UUID"

# 绑定 DNS: 在 Cloudflare 上为 $HOST 创建指向该隧道的 CNAME
if cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST" 2>&1 | grep -qi "already"; then
  echo "[setup] DNS $HOST 已指向该隧道, 跳过"
else
  echo "[setup] 已为 $HOST 创建 DNS 路由"
fi

# 写配置(默认位置 ~/.cloudflared/config.yml, 被 start.sh 的 named 模式读取)
cat > "$CF_DIR/config.yml" <<EOF
tunnel: $UUID
credentials-file: $CRED
ingress:
  - hostname: $HOST
    service: $ORIGIN
  - service: http_status:404
EOF

echo "[setup] 配置已写入 $CF_DIR/config.yml"
echo "[setup] 完成。现在可用 ./start.sh (TUNNEL 默认 auto 会自动选 named) 启动服务。"
