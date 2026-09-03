#!/bin/bash
# 一次性切换脚本：等本轮回复送达后，把运行中的 1.3.1 原子替换为 1.4.0 并重启
ROOT="/Users/dragonplus/Documents/dragonplus/DeepseekHarnessApp"
NEW="$ROOT/release-build/mac-arm64/DSH Web.app"
DEST="$ROOT/release/mac-arm64/DSH Web.app"
LOG="$ROOT/release/swap-1.4.0.log"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 等待本轮对话回复送达（旧版退出 = 本会话的 web 后端退出）
sleep 40
log "=== 开始切换到 1.4.0：优雅退出旧版 ==="
osascript -e 'tell application "DSH Web" to quit' >/dev/null 2>&1

ok=""
for i in $(seq 1 20); do
  if ! pgrep -f "DeepseekHarnessApp/release/mac-arm64/DSH Web.app" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  log "优雅退出超时，发送 SIGTERM"
  pkill -TERM -f "DeepseekHarnessApp/release/mac-arm64/DSH Web.app" 2>/dev/null
  sleep 5
  pkill -KILL -f "DeepseekHarnessApp/release/mac-arm64/DSH Web.app" 2>/dev/null
fi
sleep 2

log "替换应用包 release/mac-arm64/DSH Web.app …"
rm -rf "$DEST"
if ! ditto "$NEW" "$DEST"; then
  log "ditto 失败，直接从 release-build 启动"
  open "$NEW"
  exit 0
fi

log "移动安装产物 (dmg/zip) 到 release/ …"
mv "$ROOT/release-build/"*.dmg "$ROOT/release-build/"*.zip "$ROOT/release-build/"*.blockmap "$ROOT/release/" 2>/dev/null

log "启动 1.4.0 …"
open "$DEST"

launched=""
for i in $(seq 1 20); do
  if pgrep -f "release/mac-arm64/DSH Web.app/Contents/MacOS/DSH Web$" >/dev/null 2>&1; then launched=1; break; fi
  sleep 1
done
if [ -n "$launched" ]; then
  log "✓ DSH Web 1.4.0 已启动"
else
  log "✗ 20 秒内未检测到新进程，请手动打开：open \"$DEST\""
fi
rm -rf "$ROOT/release-build"
