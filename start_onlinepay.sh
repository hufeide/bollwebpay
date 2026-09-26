#!/usr/bin/env bash
# 一键启动主服务(bollweb) + 支付服务(pay, 小程序微信支付) + 网页支付服务(payhtml, x402 去中心化支付)。
# 关键: cloudflared 临时隧道每次地址都不同, 无法写死到 .env —— 本脚本会自动启动
#       cloudflared、捕获动态公网地址, 再喂给主服务(生成公网房间链接)与 pay 服务。
#
# 用法:
#   ./start_onlinepay.sh                    # 自动检测: 有命名隧道配置则 named, 否则临时隧道, 否则关闭
#   TUNNEL=named ./start_onlinepay.sh       # 强制使用命名隧道(固定域名, 见 ~/.cloudflared/config.yml)
#   TUNNEL=1 ./start_onlinepay.sh           # 强制开临时隧道(动态地址)
#   TUNNEL=0 ./start_onlinepay.sh           # 关闭隧道(本地/已有固定域名时用)
#   PROVISION_TOKEN=xxx ./start_onlinepay.sh# 命令行变量优先于 pay/.env
#   PAYHTML_PORT=8787 ./start_onlinepay.sh  # 网页支付服务(payhtml)端口, 默认 8787
#
# 说明:
#   - 主服务的 PROVISION_TOKEN 会持久化到 .provision_token, 避免重启后已付费房间失效。
#   - 若 pay/.env 存在则会被 source, 其中 MAIN_BASE_URL / MAIN_PROVISION_TOKEN 仅作兜底;
#     命令行传入的环境变量优先级最高。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
PAY_DIR="$ROOT/pay"
MAIN_PORT="${MAIN_PORT:-8080}"

# 记下命令行已显式设置的值(命令行优先于 .env)
_PRE_PROVISION="$PROVISION_TOKEN"
_PRE_BASE="$BASE_URL"
_PRE_MAIN_BASE="$MAIN_BASE_URL"
_PRE_MOCK="$MOCK_PAY"

# 读取 pay/.env(若存在), 用于对齐地址与令牌(.env 仅作兜底)
if [ -f "$PAY_DIR/.env" ]; then
  set -a
  . "$PAY_DIR/.env"
  set +a
fi

# 命令行显式传入的值覆盖 .env
[ -n "$_PRE_PROVISION" ] && PROVISION_TOKEN="$_PRE_PROVISION"
[ -n "$_PRE_BASE" ] && BASE_URL="$_PRE_BASE"
[ -n "$_PRE_MAIN_BASE" ] && MAIN_BASE_URL="$_PRE_MAIN_BASE"
[ -n "$_PRE_MOCK" ] && MOCK_PAY="$_PRE_MOCK"

# 主服务 PROVISION_TOKEN: 优先环境变量, 否则复用 MAIN_PROVISION_TOKEN, 否则持久化生成
if [ -z "$PROVISION_TOKEN" ]; then
  if [ -n "$MAIN_PROVISION_TOKEN" ]; then
    PROVISION_TOKEN="$MAIN_PROVISION_TOKEN"
  elif [ -f "$ROOT/.provision_token" ]; then
    PROVISION_TOKEN="$(cat "$ROOT/.provision_token")"
  else
    PROVISION_TOKEN="$(openssl rand -hex 32)"
    printf '%s' "$PROVISION_TOKEN" > "$ROOT/.provision_token"
    echo "[start] 已生成并保存 PROVISION_TOKEN 到 $ROOT/.provision_token（重启保持一致）"
  fi
fi

# 默认 BASE_URL: 命令行 > MAIN_BASE_URL > 本地。前端会用 location.origin 兜底, 这里给个本地默认。
BASE_URL="${BASE_URL:-${MAIN_BASE_URL:-http://localhost:$MAIN_PORT}}"
PAY_PORT="${PAY_PORT:-8081}"

# ---- payhtml(网页支付, Node 本地服务) 的专属配置 ----
# 读取 payhtml/.env 里的去中心化支付变量(PAY_TO / NETWORK / FACILITATOR_URL / MOCK)。
# 主服务的「公网地址」稍后在 MAIN_PUBLIC_BASE_URL 里喂给 payhtml, 这样它调主服务
# /api/provision 时生成的房间链接(即前端「你的专属链接」)就是公网可达地址, 而不是 localhost。
PAYHTML_DIR="$ROOT/payhtml"
PAYHTML_PORT="${PAYHTML_PORT:-8787}"
read_env_var() { [ -f "$1" ] || return 0; grep -E "^${2}=" "$1" | tail -1 | cut -d= -f2- | sed -E "s/^['\"]|['\"]$//g"; }
PAY_TO="${PAY_TO:-$(read_env_var "$PAYHTML_DIR/.env" PAY_TO)}"
NETWORK="${NETWORK:-$(read_env_var "$PAYHTML_DIR/.env" NETWORK)}"
FACILITATOR_URL="${FACILITATOR_URL:-$(read_env_var "$PAYHTML_DIR/.env" FACILITATOR_URL)}"
PAYHTML_MOCK="${PAYHTML_MOCK:-$(read_env_var "$PAYHTML_DIR/.env" MOCK)}"

# ---- Cloudflare 隧道 ----
# TUNNEL: auto(默认) | named(已配置命名隧道+固定域名) | 1(临时动态隧道) | 0(关闭)
# 命名隧道: 依赖 ~/.cloudflared/config.yml(由 setup_named_tunnel.sh 生成), 同时暴露
#           finaitech.dpdns.org(->8080) 与 pay.finaitech.dpdns.org(->8787)。
CF_DIR="${CF_DIR:-$HOME/.cloudflared}"
CF_CONFIG="${CF_CONFIG:-$CF_DIR/config.yml}"
CF_NAME="${CF_NAME:-bollweb}"
CF_HOST="${CF_HOST:-finaitech.dpdns.org}"
CF_PAYHTML_HOST="${CF_PAYHTML_HOST:-pay.finaitech.dpdns.org}"
TUNNEL="${TUNNEL:-auto}"
if [ "$TUNNEL" = "auto" ]; then
  if [ -f "$CF_CONFIG" ] && command -v cloudflared >/dev/null 2>&1; then
    TUNNEL=named
  elif command -v cloudflared >/dev/null 2>&1; then
    TUNNEL=1
  else
    TUNNEL=0
  fi
fi
CFD_PID=""
PUBLIC_URL=""

echo "[start] 主服务  PORT=$MAIN_PORT  BASE_URL=$BASE_URL"
# 付费模式(默认开): 仅付费分发的房间可进入; 联调想放开时用 REQUIRE_PAID_ROOM=0 ./start.sh
PROVISION_TOKEN="$PROVISION_TOKEN" BASE_URL="$BASE_URL" PORT="$MAIN_PORT" REQUIRE_PAID_ROOM="${REQUIRE_PAID_ROOM:-1}" node "$ROOT/server.js" &
MAIN_PID=$!

if [ "$TUNNEL" = "named" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    echo "[start] 启动命名隧道($CF_NAME) -> $CF_HOST (含 $CF_PAYHTML_HOST -> :$PAYHTML_PORT)"
    rm -f "$ROOT/.cfd_named.log"
    cloudflared tunnel --config "$CF_CONFIG" run >/tmp/cfd_named.out 2>&1 &
    CFD_PID=$!
    for _i in $(seq 1 25); do
      grep -q "Registered tunnel connection" /tmp/cfd_named.out 2>/dev/null && break
      sleep 1
    done
    PUBLIC_URL="https://$CF_HOST"
    PAYHTML_PUBLIC_URL="https://$CF_PAYHTML_HOST"
    echo "[start] 命名隧道公网地址: $PUBLIC_URL  (payhtml: $PAYHTML_PUBLIC_URL)"
  else
    echo "[start] 未找到 cloudflared 命令, 命名隧道启动失败"
  fi
elif [ "$TUNNEL" = "1" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    echo "[start] 启动 cloudflared 临时隧道 -> http://localhost:$MAIN_PORT"
    rm -f "$ROOT/.cfd.log"
    cloudflared tunnel --url "http://localhost:$MAIN_PORT" --logfile "$ROOT/.cfd.log" >/tmp/cfd.out 2>&1 &
    CFD_PID=$!
    for _i in $(seq 1 30); do
      PUBLIC_URL="$(grep -hoE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$ROOT/.cfd.log" /tmp/cfd.out 2>/dev/null | head -1)"
      [ -n "$PUBLIC_URL" ] && break
      sleep 1
    done
    if [ -n "$PUBLIC_URL" ]; then
      echo "[start] 隧道公网地址: $PUBLIC_URL"
    else
      echo "[start] 警告: 未从 cloudflared 获取到公网地址, 房间链接将回退到 $BASE_URL"
    fi
  else
    echo "[start] 未找到 cloudflared 命令, 已跳过隧道(TUNNEL=1 但命令不存在)"
  fi
fi
PAYHTML_PUBLIC_URL="${PAYHTML_PUBLIC_URL:-${PUBLIC_URL:+$PUBLIC_URL/payhtml}}"

# pay 服务「内部」访问主服务: 同机优先 localhost(最快最稳, 根治「我的记录」因公网隧道抖动而卡顿)
# 跨机部署可用 PAY_MAIN_URL 显式指定主服务内网/公网地址
MAIN_BASE_URL="${PAY_MAIN_URL:-http://localhost:$MAIN_PORT}"
# 主服务公网地址: 仅用于生成房间链接(对外可达); 隧道地址优先, 否则回退到主服务 BASE_URL
MAIN_PUBLIC_BASE_URL="${PUBLIC_URL:-$BASE_URL}"

# ---- 不再单独给 pay 开隧道 ----
# 两条 cloudflared quick 隧道并发常被关连接(ERR_CONNECTION_CLOSED)。pay 现已通过主隧道 /pay
# 反代到本机, 无需第二条隧道。如确需独立隧道, 把这行改成 PAY_TUNNEL="$TUNNEL" 即可。
PAY_TUNNEL=0
CFD_PAY_PID=""
PAY_PUBLIC_URL=""
if [ "$PAY_TUNNEL" = "1" ] && command -v cloudflared >/dev/null 2>&1; then
  echo "[start] 启动 cloudflared 隧道 -> http://localhost:$PAY_PORT (pay 回调)"
  rm -f "$ROOT/.cfd_pay.log"
  cloudflared tunnel --url "http://localhost:$PAY_PORT" --logfile "$ROOT/.cfd_pay.log" >/tmp/cfd_pay.out 2>&1 &
  CFD_PAY_PID=$!
  for _i in $(seq 1 30); do
    PAY_PUBLIC_URL="$(grep -hoE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$ROOT/.cfd_pay.log" /tmp/cfd_pay.out 2>/dev/null | head -1)"
    [ -n "$PAY_PUBLIC_URL" ] && break
    sleep 1
  done
  [ -n "$PAY_PUBLIC_URL" ] && echo "[start] pay 隧道公网地址: $PAY_PUBLIC_URL" \
    || echo "[start] 警告: 未获取到 pay 隧道地址"
fi
# 微信发货推送回调地址: 命令行/隧道优先, 否则沿用 .env 里的 PAY_NOTIFY_BASE_URL
# 注意: pay 已通过主隧道 /pay 反代, 这里把推送地址也指到主隧道 /pay(无隧道时回退到原逻辑)。
PAY_NOTIFY_BASE_URL="${PAY_NOTIFY_BASE_URL:-${PUBLIC_URL:+$PUBLIC_URL/pay}}"

# ---- 自动同步小程序 apiBase(pay/miniprogram/config.js) ----
# pay 服务不再单独开隧道(两条 quick 隧道并发常被关连接 -> ERR_CONNECTION_CLOSED),
# 而是经「主隧道 /pay」反代到本机 pay。有主隧道用 主隧道/pay; 无隧道(本地调试)写 http://localhost:$PAY_PORT。
MP_CONFIG="$PAY_DIR/miniprogram/config.js"
if [ -f "$MP_CONFIG" ]; then
  MP_API_BASE="${PUBLIC_URL:+$PUBLIC_URL/pay}"
  MP_API_BASE="${MP_API_BASE:-http://localhost:$PAY_PORT}"
  # config.js 里 apiBase 现在是运行时从存储读取, 真正的兜底常量叫 FALLBACK_API_BASE,
  # 故这里改的是 FALLBACK_API_BASE 那一行(原 apiBase: '...' 写法已不存在, 旧 sed 会静默失效)。
  sed -i "s|FALLBACK_API_BASE[[:space:]]*=[[:space:]]*['\"][^'\"]*['\"]|FALLBACK_API_BASE = '$MP_API_BASE'|" "$MP_CONFIG"
  echo "[start] 小程序 apiBase 已更新(兜底 FALLBACK_API_BASE) -> $MP_API_BASE"
fi

# ---- 网页支付服务 payhtml(Node 本地服务, 端口 $PAYHTML_PORT) ----
# 公网暴露由命名隧道统一负责: 子域名 $CF_PAYHTML_HOST -> localhost:$PAYHTML_PORT(见 config.yml)。
# 不再单独开 quick 隧道(易与主线隧道互相断连)。PAYHTML_PUBLIC_URL 已在上方隧道块赋值。
CFD_PAYHTML_PID=""

echo "[start] 网页支付服务 payhtml: 内部 MAIN_BASE_URL=http://localhost:$MAIN_PORT  对外 MAIN_PUBLIC_BASE_URL=${MAIN_PUBLIC_BASE_URL:-$BASE_URL}  PORT=$PAYHTML_PORT"
cd "$PAYHTML_DIR"
MAIN_BASE_URL="http://localhost:$MAIN_PORT" \
MAIN_PUBLIC_BASE_URL="${MAIN_PUBLIC_BASE_URL:-$BASE_URL}" \
MAIN_PROVISION_TOKEN="$PROVISION_TOKEN" \
PAY_TO="$PAY_TO" NETWORK="$NETWORK" FACILITATOR_URL="$FACILITATOR_URL" MOCK="$PAYHTML_MOCK" \
PORT="$PAYHTML_PORT" \
node src/server.node.js &
PAYHTML_PID=$!
cd "$ROOT"

# 把主服务公网地址写入 payhtml 的 Cloudflare Worker 部署变量(若已部署到 cf, 本地无需)
if [ -n "$PUBLIC_URL" ]; then
  echo "[start] 部署 payhtml(Cloudflare Workers)时, 用以下公网地址设置变量, 「你的专属链接」即为公网可达:"
  echo "        cd payhtml && wrangler vars set MAIN_BASE_URL '$PUBLIC_URL' && \\"
  echo "        wrangler vars set MAIN_PUBLIC_BASE_URL '$PUBLIC_URL' && wrangler vars set MAIN_PROVISION_TOKEN '$PROVISION_TOKEN'"
  [ -n "$PAYHTML_PUBLIC_URL" ] && echo "[start] payhtml 网页已通过命名隧道暴露: $PAYHTML_PUBLIC_URL"
else
  echo "[start] 部署 payhtml(Cloudflare Workers)时: MAIN_BASE_URL / MAIN_PUBLIC_BASE_URL 填主服务固定公网域名, MAIN_PROVISION_TOKEN 同上。"
fi

echo "[start] 支付服务 PAY_PORT=$PAY_PORT  MAIN_BASE_URL=$MAIN_BASE_URL  PAY_NOTIFY_BASE_URL=${PAY_NOTIFY_BASE_URL:-'(未设置)'}"
cd "$PAY_DIR"
MAIN_BASE_URL="$MAIN_BASE_URL" MAIN_PUBLIC_BASE_URL="$MAIN_PUBLIC_BASE_URL" MAIN_PROVISION_TOKEN="$PROVISION_TOKEN" PAY_PORT="$PAY_PORT" PAY_NOTIFY_BASE_URL="$PAY_NOTIFY_BASE_URL" node server.js &
PAY_PID=$!

cleanup() {
  echo "[start] 关闭服务..."
  [ -n "$CFD_PID" ] && kill "$CFD_PID" 2>/dev/null || true
  [ -n "$CFD_PAY_PID" ] && kill "$CFD_PAY_PID" 2>/dev/null || true
  [ -n "$CFD_PAYHTML_PID" ] && kill "$CFD_PAYHTML_PID" 2>/dev/null || true
  kill "$MAIN_PID" "$PAY_PID" "$PAYHTML_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait
