#!/usr/bin/env bash
# Start the YouTube video scheduler (API + worker).
#
# Prefers Docker (docker compose), which gives you api + worker + postgres on
# port 3001. If Docker isn't running, it falls back to two local Node processes
# backed by a single SQLite file (see .env), also on port 3001.
#
# Real (non-dry-run) uploads: start with  DRY_RUN=false npm start
#   (or set DRY_RUN=false in .env). Dry-run is the safe default.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

mkdir -p logs

# Resolve the port: CLI/env > .env > 3001
if [ -z "${PORT:-}" ] && [ -f .env ]; then PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2-)"; fi
PORT="${PORT:-3001}"

if docker info >/dev/null 2>&1; then
  echo "[start] Docker available → starting api + worker + postgres (docker compose)..."
  docker compose up --build -d
  for _ in $(seq 1 40); do
    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
      echo "[start] ✅ API healthy: $(curl -s "http://localhost:${PORT}/api/health")"
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "[start] ❌ API did not become healthy; recent container logs:"
    docker compose logs --tail=80 api worker
    exit 1
  fi
  echo "[start]   connect a channel: http://localhost:${PORT}/api/auth/connect"
  echo "[start]   frontend:          http://localhost:${PORT}/"
else
  echo "[start] Docker daemon not available → starting local processes (SQLite, .env, port ${PORT})..."
  # stop any stale instances first
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
  sleep 1

  nohup node src/server.js > ./logs/api.log 2>&1 &
  echo $! > ./logs/api.pid
  nohup node src/worker.js > ./logs/worker.log 2>&1 &
  echo $! > ./logs/worker.pid
  echo "[start] API pid=$(cat ./logs/api.pid)  worker pid=$(cat ./logs/worker.pid)  (logs: ./logs/{api,worker}.log)"

  for _ in $(seq 1 20); do
    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
      echo "[start] ✅ API healthy: $(curl -s "http://localhost:${PORT}/api/health")"
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "[start] ❌ API did not become healthy; recent logs:"
    tail -n 80 ./logs/api.log ./logs/worker.log
    exit 1
  fi
  echo "[start]   connect a channel: http://localhost:${PORT}/api/auth/connect"
  echo "[start]   frontend:          http://localhost:${PORT}/"
  echo "[start]   real uploads? set DRY_RUN=false (env or .env) and restart."
fi
