#!/bin/sh
#
# Entrypoint for the v2 conformance test container.
#
# Why this exists:
#   - CLI mode writes reports to $OUT_DIR (default /out). Operators
#     bind-mount a host directory at this path so the report
#     artefacts are visible outside the container.
#   - The container runs as the non-root `app` user (uid 100 in the
#     default node:22-alpine base). The host's bind-mount point may
#     be owned by a different uid (e.g. a developer on a workstation
#     where syslog=100, app=1000). A naive chown in the container is
#     a no-op on the host when the uids happen to collide.
#   - The least-surprising contract is: $OUT_DIR is the operator's
#     shared surface, so the entrypoint makes it world-writable and
#     world-readable+executable. The CLI then writes reports that
#     are visible to the host user without further setup.
#
# Why not chown?
#   chown inside the container affects the host inode directly (no
#   userns remap in our setup), but a chown to `app:app` on the host
#   is useless when the operator's user is not 1000/1000. chmod 0777
#   is the honest contract: "anything you mount here is shared
#   between you and the container".
#
# Why not use the v0.1.0 entrypoint?
#   The v0.1.0 entrypoint assumes a persistent JSON store at a fixed
#   path inside the image and probes writability. The v2 server is
#   stateless (in-memory run store) and the only writable surface we
#   care about is $OUT_DIR. A dedicated wrapper keeps the v2 image
#   honest about its actual contract.
#
# Idempotent + safe in bare-metal too: when $OUT_DIR is already
# world-writable the chmod is a no-op and the exec proceeds.

set -eu

OUT_DIR="${OUT_DIR:-/out}"

# 1) Create the dir if it doesn't exist (idempotent under tmpfs).
mkdir -p "$OUT_DIR"

# 2) Make it world-writable so the host user can read the CLI reports
# after the container exits. The CLI is the only thing that writes
# here, and the reports are the operator's artefact, not secrets.
chmod 0777 "$OUT_DIR" 2>/dev/null || true

# 3) Probe that the target user can actually write. If not, bail with
# a clear error rather than letting the engine crash with EACCES
# mid-run. We probe via su-exec so the writability check matches the
# runtime identity.
if ! su-exec app:app sh -c ": > '$OUT_DIR/.write-probe'" 2>/dev/null; then
  echo "[entrypoint] FATAL: $OUT_DIR is not writable for app:app" >&2
  echo "[entrypoint] Mount a writable volume/tmpfs at this path." >&2
  exit 1
fi
rm -f "$OUT_DIR/.write-probe"

# 4) Hand off to the real CMD, dropping to the app user.
if [ "$(id -u)" = "0" ]; then
  exec su-exec app:app "$@"
else
  # Already non-root (e.g. bare-metal dev). Just exec.
  exec "$@"
fi
