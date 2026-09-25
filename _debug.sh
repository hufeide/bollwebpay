#!/usr/bin/env bash
# 调试脚本: 检查 bollweb + pay 服务、隧道、/pay 反代是否正常工作。
# 用法: bash /home/fei/workspace/bollwebpay/_debug.sh
R=/home/fei/workspace/bollwebpay
echo "===== 1) 本地 /pay 反代(主服务:8080 -> pay:8081) ====="
curl -s -m 5 "http://localhost:8080/pay/api/user/test"; echo "   <-- 期望 JSON(哪怕 known:false)"
echo
echo "===== 2) pay 直连(:8081) ====="
curl -s -m 5 "http://localhost:8081/api/user/test"; echo "   <-- 期望 JSON"
echo
echo "===== 3) 端口监听 ====="
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':8080|:8081' || echo "   未发现 8080/8081 监听"
echo
echo "===== 4) 相关进程 ====="
ps aux | grep -E 'cloudflared|server.js|node ' | grep -v grep || echo "   无相关进程"
echo
echo "===== 5) cloudflared 日志(末尾) ====="
tail -n 30 "$R/.cfd.log" 2>/dev/null || echo "   无 .cfd.log"
echo
echo "===== 6) config.js 当前 FALLBACK_API_BASE ====="
grep -n 'FALLBACK_API_BASE' "$R/pay/miniprogram/config.js"
echo
echo "===== 7) 磁盘上 start.sh 写出的 apiBase(若刚跑过) ====="
grep -n '小程序 apiBase 已更新' "$R/.cfd.log" 2>/dev/null || echo "   (日志里没有, 说明本次没跑 start.sh 或日志被清)"
echo
echo "===== 8) 此机 hostname ====="
hostname
