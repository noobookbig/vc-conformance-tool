#!/usr/bin/env bash
#
# stop.sh — tear down the local Procivis One Core sandbox.
#
# Stops the core-server (graceful TERM, then KILL after 10s) and
# optionally brings the MariaDB container down.
#
# Usage:
#   bash ops/procivis-sandbox/stop.sh            # stop server only
#   bash ops/procivis-sandbox/stop.sh --with-db   # stop server + MariaDB
#   bash ops/procivis-sandbox/stop.sh --reset     # stop + drop the DB volume

set -euo pipefail

cd "$(dirname "$0")"
ONE_CORE_DIR="$(pwd)/one-core"
PID_FILE="$ONE_CORE_DIR/.procivis-sandbox.pid"
LOG_FILE="$ONE_CORE_DIR/.procivis-sandbox.log"

WITH_DB=0
RESET=0
for arg in "$@"; do
  case "$arg" in
    --with-db) WITH_DB=1 ;;
    --reset)   RESET=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "no PID file at $PID_FILE — core-server is not running (or was started outside start.sh)"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "core-server pid $pid is not alive; clearing stale PID file"
    rm -f "$PID_FILE"
    return 0
  fi
  # SIGTERM the whole process group (started with setsid).
  echo "==> sending SIGTERM to core-server (pid $pid) and its group"
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "    stopped after ${i}s"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 1
  done
  echo "==> still alive after 10s, sending SIGKILL"
  kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

stop_server

if [[ "$RESET" == "1" ]]; then
  echo "==> dropping MariaDB volume (--reset)"
  (cd "$ONE_CORE_DIR" && docker compose -f docker/db.yml down -v)
elif [[ "$WITH_DB" == "1" ]]; then
  echo "==> bringing MariaDB down (--with-db)"
  (cd "$ONE_CORE_DIR" && docker compose -f docker/db.yml down)
else
  echo "MariaDB left running (use --with-db to stop, --reset to wipe)."
fi

echo "OK"
