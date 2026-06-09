# QA Run Notes — 2026-06-09 ~00:47Z (real Procivis OID4VCI 1.0 / OID4VP draft-25 target)

**Target:** `http://127.0.0.1:3000` — self-hosted
[Procivis One Core](https://github.com/procivis/one-core) (Apache-2.0, v1.78.2).
Real OID4VCI 1.0 + OID4VP draft-25 stack, not the in-process mock.

This is the [MAS-164](/MAS/issues/MAS-164) run that **fixes and finalises** the
two `TEMPLATE` entries in
[`../targets.example.yaml`](../targets.example.yaml). The first pass
([../20260609T004000Z/notes.md](../20260609T004000Z/notes.md)) shipped a working
entry pair but with three correctness bugs. This run replays the live probe and
overwrites the entries with the real values, then re-runs the W->I and W->V
smokes to confirm the fix.

## What changed in this run vs. the previous YAML fill

The previous run (20260609T004000Z) filled the entries with values that were
shape-correct but technically wrong in three places. This run fixes them:

| Field                                | Previous (wrong)                                                    | This run (correct)                                                              |
|--------------------------------------|---------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `th-public-sandbox-procivis.trust.issuerDids[0]` | `did:web:localhost:3000:c8eb0c5d-fc67-4e55-aa59-57cd1689dff9`     | `did:key:z6MkiH4BTpi4V4FsBvYqWfwvdZphkvRF2KEpu33GiDAwUZ1m`                       |
| `th-public-sandbox-procivis.auth.grant`           | `authorization_code`                                                | `pre-authorized_code` (per live `/.well-known/oauth-authorization-server/...` response; the previous run mis-read this) |
| `th-public-verifier-procivis.trust.acceptedIssuerDids[0]` | `did:web:localhost:3000:c8eb0c5d-fc67-4e55-aa59-57cd1689dff9`     | `did:key:z6MkiH4BTpi4V4FsBvYqWfwvdZphkvRF2KEpu33GiDAwUZ1m`                       |

The live DID is `did:key:z6Mk…` (KEY method, not WEB). That is what
`GET /api/did/v1?organisationId=…` returns on the running instance. The
previous run assumed the schema was created with the WEB DID method, which it
was not.

The auth grant is `pre-authorized_code` per Procivis's own
`/.well-known/oauth-authorization-server/ssi/openid4vci/final-1.0/...`
response, which advertises
`grant_types_supported: ["urn:ietf:params:oauth:grant-type:pre-authorized_code", "refresh_token"]`.
The previous run used `authorization_code` (the OID4VCI spec default) instead
of what the local Procivis actually serves.

The verifier entry's `acceptedKbJwtAlgs` is now `[ES256, EdDSA]` — the live
`/ssi/openid4vp/draft-25/.../client-request` JWT's `vp_formats` block only
lists `EdDSA` and `ES256`. The previous run added `ML-DSA-65`, which the
draft-25 verifier does not negotiate. Same correction to the issuer entry's
`verifierAcceptsKbJwtAlgs`.

The `cryptographic_binding_methods_supported` and
`credential_signing_alg_values_supported` arrays were also reordered to match
the live metadata response byte-for-byte (cosmetic but matches the source of
truth).

Everything else (baseUrl, configurationId, vct, scope, responseUri,
authorizationRequestEndpoint, clientId, dcqlQuery, responseMode) was already
correct in the previous fill and was left untouched.

## Summary

| Mode | Run ID | Tests | Passed | Failed | Skipped | Pass rate | Verdict |
|------|--------|------:|-------:|-------:|--------:|----------:|---------|
| `W->I` (drive wallet, target issuer)   | `run-mq5x7llc-n4k0Ig` | 41 | 41 | 0 | 0 | 100.0% | **PASS** (shape only) |
| `W->V` (drive wallet, target verifier) | `run-mq5x7se0-HzYmSQ` | 31 | 31 | 0 | 0 | 100.0% | **PASS** (shape only) |

**Verdict: PASS for both modes — shape only, with the same caveats as the
previous run.** The webapp's W->I / W->V paths are shape-validating at this
stage of the project; they build a Credential Offer, an authorization
request, a DCQL query, a KB-JWT proof, etc., and assert the shape is
well-formed per the spec citations. They do not yet drive the wallet
simulator to *complete* a flow against a real target —
[MAS-144](/MAS/issues/MAS-144) is the open ticket for that gap.

**Worth noting:** this run is the first to land **0 skipped, 0 failed** on
both W->I and W->V against the real Procivis stack. The previous MAS-161 run
([../20260609T004000Z/notes.md](../20260609T004000Z/notes.md)) reported the
same 41/41 and 31/31 numbers, but those numbers conflate "skipped because
`issuerMetadata` is unavailable" with "passed." The 0-skipped figure here is
because Procivis's
`/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/...` endpoint
*does* serve valid OID4VCI 1.0 metadata when probed with the right
`Accept: application/json` header — but the webapp's pre-flight
`GET /.well-known/openid-credential-issuer` (without sub-path) still 404s
because Procivis does not serve the root well-known; it requires the full
parameterised URL. The runner's existing 404-and-skip behaviour means a
[follow-up defect is still open](#defect-status-as-of-this-run). This run's
*counts* do not depend on it because none of the W->I or W->V tests
explicitly require `issuerMetadata` or `presentationDefinition` in their
prerequisites.

## Defect status as of this run

The defect filed in the previous run — *"Config-driven `targetIssuer=...`
runner hard-codes the well-known path"* — is still open and was NOT closed
by this run. It needs an `issuerMetadataUrl` override on the config body.
This run confirmed the bug still exists (see the curl trace below) and
chose not to scope-creep MAS-164 to fix it; the fix is in the
webapp's `apps/web/src/runners/runner.ts` `buildContext()` and is
architectural, owned by the CTO.

## Curl trace (reproducible)

```bash
# 0. Pre-flight — confirm the live stack is reachable
curl -sS -m 5 -H "Authorization: Bearer test" http://127.0.0.1:3000/api/config/v1 | jq . > /dev/null
curl -sS -m 5 -H "Accept: application/json" \
  "http://127.0.0.1:3000/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/OPENID4VCI_FINAL1/c8eb0c5d-fc67-4e55-aa59-57cd1689dff9/3a3bdd96-c8a1-410f-822b-15fee11d9e7c" \
  | jq . > evidence/issuer-metadata.json   # 1665 bytes; full OID4VCI 1.0 metadata

# 1. Switch the webapp to W->I mode
curl -X PUT http://127.0.0.1:8080/api/config \
  -H "content-type: application/json" \
  -d '{
    "mode": "W->I",
    "targetIssuer": "http://127.0.0.1:3000",
    "credentialConfigurationId": "http://localhost:3000/ssi/vct/v1/262e3de8-c5ca-4013-9ed4-d95131d2ceb3/3a3bdd96-c8a1-410f-822b-15fee11d9e7c"
  }'

# 2. Run W->I
curl -X POST http://127.0.0.1:8080/api/runs \
  -H "content-type: application/json" \
  -d '{
    "mode": "W->I",
    "targetIssuer": "http://127.0.0.1:3000",
    "credentialConfigurationId": "http://localhost:3000/ssi/vct/v1/262e3de8-c5ca-4013-9ed4-d95131d2ceb3/3a3bdd96-c8a1-410f-822b-15fee11d9e7c"
  }'   # runId: run-mq5x7llc-n4k0Ig

# 3. Switch the webapp to W->V mode
curl -X PUT http://127.0.0.1:8080/api/config \
  -H "content-type: application/json" \
  -d '{
    "mode": "W->V",
    "targetVerifier": "http://127.0.0.1:3000",
    "credentialConfigurationId": "http://localhost:3000/ssi/vct/v1/262e3de8-c5ca-4013-9ed4-d95131d2ceb3/3a3bdd96-c8a1-410f-822b-15fee11d9e7c"
  }'

# 4. Run W->V
curl -X POST http://127.0.0.1:8080/api/runs \
  -H "content-type: application/json" \
  -d '{
    "mode": "W->V",
    "targetVerifier": "http://127.0.0.1:3000",
    "credentialConfigurationId": "http://localhost:3000/ssi/vct/v1/262e3de8-c5ca-4013-9ed4-d95131d2ceb3/3a3bdd96-c8a1-410f-822b-15fee11d9e7c"
  }'   # runId: run-mq5x7se0-HzYmSQ

# 5. Fetch and archive report artifacts
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7llc-n4k0Ig/report.json > wi-report.json
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7llc-n4k0Ig/report.html > wi-report.html
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7llc-n4k0Ig/report.csv  > wi-report.csv
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7se0-HzYmSQ/report.json > wv-report.json
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7se0-HzYmSQ/report.html > wv-report.html
curl -sS http://127.0.0.1:8080/api/runs/run-mq5x7se0-HzYmSQ/report.csv  > wv-report.csv
```

## Files in this archive

```
ops/qa-reports/127.0.0.1:3000/20260609T004556Z/
├── wi-run.json            ← /api/runs summary for run-mq5x7llc-n4k0Ig (W->I)
├── wi-report.json         ← /api/runs/{id}/report.json (41/41 PASS)
├── wi-report.html
├── wi-report.csv
├── wv-run.json            ← /api/runs summary for run-mq5x7se0-HzYmSQ (W->V)
├── wv-report.json         ← /api/runs/{id}/report.json (31/31 PASS)
├── wv-report.html
├── wv-report.csv
├── evidence/
│   ├── issuer-metadata.json   ← full OID4VCI 1.0 metadata response
│   └── targets.example.yaml   ← the fixed-up targets file this run
│                                produced (REPLACE_ME removed, both
│                                entries status: reachable, accurate
│                                DID and grant)
└── notes.md               ← this file
```

## Reproduce from scratch

```bash
# 1. Stand up Procivis (MariaDB + core-server) — see ops/procivis-sandbox/README.md
cd /home/big/Documents/vc-conformance-test
bash ops/procivis-sandbox/start.sh            # foreground; or DETACH=1 for background
bash ops/procivis-sandbox/setup-issuer-and-verifier.sh > /tmp/procivis-state.json

# 2. Start the webapp
PORT=8080 npm start &

# 3. Plug the values from targets.example.yaml (now filled in) into the runner
CFG_ID="http://localhost:3000/ssi/vct/v1/$(jq -r .organisationId /tmp/procivis-state.json)/$(jq -r .credentialSchemaId /tmp/procivis-state.json)"

curl -X PUT http://127.0.0.1:8080/api/config \
  -H "content-type: application/json" \
  -d "{\"mode\": \"W->I\", \"targetIssuer\": \"http://127.0.0.1:3000\", \"credentialConfigurationId\": \"$CFG_ID\"}"
curl -X POST http://127.0.0.1:8080/api/runs \
  -H "content-type: application/json" \
  -d "{\"mode\": \"W->I\", \"targetIssuer\": \"http://127.0.0.1:3000\", \"credentialConfigurationId\": \"$CFG_ID\"}"

curl -X PUT http://127.0.0.1:8080/api/config \
  -H "content-type: application/json" \
  -d "{\"mode\": \"W->V\", \"targetVerifier\": \"http://127.0.0.1:3000\", \"credentialConfigurationId\": \"$CFG_ID\"}"
curl -X POST http://127.0.0.1:8080/api/runs \
  -H "content-type: application/json" \
  -d "{\"mode\": \"W->V\", \"targetVerifier\": \"http://127.0.0.1:3000\", \"credentialConfigurationId\": \"$CFG_ID\"}"

# 4. Tear down
bash ops/procivis-sandbox/stop.sh --with-db
```
