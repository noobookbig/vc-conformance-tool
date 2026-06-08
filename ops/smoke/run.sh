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
  # Download the JSON + HTML + CSV reports to confirm they work
  local slug="${mode//[^a-zA-Z]/_}"
  curl -fsS "$BASE/api/runs/$runId/report.json" -o "/tmp/conformance-smoke-${slug}.json"
  curl -fsS "$BASE/api/runs/$runId/report.html" -o "/tmp/conformance-smoke-${slug}.html"
  curl -fsS "$BASE/api/runs/$runId/report.csv"  -o "/tmp/conformance-smoke-${slug}.csv"
  # Sanity-check the CSV is non-empty and starts with our header
  if ! head -1 "/tmp/conformance-smoke-${slug}.csv" | grep -q '^runId,mode,startedAt,finishedAt,durationMs,'; then
    echo "FAIL: $mode CSV header is missing or malformed"
    head -2 "/tmp/conformance-smoke-${slug}.csv"
    return 1
  fi
  # /curl should return JSON with a runId; the items array may be empty
  # (a clean run has no failing tests), so we just check the shape.
  curl -fsS "$BASE/api/runs/$runId/curl" -o "/tmp/conformance-smoke-${slug}-curl.json"
  if ! python3 -c "import json,sys; d=json.load(open('/tmp/conformance-smoke-${slug}-curl.json')); assert d['runId']=='$runId' and isinstance(d['items'], list)"; then
    echo "FAIL: $mode /curl response shape wrong"
    cat "/tmp/conformance-smoke-${slug}-curl.json"
    return 1
  fi
  if [[ "$passed" != "$total" ]]; then
    echo "FAIL: $mode did not pass 100%"
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); [print('  -', x['id'], '|', x['message'][:90]) for x in r['results'] if not x['pass']]"
    return 1
  fi
  # Expose runId + mode for the cross-run diff step below.
  echo "$runId $mode" >> /tmp/conformance-smoke-runs.txt
}

# Diff two runs of the SAME mode to exercise /api/runs/:id/diff. Same mode
# means the test sets are identical, so the diff should report zero flips —
# a strong signal the route is wired correctly and the summary math is sane.
diff_two_runs() {
  # The smoke script appends "<runId> <mode>" pairs to runs.txt, in run order.
  # The first two I->W runs are the natural same-mode pair.
  local left right
  left=$(awk '$2=="I->W"{print $1}' /tmp/conformance-smoke-runs.txt | sed -n '1p')
  right=$(awk '$2=="I->W"{print $1}' /tmp/conformance-smoke-runs.txt | sed -n '2p')
  if [[ -z "$left" || -z "$right" ]]; then
    echo "SKIP: not enough runs of the same mode to diff"
    return 0
  fi
  echo "==> diff $left (left) ↔ $right (right)"
  curl -fsS "$BASE/api/runs/$right/diff?left=$left" -o /tmp/conformance-smoke-diff.json
  python3 - <<PY
import json
d = json.load(open('/tmp/conformance-smoke-diff.json'))
assert d['summary']['leftRunId']  == '$left',  d['summary']
assert d['summary']['rightRunId'] == '$right', d['summary']
assert isinstance(d['rows'], list) and d['rows'], 'diff rows must be non-empty'
flips = d['summary']['passToFail'] + d['summary']['failToPass'] + d['summary']['newFail'] + d['summary']['newPass'] + d['summary']['removed']
assert flips == 0, f'expected 0 flips on identical modes, got {flips}'
print(f'    diff OK: {d["summary"]}')
PY
  # Also verify the missing-left case returns 400 (so the route handles the no-pin UX correctly).
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/runs/$right/diff")
  if [[ "$code" != "400" ]]; then
    echo "FAIL: diff without ?left= should be 400, got $code"
    return 1
  fi
  echo "    diff missing-left returns 400 ✓"
  # And verify a non-existent left run returns 404 with a structured body.
  local fake="run-does-not-exist-xxxx"
  local body code2
  body=$(curl -s -w '\n%{http_code}' "$BASE/api/runs/$right/diff?left=$fake")
  code2=$(echo "$body" | tail -n1)
  if [[ "$code2" != "404" ]]; then
    echo "FAIL: diff with unknown left should be 404, got $code2"
    return 1
  fi
  if ! echo "$body" | head -n-1 | grep -q 'left_not_found'; then
    echo "FAIL: diff with unknown left should report left_not_found"
    return 1
  fi
  echo "    diff unknown-left returns 404 left_not_found ✓"
}

rm -f /tmp/conformance-smoke-runs.txt
# Run I->W twice so we have a same-mode pair for the diff step below.
run_mode "I->W"
run_mode "I->W"
run_mode "V->W"
run_mode "W->I"
run_mode "W->V"
diff_two_runs

echo "==> all four cross-modes passed"
echo "Reports saved to:"
ls -1 /tmp/conformance-smoke-*.{json,html,csv} 2>/dev/null || true
