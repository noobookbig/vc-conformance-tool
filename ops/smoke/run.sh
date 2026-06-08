#!/usr/bin/env bash
#
# End-to-end smoke test for the conformance test webapp.
#
# Starts the server in the background, exercises all four cross-modes via
# the REST API, downloads a report, and tears down.
#
# Usage:  bash ops/smoke/run.sh
#
# Exits non-zero if any mode fails or the server doesn't come up.

set -euo pipefail

cd "$(dirname "$0")/../.."

PORT="${PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"
LOG="/tmp/conformance-smoke.log"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> starting server (logs: $LOG)"
PORT="$PORT" npm start > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for health
for i in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
    echo "    server up after ${i}s"
    break
  fi
  sleep 1
done

if ! curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
  echo "FAIL: server did not become healthy"
  tail -50 "$LOG" || true
  exit 1
fi

# Helper: run one mode and report pass/fail
run_mode() {
  local mode="$1"
  local extra="${2:-}"
  local body
  if [[ -n "$extra" ]]; then
    body=$(printf '{"mode":"%s","credentialConfigurationId":"ThaiNationalID"%s}' "$mode" "$extra")
  else
    body=$(printf '{"mode":"%s","credentialConfigurationId":"ThaiNationalID"}' "$mode")
  fi
  local resp
  resp=$(curl -fsS -X POST "$BASE/api/runs" -H "content-type: application/json" -d "$body")
  local total passed
  total=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])")
  passed=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['passed'])")
  local runId
  runId=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
  echo "==> $mode  ${passed}/${total} passed  runId=$runId"
  # Download the JSON + HTML reports to confirm they work
  curl -fsS "$BASE/api/runs/$runId/report.json" -o "/tmp/conformance-smoke-${mode//[^a-zA-Z]/_}.json"
  curl -fsS "$BASE/api/runs/$runId/report.html" -o "/tmp/conformance-smoke-${mode//[^a-zA-Z]/_}.html"
  if [[ "$passed" != "$total" ]]; then
    echo "FAIL: $mode did not pass 100%"
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); [print('  -', x['id'], '|', x['message'][:90]) for x in r['results'] if not x['pass']]"
    return 1
  fi
}

run_mode "I->W"
run_mode "V->W"
run_mode "W->I"
run_mode "W->V"

echo "==> all four cross-modes passed"
echo "Reports saved to:"
ls -1 /tmp/conformance-smoke-*.{json,html} 2>/dev/null || true
