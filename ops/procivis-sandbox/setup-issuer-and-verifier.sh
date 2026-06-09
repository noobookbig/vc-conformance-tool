#!/usr/bin/env bash
#
# setup-issuer-and-verifier.sh — seed a local Procivis One Core instance
# with a Thai National ID issuer (SD-JWT VC over OID4VCI 1.0) and a matching
# verifier (proof request over OID4VP draft-25). Writes the live IDs and
# URLs to stdout as JSON for QA to consume and to a state file for repeated
# runs to re-use.
#
# Prereqs: Procivis core-server running on http://127.0.0.1:3000 with the
#          bearer auth token "test" (UNSAFE_STATIC dev profile). The
#          ops/procivis-sandbox/start.sh script brings it up that way.
#
# Usage:
#   bash ops/procivis-sandbox/setup-issuer-and-verifier.sh
#
# Output:
#   stdout: JSON { organisationId, keyId, identifierId, did,
#                  credentialSchemaId, credentialSchemaVct, credentialId,
#                  issuerMetadataUrl, proofSchemaId, proofRequestId,
#                  proofRequestShareUrl, proofRequestHttpUrl }
#   also written to: /tmp/procivis-sandbox-state.json
#   and:             ops/procivis-sandbox/.last-setup.json
#
# Idempotency:
#   If /tmp/procivis-sandbox-state.json exists AND the org / key / schema /
#   creds it points at still exist on the server, the script re-uses them
#   (no double-creation). Otherwise it builds from scratch.

set -euo pipefail

BASE="${PROCIVIS_BASE:-http://127.0.0.1:3000}"
AUTH="Authorization: Bearer test"
CT="content-type: application/json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="/tmp/procivis-sandbox-state.json"
LAST_FILE="$SCRIPT_DIR/.last-setup.json"

# Quick server liveness check — fail loud if core-server is not up.
if ! curl -fsS -H "Accept: application/json" "$BASE/api/config/v1" -H "$AUTH" >/dev/null 2>&1; then
  echo "FATAL: Procivis core-server is not reachable at $BASE (with bearer=test)." >&2
  echo "       Start it with: bash ops/procivis-sandbox/start.sh" >&2
  exit 1
fi

# Re-use existing state if it points at live resources.
reusable=0
if [[ -f "$STATE_FILE" ]]; then
  EXISTING_ORG=$(jq -r '.organisationId // empty' "$STATE_FILE")
  if [[ -n "$EXISTING_ORG" ]] && \
     curl -fsS "$BASE/api/organisation/v1?page=0&pageSize=100" -H "$AUTH" | \
       jq -e ".values[] | select(.id == \"$EXISTING_ORG\")" >/dev/null 2>&1; then
    reusable=1
  fi
fi

if [[ "$reusable" == "1" ]]; then
  echo "==> reusing existing Procivis resources from $STATE_FILE" >&2
  cat "$STATE_FILE"
  exit 0
fi

echo "==> creating Procivis organisation" >&2
ORG_ID=$(curl -fsS -X POST "$BASE/api/organisation/v1" -H "$AUTH" -H "$CT" -d '{}' | jq -r .id)

echo "==> creating EdDSA key (issuer signing key)" >&2
KEY_ID=$(curl -fsS -X POST "$BASE/api/key/v1" -H "$AUTH" -H "$CT" -d "$(jq -nc \
  --arg org "$ORG_ID" \
  '{keyType:"EDDSA", keyParams:{}, name:"issuer-signing-key", organisationId:$org, storageType:"INTERNAL", storageParams:{}}')" | jq -r .id)

echo "==> creating did:key identifier" >&2
IDENT_BODY=$(jq -nc \
  --arg org "$ORG_ID" \
  --arg key "$KEY_ID" \
  '{name:"issuer-did", organisationId:$org,
    did:{method:"KEY", keys:{
      authentication:[$key], assertionMethod:[$key], keyAgreement:[$key],
      capabilityInvocation:[$key], capabilityDelegation:[$key]}}}')
IDENT_RESP=$(curl -fsS -X POST "$BASE/api/identifier/v1" -H "$AUTH" -H "$CT" -d "$IDENT_BODY")
IDENTIFIER_ID=$(echo "$IDENT_RESP" | jq -r .id)
# The create response nests the DID object as .did.did; but the public DID
# string (did:key:...) is on the GET. Use GET to be safe.
DID=$(curl -fsS "$BASE/api/identifier/v1/$IDENTIFIER_ID" -H "$AUTH" | jq -r .did.did)
echo "    DID = $DID" >&2

echo "==> creating SD-JWT VC credential schema (ThaiNationalID)" >&2
SCHEMA_BODY=$(jq -nc \
  --arg org "$ORG_ID" \
  '{name:"ThaiNationalID", format:"SD_JWT_VC", organisationId:$org,
    claims:[
      {key:"id",          datatype:"STRING",     required:true},
      {key:"given_name",  datatype:"STRING",     required:true},
      {key:"family_name", datatype:"STRING",     required:true},
      {key:"birthdate",   datatype:"BIRTH_DATE",  required:true}
    ]}')
SCHEMA_RESP=$(curl -fsS -X POST "$BASE/api/credential-schema/v1" -H "$AUTH" -H "$CT" -d "$SCHEMA_BODY")
SCHEMA_ID=$(echo "$SCHEMA_RESP" | jq -r .id)
# vct (a URL like http://host/ssi/vct/v1/{org}/{schemaId}) is on the GET.
SCHEMA_DETAIL=$(curl -fsS "$BASE/api/credential-schema/v1/$SCHEMA_ID" -H "$AUTH")
VCT=$(echo "$SCHEMA_DETAIL" | jq -r .schemaId)
echo "    schemaId = $SCHEMA_ID  vct = $VCT" >&2

echo "==> issuing a sample credential (W->I smoke target)" >&2
SCHEMA_DETAIL=$(curl -fsS "$BASE/api/credential-schema/v1/$SCHEMA_ID" -H "$AUTH")
CLAIM_BLOCKS=$(echo "$SCHEMA_DETAIL" | jq -c '[
  {claimId: .claims[0].id, path: "id",          value: "1234567890123"},
  {claimId: .claims[1].id, path: "given_name",  value: "Somchai"},
  {claimId: .claims[2].id, path: "family_name", value: "Tester"},
  {claimId: .claims[3].id, path: "birthdate",   value: "1990-01-01"}
]')
CRED_BODY=$(jq -nc \
  --arg schemaId "$SCHEMA_ID" \
  --arg ident "$IDENTIFIER_ID" \
  --argjson claims "$CLAIM_BLOCKS" \
  '{credentialSchemaId:$schemaId, protocol:"OPENID4VCI_FINAL1",
    issuer:$ident, claimValues:$claims}')
CRED_ID=$(curl -fsS -X POST "$BASE/api/credential/v1" -H "$AUTH" -H "$CT" -d "$CRED_BODY" | jq -r .id)
echo "    credentialId = $CRED_ID" >&2

# Issuer metadata URL (the conformance webapp probes this).
ISSUER_MD_URL="$BASE/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/OPENID4VCI_FINAL1/$IDENTIFIER_ID/$SCHEMA_ID"
echo "==> probing issuer metadata at $ISSUER_MD_URL" >&2
curl -fsS -H "Accept: application/json" "$ISSUER_MD_URL" >/dev/null

echo "==> creating proof schema (verifier input)" >&2
CLAIM_IDS_OBJ=$(echo "$SCHEMA_DETAIL" | jq -c '[.claims[] | {id: .id, required: true}]')
PROOF_SCHEMA_BODY=$(jq -nc \
  --arg org "$ORG_ID" \
  --arg schemaId "$SCHEMA_ID" \
  --argjson claimIds "$CLAIM_IDS_OBJ" \
  '{name:"ThaiNationalID-Request", organisationId:$org,
    proofInputSchemas:[{credentialSchemaId:$schemaId, claimSchemas:$claimIds}]}')
PROOF_SCHEMA_ID=$(curl -fsS -X POST "$BASE/api/proof-schema/v1" -H "$AUTH" -H "$CT" -d "$PROOF_SCHEMA_BODY" | jq -r .id)

echo "==> creating proof request (verifier)" >&2
PROOF_BODY=$(jq -nc \
  --arg schemaId "$PROOF_SCHEMA_ID" \
  --arg ident "$IDENTIFIER_ID" \
  '{proofSchemaId:$schemaId, protocol:"OPENID4VP_DRAFT25",
    verifier:$ident, transport:["HTTP"]}')
PROOF_REQ_ID=$(curl -fsS -X POST "$BASE/api/proof-request/v1" -H "$AUTH" -H "$CT" -d "$PROOF_BODY" | jq -r .id)

echo "==> sharing proof request to get the holder-facing URL" >&2
SHARE_RESP=$(curl -fsS -X POST "$BASE/api/proof-request/v1/$PROOF_REQ_ID/share" -H "$AUTH" -H "$CT")
PROOF_SHARE_URL=$(echo "$SHARE_RESP" | jq -r .url)
# The HTTP form of the request URI (wallet simulators that don't follow
# custom URL schemes can hit this directly).
PROOF_HTTP_URL="$BASE/ssi/openid4vp/draft-25/$PROOF_REQ_ID/client-request"

STATE=$(jq -nc \
  --arg organisationId "$ORG_ID" \
  --arg keyId "$KEY_ID" \
  --arg identifierId "$IDENTIFIER_ID" \
  --arg did "$DID" \
  --arg credentialSchemaId "$SCHEMA_ID" \
  --arg credentialSchemaVct "$VCT" \
  --arg credentialId "$CRED_ID" \
  --arg issuerMetadataUrl "$ISSUER_MD_URL" \
  --arg proofSchemaId "$PROOF_SCHEMA_ID" \
  --arg proofRequestId "$PROOF_REQ_ID" \
  --arg proofRequestShareUrl "$PROOF_SHARE_URL" \
  --arg proofRequestHttpUrl "$PROOF_HTTP_URL" \
  '{organisationId:$organisationId, keyId:$keyId, identifierId:$identifierId, did:$did,
    credentialSchemaId:$credentialSchemaId, credentialSchemaVct:$credentialSchemaVct,
    credentialId:$credentialId, issuerMetadataUrl:$issuerMetadataUrl,
    proofSchemaId:$proofSchemaId, proofRequestId:$proofRequestId,
    proofRequestShareUrl:$proofRequestShareUrl, proofRequestHttpUrl:$proofRequestHttpUrl}')

echo "$STATE" > "$STATE_FILE"
echo "$STATE" > "$LAST_FILE"

echo "$STATE"
