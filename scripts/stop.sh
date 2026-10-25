#!/usr/bin/env bash
# Stop the YouTube video scheduler.
# Stops docker compose services (postgres volume kept) or kills the local
# Node processes started by scripts/start.sh.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

if docker info >/dev/null 2>&1 && [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
  echo "[stop] stopping docker compose services (postgres data volume kept)..."
  docker compose down
else
  echo "[stop] stopping local processes..."
  for pf in ./logs/api.pid ./logs/worker.pid; do
    [ -f "$pf" ] || continue
    pid="$(cat "$pf")"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      process="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$pf:$process" in
        *"api.pid:"*"src/server.js"*) kill "$pid" 2>/dev/null || true ;;
        *"worker.pid:"*"src/worker.js"*) kill "$pid" 2>/dev/null || true ;;
      esac
    fi
  done
  rm -f ./logs/api.pid ./logs/worker.pid
fi
echo "[stop] done. (logs remain in ./logs/)"
