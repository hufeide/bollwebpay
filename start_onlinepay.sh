#!/usr/bin/env bash
# 一键启动主服务(bollweb) + 支付服务(pay, 小程序微信支付) + 网页支付服务(payhtml, x402 去中心化支付)。
# 关键: cloudflared 临时隧道每次地址都不同, 无法写死到 .env —— 本脚本会自动启动
#       cloudflared、捕获动态公网地址, 再喂给主服务(生成公网房间链接)与 pay 服务。
#
# 用法:
#   ./start.sh                       # 自动检测 cloudflared 并开启隧道(若已安装)
#   TUNNEL=0 ./start.sh              # 关闭隧道(本地/已有固定域名时用)
#   TUNNEL=1 ./start.sh              # 强制开隧道(无 cloudflared 会提示)
#   PROVISION_TOKEN=xxx ./start.sh   # 命令行变量优先于 pay/.env
#   PAYHTML_PORT=8787 ./start.sh      # 网页支付服务(payhtml)端口, 默认 8787
#   PAYHTML_TUNNEL=1 ./start.sh       # 强制给网页购买页也开隧道(默认随 TUNNEL)
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

# ---- cloudflared 临时隧道(动态公网地址, 不写 .env) ----
# TUNNEL: auto(默认, 检测 cloudflared) | 1(强制) | 0(关闭)
TUNNEL="${TUNNEL:-auto}"
if [ "$TUNNEL" = "auto" ]; then
  command -v cloudflared >/dev/null 2>&1 && TUNNEL=1 || TUNNEL=0
fi
CFD_PID=""
PUBLIC_URL=""

echo "[start] 主服务  PORT=$MAIN_PORT  BASE_URL=$BASE_URL"
# 付费模式(默认开): 仅付费分发的房间可进入; 联调想放开时用 REQUIRE_PAID_ROOM=0 ./start.sh
PROVISION_TOKEN="$PROVISION_TOKEN" BASE_URL="$BASE_URL" PORT="$MAIN_PORT" REQUIRE_PAID_ROOM="${REQUIRE_PAID_ROOM:-1}" node "$ROOT/server.js" &
MAIN_PID=$!

if [ "$TUNNEL" = "1" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    echo "[start] 启动 cloudflared 隧道 -> http://localhost:$MAIN_PORT"
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

# pay 服务「内部」访问主服务: 同机优先 localhost(最快最稳, 根治「我的记录」因公网隧道抖动而卡顿)
# 跨机部署可用 PAY_MAIN_URL 显式指定主服务内网/公网地址
MAIN_BASE_URL="${PAY_MAIN_URL:-http://localhost:$MAIN_PORT}"
# 主服务公网地址: 仅用于生成房间链接(对外可达); 隧道地址优先, 否则回退到主服务 BASE_URL
MAIN_PUBLIC_BASE_URL="${PUBLIC_URL:-$BASE_URL}"

# ---- 可选: 给 pay 服务也开一条隧道(供微信发货推送回调; 默认随 TUNNEL) ----
# 注意: 临时隧道每次重启都变, 仅适合联调; 生产请在 .env 用固定域名填 PAY_NOTIFY_BASE_URL。
PAY_TUNNEL="${PAY_TUNNEL:-$TUNNEL}"
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
PAY_NOTIFY_BASE_URL="${PAY_NOTIFY_BASE_URL:-$PAY_PUBLIC_URL}"

# ---- 自动同步小程序 apiBase(pay/miniprogram/config.js) ----
# 临时隧道地址每次都变, 这里把 pay 服务当前对外地址写进小程序配置, 免去手动修改。
# 有隧道用隧道地址; 无隧道(本地调试)写 http://localhost:$PAY_PORT(WSL2 端口转发, 开发者工具可用)。
MP_CONFIG="$PAY_DIR/miniprogram/config.js"
if [ -f "$MP_CONFIG" ]; then
  MP_API_BASE="${PAY_PUBLIC_URL:-http://localhost:$PAY_PORT}"
  sed -i "s|apiBase:[[:space:]]*['\"][^'\"]*['\"]|apiBase: '$MP_API_BASE'|" "$MP_CONFIG"
  echo "[start] 小程序 apiBase 已更新 -> $MP_API_BASE"
fi

# ---- 网页支付服务 payhtml(Node 本地服务) ----
# 内部用 localhost 访问主服务(最快最稳); 房间链接用主服务公网地址(MAIN_PUBLIC_BASE_URL)。
# 可选: 给 payhtml 自己也开一条隧道, 让购买页也能公网访问(默认随 TUNNEL)。
PAYHTML_TUNNEL="${PAYHTML_TUNNEL:-$TUNNEL}"
CFD_PAYHTML_PID=""
PAYHTML_PUBLIC_URL=""
if [ "$PAYHTML_TUNNEL" = "1" ] && command -v cloudflared >/dev/null 2>&1; then
  echo "[start] 启动 cloudflared 隧道 -> http://localhost:$PAYHTML_PORT (payhtml 网页)"
  rm -f "$ROOT/.cfd_payhtml.log"
  cloudflared tunnel --url "http://localhost:$PAYHTML_PORT" --logfile "$ROOT/.cfd_payhtml.log" >/tmp/cfd_payhtml.out 2>&1 &
  CFD_PAYHTML_PID=$!
  for _i in $(seq 1 30); do
    PAYHTML_PUBLIC_URL="$(grep -hoE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$ROOT/.cfd_payhtml.log" /tmp/cfd_payhtml.out 2>/dev/null | head -1)"
    [ -n "$PAYHTML_PUBLIC_URL" ] && break
    sleep 1
  done
  [ -n "$PAYHTML_PUBLIC_URL" ] && echo "[start] payhtml 隧道公网地址: $PAYHTML_PUBLIC_URL" \
    || echo "[start] 警告: 未获取到 payhtml 隧道地址"
fi

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
