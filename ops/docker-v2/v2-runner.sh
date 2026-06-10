#!/bin/sh
#
# Entrypoint wrapper for the `runner` compose service in
# docker-compose.yml. Brings sane defaults for the v2 CLI so an
# operator can run:
#
#   docker compose run --rm runner                  # full suite
#   docker compose run --rm runner --role issuer    # issuer subset
#   ROLE=verifier docker compose run --rm runner    # pinned in compose
#
# Defaults assume the repo is bind-mounted at /workspace (the compose
# service does this) and that /out is the host-visible reports dir.
# When ROLE / INCLUDE_COVERAGE env vars are set they take precedence
# over an empty user-supplied role flag, so a CI matrix can drive
# `ROLE=issuer`, `ROLE=verifier`, `ROLE=wallet` without editing this
# file. The wrapper is idempotent and safe in bare-metal too: when the
# env vars and $@ are both empty the CLI runs the full default suite,
# matching the behaviour before MAS-292 landed.

set -eu

CONFIG="${CONFIG:-/workspace/references/configs/example.yaml}"
CATALOG="${CATALOG:-/workspace/references/testcases}"
OUT_DIR="${OUT_DIR:-/out}"

ARGS="--config ${CONFIG} --catalog ${CATALOG} --out ${OUT_DIR}"

if [ -n "${ROLE:-}" ]; then
  ARGS="${ARGS} --role ${ROLE}"
fi

if [ -n "${INCLUDE_COVERAGE:-}" ] && [ "${INCLUDE_COVERAGE}" != "false" ]; then
  ARGS="${ARGS} --include-coverage"
fi

# $@ is the user-supplied flags from `docker compose run --rm runner
# ARGS`. Append them last so an explicit `--role <r>` overrides the
# ROLE env var. Any pre-existing `--role` in $@ wins, which is what
# the operator expects when they spell the flag on the command line.
exec node --import tsx apps/conformance-v2/src/cli.ts run ${ARGS} "$@"
