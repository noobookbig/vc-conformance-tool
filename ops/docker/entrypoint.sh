#!/bin/sh
#
# Entrypoint for the conformance test webapp container.
#
# Why this exists (MAS-174 follow-up):
# The persistent run store at apps/web/data/runs.json is written by the
# non-root `app` user. The Dockerfile chowns the dir at build time, but
# docker-compose.yml mounts a tmpfs at that path for ephemeral storage,
# and a tmpfs lands as root — so the build-time chown is overwritten on
# container start and the first /api/runs POST crashes with EACCES.
#
# This wrapper runs as root, chowns the data dir to `app:app`, then
# `exec`s the real CMD as the `app` user via `su-exec` (Alpine ships
# su-exec, ~10KB, no extra deps). The node process never runs as root;
# only this small init step does, and only for the duration of one
# chown + exec.
#
# Idempotent + safe in bare-metal too (it skips silently when the dir
# is already fine, so dev workflows that just `node ...` work as before).

set -eu

DATA_DIR="${RUN_HISTORY_DIR:-/app/apps/web/data}"
APP_USER="${APP_USER:-app}"
APP_GROUP="${APP_GROUP:-app}"

# 1) Create the dir if it doesn't exist (idempotent under tmpfs).
mkdir -p "$DATA_DIR"

# 2) If the dir is not writable for the target user, chown it. We
# always do this when running as root, even if the dir *appears*
# writable (e.g. via a group-bit that happened to align), because the
# safe default is `app:app` and the cost is one stat call.
if [ "$(id -u)" = "0" ]; then
  chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" 2>/dev/null || true
fi

# 3) Probe that the target user can actually write (in case the chown
# failed for some reason — e.g. the dir is on a read-only mount). If
# not, bail with a clear error rather than letting the app crash with
# EACCES later.
if ! su-exec "$APP_USER:$APP_GROUP" sh -c ": > '$DATA_DIR/.write-probe'" 2>/dev/null; then
  echo "[entrypoint] FATAL: $DATA_DIR is not writable for $APP_USER:$APP_GROUP" >&2
  echo "[entrypoint] Mount a writable volume/tmpfs at this path or fix ownership." >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-probe"

# 4) Hand off to the real CMD, dropping to the app user.
if [ "$(id -u)" = "0" ]; then
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
else
  # Already non-root (e.g. bare-metal dev). Just exec.
  exec "$@"
fi
