#!/usr/bin/env bash
#
# End-to-end smoke test for the v2 conformance test tool — server (UI) mode.
#
# What this script proves:
#   - The Docker image builds on a clean tree.
#   - The container starts in server mode (the default CMD) and serves:
#     - GET  /             -> the built SPA (index.html, 200)
#     - GET  /api/health   -> 200 JSON with service=conformance-v2
#     - POST /api/runs     -> 200 with a run id
#     - GET  /api/runs/:id -> 200, status=completed, report present
#   - The HTML report is downloadable from /api/runs/:id/report?format=html
#     and the JSON report from the same path with format=json.
#
# Pre-requisites:
#   - The SPA dist (apps/conformance-v2/web/dist/) is present at build time
#     so the image can mount it under /. This is produced by MAS-256
#     (vite build). On a fresh checkout run `npm run v2:web:build` first.
#
# Usage:  bash ops/smoke/v2-server.sh
#
# Environment:
#   IMAGE_TAG  default vc-conformance-v2:2.0.0
#   PORT       default 8089 (chosen to avoid clashing with the v0.1.0
#              image which defaults to 8080)
#
# Exit codes:
#   0  smoke passed
#   1  image build failed
#   2  server did not become healthy
#   3  API or SPA contract check failed
#   4  report download/parse failed

set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE_TAG="${IMAGE_TAG:-vc-conformance-v2:2.0.0}"
PORT="${PORT:-8089}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t v2-server-smoke.XXXXXX.log)"
CONTAINER_NAME="v2-server-smoke-$$"
REPORTS_DIR="$(mktemp -d -t v2-server-reports.XXXXXX)"
trap 'docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; rm -rf "$LOG" "$REPORTS_DIR"' EXIT

echo "==> building image $IMAGE_TAG"
docker build -f ops/docker-v2/Dockerfile -t "$IMAGE_TAG" .

echo "==> starting container in server mode on :$PORT (logs: $LOG)"
docker run -d --rm \
  --name "$CONTAINER_NAME" \
  -p "${PORT}:8080" \
  "$IMAGE_TAG" >/dev/null

# Wait for health. The default catalog has 317 cases; even with the
# in-process mock the loop must hit the API, run precheck, iterate
# 317 cases, and finalise the report. 90s is a comfortable upper bound
# on a warm cache; bump DOWN later if it gets faster, not up.
for i in $(seq 1 90); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
    echo "    server healthy after ${i}s"
    break
  fi
  sleep 1
done
if ! curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
  echo "FAIL: server did not become healthy within 90s"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -80 || true
  exit 2
fi

# 1) Health body shape
health=$(curl -fsS "$BASE/api/health")
echo "    /api/health: $health"
echo "$health" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('status') == 'ok', d
assert d.get('service') == 'conformance-v2', d
print('    health shape OK')
"

# 2) SPA is served at GET /. The server returns index.html and Vite's
#    built JS is referenced from it. We check the HTML title or a known
#    bundle reference, not the content of the bundle (which is hashed).
spa=$(curl -fsS "$BASE/" -o "$REPORTS_DIR/index.html" -w '%{http_code}')
if [[ "$spa" != "200" ]]; then
  echo "FAIL: GET / returned $spa; expected 200"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -40 || true
  exit 3
fi
if ! grep -qi '<!doctype html>\|<html' "$REPORTS_DIR/index.html"; then
  echo "FAIL: GET / did not return HTML"
  head -5 "$REPORTS_DIR/index.html" || true
  exit 3
fi
# A Vite build always references at least one hashed asset. If the
# served HTML is the v0.1.0 placeholder (503) we'll see the JSON body
# in plain text — that means the SPA wasn't mounted.
if grep -q 'ui_not_built' "$REPORTS_DIR/index.html"; then
  echo "FAIL: SPA is not mounted in the image (server returned 503 placeholder)"
  cat "$REPORTS_DIR/index.html"
  exit 3
fi
echo "    SPA served at GET /"

# 3) POST /api/runs with the in-process mock; assert a run id comes back.
run_id=$(curl -fsS -X POST "$BASE/api/runs" \
  -H 'content-type: application/json' \
  -d '{"config":"useMock: true\n"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "    POST /api/runs -> run id $run_id"
if [[ -z "$run_id" ]]; then
  echo "FAIL: POST /api/runs did not return a run id"
  exit 3
fi

# 4) Poll GET /api/runs/:id until status is terminal. The mock finishes
# 317 cases in a fraction of a second, but the response handler yields
# before flipping to 'running' so a curl in a tight loop is the
# honest way to wait.
for i in $(seq 1 60); do
  snap=$(curl -fsS "$BASE/api/runs/$run_id")
  status=$(echo "$snap" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  case "$status" in
    completed|aborted|failed) break ;;
  esac
  sleep 0.5
done
if [[ "$status" != "completed" ]]; then
  echo "FAIL: run did not complete (status=$status)"
  echo "$snap" | python3 -m json.tool | head -30 || true
  exit 3
fi
echo "    run completed in <= ${i} polls (status=$status)"

# 5) Reports downloadable from the same run id.
http_code_html=$(curl -s -o "$REPORTS_DIR/report.html" -w '%{http_code}' \
  "$BASE/api/runs/$run_id/report?format=html")
if [[ "$http_code_html" != "200" ]]; then
  echo "FAIL: report.html download returned $http_code_html"
  exit 4
fi
http_code_json=$(curl -s -o "$REPORTS_DIR/report.json" -w '%{http_code}' \
  "$BASE/api/runs/$run_id/report?format=json")
if [[ "$http_code_json" != "200" ]]; then
  echo "FAIL: report.json download returned $http_code_json"
  exit 4
fi
http_code_junit=$(curl -s -o "$REPORTS_DIR/report.junit.xml" -w '%{http_code}' \
  "$BASE/api/runs/$run_id/report?format=junit")
if [[ "$http_code_junit" != "200" ]]; then
  echo "FAIL: report.junit.xml download returned $http_code_junit"
  exit 4
fi

# 6) JSON report shape: full pass against the mock.
python3 - "$REPORTS_DIR/report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
s = r.get("summary", {})
assert s.get("failed", 0) == 0, f"expected zero failures: {s!r}"
assert s.get("passed", 0) > 0, f"expected at least one pass: {s!r}"
print(f"    report.json: passed={s['passed']} failed={s['failed']} skipped={s['skipped']}")
PY

echo "==> server smoke passed: health=ok, SPA served at /, run completed, all three report formats downloadable"
