#!/usr/bin/env bash
#
# start.sh — bring up the local Procivis One Core sandbox.
#
# Brings up:
#   * MariaDB (Docker, port 3306) via docker/db.yml
#   * core-server (prebuilt binary, port 3000) with the local config overlay
#
# Idempotent: safe to re-run while the server is up; it will refuse to
# double-start and print a hint to use stop.sh.
#
# Usage:
#   bash ops/procivis-sandbox/start.sh
#
# Environment overrides:
#   PORT                 core-server port (default 3000)
#   SKIP_BUILD=1         skip the cargo build (use the last build's binary)
#   SKIP_DB=1            skip the MariaDB bring-up
#   DETACH=1             start the server detached and return immediately
#
# Files written:
#   one-core/.procivis-sandbox.pid   PID of the running core-server
#   one-core/.procivis-sandbox.log   live log of core-server (when DETACH=1)

set -euo pipefail

cd "$(dirname "$0")"
SANDBOX_DIR="$(pwd)"
ONE_CORE_DIR="$SANDBOX_DIR/one-core"
PID_FILE="$ONE_CORE_DIR/.procivis-sandbox.pid"
LOG_FILE="$ONE_CORE_DIR/.procivis-sandbox.log"
PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"
BIN="$ONE_CORE_DIR/target/debug/core-server"

if [[ ! -d "$ONE_CORE_DIR" ]]; then
  echo "FATAL: $ONE_CORE_DIR not found. Clone Procivis One Core first:" >&2
  echo "       git clone --depth=1 https://github.com/procivis/one-core.git $ONE_CORE_DIR" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Procivis One Core is already running (pid $(cat "$PID_FILE"), port $PORT)."
  echo "Use stop.sh first if you want to restart."
  exit 0
fi

if [[ "${SKIP_DB:-0}" != "1" ]]; then
  echo "==> bringing up MariaDB via docker/db.yml"
  (cd "$ONE_CORE_DIR" && docker compose -f docker/db.yml up -d mariadb)
  echo -n "==> waiting for MariaDB"
  for i in $(seq 1 60); do
    if (cd "$ONE_CORE_DIR" && docker compose -f docker/db.yml exec -T mariadb mariadb-admin --user=core --password=886eOqVMmlHsayu6Vyxw ping >/dev/null 2>&1); then
      echo "  ready after ${i}s"
      break
    fi
    echo -n "."
    sleep 1
  done
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building core-server (this may take 10-25 minutes on a clean tree)"
  (cd "$ONE_CORE_DIR" && cargo build -p core-server)
fi

if [[ ! -x "$BIN" ]]; then
  echo "FATAL: $BIN not built. Run without SKIP_BUILD=1 first" >&2
  echo "       (or run \`cargo build -p core-server\` in $ONE_CORE_DIR)." >&2
  exit 1
fi

if [[ "${DETACH:-0}" == "1" ]]; then
  echo "==> starting core-server detached (logs: $LOG_FILE)"
  : > "$LOG_FILE"
  (
    cd "$ONE_CORE_DIR"
    ONE_app__serverPort="$PORT" \
      setsid nohup ./target/debug/core-server \
        --config config/config-procivis-base.yml \
        --config config/config-local.yml \
        > "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )
  disown 2>/dev/null || true
else
  echo "==> starting core-server in foreground on $BASE (Ctrl-C to stop)"
  cd "$ONE_CORE_DIR"
  exec env ONE_app__serverPort="$PORT" \
    "$BIN" \
      --config config/config-procivis-base.yml \
      --config config/config-local.yml
fi

# Healthcheck loop (only reached in DETACH=1 mode).
# /api-docs/openapi.json is auth-free and unconditionally enabled.
echo -n "==> waiting for $BASE/api-docs/openapi.json"
for i in $(seq 1 90); do
  if curl -fsS "$BASE/api-docs/openapi.json" >/dev/null 2>&1; then
    echo "  ready after ${i}s"
    echo "OK"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo "  TIMEOUT"
echo "FATAL: core-server did not become healthy within 90s. Tail of log:" >&2
tail -50 "$LOG_FILE" >&2 || true
exit 1
