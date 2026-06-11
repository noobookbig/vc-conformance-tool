#!/usr/bin/env bash
# Refresh apps/conformance-v2/web/src/lib/data/case-roles.json from
# references/testcases/*.yaml. Run after editing or adding catalog cases.
#
# Maps each case's `eut:` to a PrimaryRole ('issuer' / 'verifier' /
# 'wallet') or 'multi' / 'resolver' for cross-role cases. The UI uses
# the JSON to render role badges on CaseRow without a server roundtrip.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/references/testcases"
OUT_FILE="${REPO_ROOT}/apps/conformance-v2/web/src/lib/data/case-roles.json"

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Source dir not found: ${SRC_DIR}" >&2
  exit 1
fi

tmp="$(mktemp)"
for f in "${SRC_DIR}"/*.yaml; do
  id="$(grep '^id:' "${f}" | sed 's/id: //')"
  eut="$(grep '^eut:' "${f}" | sed 's/eut: //')"
  case "${eut}" in
    issuer)   role="issuer" ;;
    verifier) role="verifier" ;;
    holder)   role="wallet" ;;
    wallet)   role="wallet" ;;
    multi)    role="multi" ;;
    resolver) role="resolver" ;;
    *)        role="${eut}" ;;
  esac
  printf '  "%s": "%s",\n' "${id}" "${role}"
done | sort > "${tmp}"

# Drop trailing comma on the last entry (sed in-place; the file always
# has at least one entry because the catalog is non-empty).
sed -i '$ s/,$//' "${tmp}"

mkdir -p "$(dirname "${OUT_FILE}")"
{
  echo "{"
  echo '  "_meta": {'
  echo '    "source": "references/testcases/ (v2.0 catalog)",'
  echo '    "regenerate": "Run scripts/refresh-case-roles.sh in repo root."'
  echo "  },"
  cat "${tmp}"
  echo ""
  echo "}"
} > "${OUT_FILE}"

rm -f "${tmp}"

# Sanity: print the role counts so a regen failure is visible in CI logs.
node -e "
const d = require('${OUT_FILE}');
delete d._meta;
const counts = {};
for (const r of Object.values(d)) counts[r] = (counts[r] || 0) + 1;
console.log('Wrote ${OUT_FILE}:', Object.keys(d).length, 'cases');
for (const [k, v] of Object.entries(counts).sort()) console.log('  ' + k + ': ' + v);
"
