#!/usr/bin/env bash
#
# End-to-end smoke test for the v2 conformance test tool — CLI mode.
#
# What this script proves:
#   - The Docker image builds on a clean tree (deps + SPA + runtime stages).
#   - The image can run the CLI as a subcommand of the default entrypoint.
#   - The in-process mock (useMock: true) runs the full catalog and writes
#     the three report files (json, junit.xml, html) to $OUT_DIR.
#   - The exit code is 0 (full pass against the mock).
#
# What this script does NOT prove (covered by v2-server.sh):
#   - The HTTP server boots and serves the API.
#   - The web SPA is mounted at GET / and the v2 server is the entrypoint.
#
# Usage:  bash ops/smoke/v2-cli.sh
#
# Environment:
#   IMAGE_TAG  default vc-conformance-v2:2.0.0 (overridable for local dev)
#   PORT       not used (CLI is non-listening). Default unused.
#
# Exit codes:
#   0  smoke passed
#   1  image build failed
#   2  container failed to start
#   3  report files missing
#   4  exit code was not 0 (the contract for "full pass against the mock")

set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE_TAG="${IMAGE_TAG:-vc-conformance-v2:2.0.0}"
OUT_DIR="$(mktemp -d -t v2-cli-smoke.XXXXXX)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "==> building image $IMAGE_TAG (this is the slowest step; cached layers are reused on rerun)"
docker build -f ops/docker-v2/Dockerfile -t "$IMAGE_TAG" .

cat > "$OUT_DIR/config.yaml" <<'YAML'
# In-process mock. The mock always passes; the goal of the smoke is to
# exercise the full report-writing path, not the per-case assertion.
useMock: true
YAML

echo "==> running CLI in container; reports -> $OUT_DIR"
# We override the default CMD to invoke the CLI as a subcommand of the
# node binary (the entrypoint already execs whatever we hand it under
# the `app` user). The config file is written to $OUT_DIR and read from
# there too, so the entrypoint's chown of /out to `app:app` covers it
# (a bind-mounted file in $OUT_DIR is owned by the host's user and
# would otherwise be EACCES for the non-root app user).
docker run --rm \
  -v "$OUT_DIR:/out" \
  "$IMAGE_TAG" \
  node --import tsx apps/conformance-v2/src/cli.ts run \
    --config /out/config.yaml \
    --catalog references/testcases \
    --out /out
rc=$?

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: CLI exited $rc; expected 0 (full pass against the mock)."
  exit 4
fi

for f in report.json report.junit.xml report.html; do
  if [[ ! -s "$OUT_DIR/$f" ]]; then
    echo "FAIL: expected $OUT_DIR/$f to exist and be non-empty."
    ls -la "$OUT_DIR" || true
    exit 3
  fi
done

# Sanity-check the JSON report: a full-pass run should report
# summary.passed == 317 (the v2 catalog size) and zero failures.
python3 - "$OUT_DIR/report.json" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    r = json.load(fh)
s = r.get("summary", {})
assert s.get("passed", 0) > 0, f"expected at least one pass: {s!r}"
assert s.get("failed", 0) == 0, f"expected zero failures: {s!r}"
print(f"    report.json: passed={s['passed']} failed={s['failed']} skipped={s['skipped']}")
PY

# Sanity-check the JUnit XML: it must contain a <testsuite> root and at
# least one <testcase> element.
if ! grep -q '<testsuite ' "$OUT_DIR/report.junit.xml"; then
  echo "FAIL: report.junit.xml is missing the <testsuite> root."
  head -5 "$OUT_DIR/report.junit.xml" || true
  exit 3
fi
if ! grep -q '<testcase ' "$OUT_DIR/report.junit.xml"; then
  echo "FAIL: report.junit.xml has no <testcase> elements."
  head -5 "$OUT_DIR/report.junit.xml" || true
  exit 3
fi

echo "==> CLI smoke passed: exit 0, report.{json,junit.xml,html} produced, all 317 cases passed against the in-process mock"
