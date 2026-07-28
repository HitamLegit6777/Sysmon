#!/usr/bin/env bash
# Launch the SysMon release server fully detached.
set -u
PORT="${1:-8177}"
cd /root/sysmon || exit 1
pkill -f "release/sysmon --port ${PORT}" 2>/dev/null
sleep 0.5
setsid nohup ./target/release/sysmon --port "${PORT}" >/tmp/sm.log 2>&1 < /dev/null &
CHILD=$!
disown "$CHILD" 2>/dev/null || true
echo "server pid=$CHILD port=${PORT}"
