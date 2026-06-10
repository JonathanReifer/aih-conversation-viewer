#!/usr/bin/env bash
set -euo pipefail

PID_FILE=/tmp/pai-conv-viewer.pid
LOG_FILE=/tmp/pai-conv-viewer.log
PORT=4446

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "[conv-viewer] already running (pid=$PID) on port $PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

echo "[conv-viewer] starting on port $PORT..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nohup bun "$SCRIPT_DIR/src/server.ts" > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
echo "[conv-viewer] started (pid=$PID) — http://localhost:$PORT"
