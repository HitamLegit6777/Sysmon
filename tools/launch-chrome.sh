#!/usr/bin/env bash
# Launch headless Chrome fully detached from the caller's process group so it
# survives the parent shell exiting. Writes the resolved binary + logs.
set -u
PORT="${1:-9222}"
LOG=/tmp/chrome.log

pkill -f "remote-debugging-port=${PORT}" 2>/dev/null
sleep 0.5

CHROME="$(ls "$HOME"/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1)"
[ -z "$CHROME" ] && CHROME="$(command -v google-chrome)"
echo "chrome=$CHROME" >"$LOG"

# Unique profile dir avoids "already running" singleton locks.
PROFILE="$(mktemp -d /tmp/chrome-prof.XXXXXX)"

setsid nohup "$CHROME" \
  --headless=new --disable-gpu --no-sandbox --no-first-run \
  --disable-dev-shm-usage \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="${PORT}" \
  --remote-debugging-address=127.0.0.1 \
  --hide-scrollbars --window-size=1600,1000 \
  about:blank >>"$LOG" 2>&1 &

CHILD=$!
disown "$CHILD" 2>/dev/null || true
echo "launched pid=$CHILD profile=$PROFILE"
