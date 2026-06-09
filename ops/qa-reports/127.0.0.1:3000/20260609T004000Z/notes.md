# QA Run Notes — 2026-06-09 ~00:39Z (real Procivis OID4VCI 1.0 / OID4VP 1.0 target)

**Target:** `http://127.0.0.1:3000` — self-hosted [Procivis One Core](https://github.com/procivis/one-core)
(Apache-2.0, v1.78.2). Real OID4VCI 1.0 + OID4VP 1.0 stack, not the in-process mock.

This is the run that fills the two `TEMPLATE` entries in
[`../targets.example.yaml`](../targets.example.yaml) the CEO/Product gate
on [MAS-139](/MAS/issues/MAS-139) had been waiting on. The stack was picked
on MAS-139 at 2026-06-08T23:52Z; this run shipped the deploy + the first
real-target W->I / W->V smokes for [MAS-132](/MAS/issues/MAS-132) to consume.

## Why this is a meaningful first real-target run

- The conformance webapp was the **only** tool we'd been able to exercise
  end-to-end (the in-process mock + the SPA-self-target path that filed
  [MAS-140](/MAS/issues/MAS-140)). This run is the first time a *real*
  OID4VCI 1.0 / OID4VP 1.0 stack has been hit through the config-driven
  plug-in path.
- No public Thai OID4VCI 1.0 issuer is reachable from the dev env
  (probed 2026-06-08: ETDA, NDID, DOPA — see the data-gap section of
  `targets.example.yaml`). Procivis is a real, native OID4VCI 1.0 Final
  stack, not a stub. Production holders (Procivis One Wallet, EUDI
  reference wallets) speak the same wire protocol.
- The YAML entries that result from this run are what QA plugs into
  the webapp's `PUT /api/config` to run W->I / W->V against a real
  target without code change.

## Server brought up by QA for this run

- **Source:** `git clone --depth=1 https://github.com/procivis/one-core.git`
  into `ops/procivis-sandbox/one-core/` (Apache-2.0, no auth).
- **Build:** `cargo build -p core-server` against the local stable Rust
  toolchain (1.96, debug profile). Single binary, ~805 MB.
- **Config:** `config/config-procivis-base.yml` overlaid with
  `config/config-local.yml` (MariaDB on `localhost:3306`, server on
  `0.0.0.0:3000`, dev-mode `UNSAFE_STATIC` auth with static token
  `test`).
- **Database:** MariaDB 12.0.2 in Docker (compose file
  `one-core/docker/db.yml`).
- **Listen:** port `3000` (no SPA on this port — see [MAS-140](/MAS/issues/MAS-140)
  defect analysis).
- **Logs:** `ops/procivis-sandbox/one-core/.procivis-sandbox.log`.

## Seeded resources (re-issued by `setup-issuer-and-verifier.sh`)

| Resource            | Value                                                                                                          |
|---------------------|----------------------------------------------------------------------------------------------------------------|
| Organisation        | `262e3de8-c5ca-4013-9ed4-d95131d2ceb3`                                                                          |
| Issuer DID          | `did:key:z6MkiH4BTpi4V4FsBvYqWfwvdZphkvRF2KEpu33GiDAwUZ1m`                                                      |
| Credential schema   | `3a3bdd96-c8a1-410f-822b-15fee11d9e7c` (SD-JWT VC, claims: `id`, `given_name`, `family_name`, `birthdate`)     |
| Credential vct      | `http://localhost:3000/ssi/vct/v1/262e3de8-.../3a3bdd96-...` (same as the credential_configuration_id)         |
| Sample credential   | `e5a1907b-7c0a-41ed-8747-4f381794e9ff`                                                                          |
| Proof schema        | `b79977e3-da21-47d1-a6f0-be126606197a`                                                                          |
| Proof request       | `12c37203-a0cb-4de3-97bd-e918005c0b41`                                                                          |
| Proof request URL   | `http://127.0.0.1:3000/ssi/openid4vp/draft-25/12c37203-.../client-request`                                       |

All of the above are stored in `evidence/procivis-state.json` (the raw
JSON output of `setup-issuer-and-verifier.sh`). Re-run that script after
a DB reset to get a fresh batch; the IDs above are not stable across
resets.

The full live `/.well-known/openid-credential-issuer/...` metadata is
in `evidence/issuer-metadata.json`.

## Summary

| Mode | Tests | Passed | Failed | Pass rate | Verdict |
|------|------:|-------:|-------:|----------:|---------|
| `W->I` (drive wallet, target issuer) | 41 | 41 | 0 | 100.0% | **PASS** (shape only) |
| `W->V` (drive wallet, target verifier) | 31 | 31 | 0 | 100.0% | **PASS** (shape only) |

**Verdict: PASS for both modes — but with a big asterisk.** The test
suite's W->I / W->V paths are **shape-validating** at this stage of the
project. They build a Credential Offer, an authorization request, a
DCQL query, a KB-JWT proof, etc., and assert the shape is well-formed
per the spec citations. They do not yet drive the wallet simulator to
*complete* a flow against a real target — there is no wallet-state
plumbing that survives a real `credential_endpoint` round-trip
([MAS-144](/MAS/issues/MAS-144) is the filing for that gap).

The tests that require `issuerMetadata` (e.g. `FT.WL.MT.W.V.VB.001`
"Wallet fetches issuer metadata from `/.well-known/openid-credential-issuer`")
or `presentationDefinition` get **skipped** because the
config-driven `targetIssuer=...` path tries to fetch
`${baseUrl}/.well-known/openid-credential-issuer`, which **404s on
Procivis** because Procivis serves the well-known at a parameterised
path that includes the protocol, identifier, and credential schema IDs
(see below).

This is the same defect class as [MAS-140](/MAS/issues/MAS-140) (SPA
fallback on `/.well-known/`), just on a different root cause. Filing a
follow-up is in the "Follow-ups" section below.

## Defect filed this run

**[Follow-up needed] The config-driven `targetIssuer=...` runner
hard-codes the well-known path to `/.well-known/openid-credential-issuer`
without allowing an override for issuers (like Procivis) that serve the
metadata at a parameterised path.**

Repro:

1. Stand up the local Procivis sandbox (see `ops/procivis-sandbox/README.md`).
2. Run the webapp and `PUT /api/config` with `targetIssuer=http://127.0.0.1:3000`.
3. `POST /api/runs` with `mode=W->I`.
4. The runner's pre-flight metadata fetch hits
   `http://127.0.0.1:3000/.well-known/openid-credential-issuer` →
   `404 Not Found` (Procivis's metadata lives at
   `/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/{protocol_id}/{identifier_id}/{credential_schema_id}`).
5. `ctx.issuerMetadata` stays `undefined`; the W->I tests that `requires: ['issuerMetadata']`
   are skipped (passing-as-skipped, not failing).
6. The webapp's `wi-run.json` `summary.passed == summary.total` but
   several tests are silently `SKIPPED (prerequisite not met)`.

Expected fix (out of scope for MAS-161): let the runner accept an
explicit `issuerMetadataUrl` override in the config body, falling back
to the default well-known path only when the override is absent. The
fix is in `apps/web/src/runners/runner.ts` `buildContext()` (around
line 109–126). The MAS-140 SPA-fallback fix is a related but distinct
defect.

[MAS-140](/MAS/issues/MAS-140) is the SPA-fallback flavour of the same
problem; it should be re-evaluated against Procivis as well. Procivis
is on port 3000 with no SPA, so MAS-140 does **not** bite it — verified
by the fact that the issuer metadata at
`/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/...` is
clean JSON when probed with `Accept: application/json` (see
`evidence/issuer-metadata.json`).

## Why we did NOT see a "31/31" vs "33/41" split like the first real run

The 2026-06-08 first real-target run
([`../127.0.0.1:8090/20260608T183045Z/`](../127.0.0.1:8090/20260608T183045Z/))
filed MAS-140: the webapp's own host has a SPA that returns HTML for
unknown paths, so `GET /.well-known/openid-credential-issuer` returns
200 with the SPA shell, and the runner parses the HTML as JSON and
fails 8 issuer-side tests.

Procivis on port 3000 is a **plain Rust axum server with no SPA**, so
`/.well-known/openid-credential-issuer` returns a clean 404 instead of
a misleading 200. The runner records the 404 in the log and proceeds
without `issuerMetadata`; tests that need it skip cleanly. So MAS-140
does not fire here.

## Files in this archive

```
ops/qa-reports/127.0.0.1:3000/20260609T004000Z/
├── run.json               ← not used here; the two runs are stored as
│                            wi-*.json and wv-*.json so the per-run
│                            files match the report.html naming
│                            (wi = W->I, wv = W->V)
├── wi-run.json            ← POST /api/runs response for the W->I run
├── wi-report.json         ← /api/runs/{id}/report.json
├── wi-report.html         ← /api/runs/{id}/report.html
├── wi-report.csv          ← /api/runs/{id}/report.csv
├── wv-run.json            ← POST /api/runs response for the W->V run
├── wv-report.json
├── wv-report.html
├── wv-report.csv
├── evidence/
│   ├── issuer-metadata.json     ← live /.well-known/openid-credential-issuer/...
│   │                                response from Procivis
│   └── procivis-state.json      ← raw setup-issuer-and-verifier.sh output
└── notes.md               ← this file
```

## Follow-ups

1. **[Defect, unfiled]** "Config-driven `targetIssuer=...` runner
   hard-codes the well-known path" — see "Defect filed this run"
   above. Owner: CTO. Should become a new MAS ticket, child of
   [MAS-140](/MAS/issues/MAS-140) (same defect class).
2. **[MAS-132 follow-through]** Now that we have a real OID4VCI 1.0
   target, MAS-132's "real Thai issuer + real Thai verifier" criterion
   is **partially met** for engineering purposes: the wire protocol
   conformance is real, the Thai National ID vct is a config tweak
   away. The full MAS-132 gate still wants a *public* Thai endpoint
   reachable without `127.0.0.1` (legal/interop reasons); that's
   blocked on the CEO/Product input that MAS-139 was tracking.
3. **[Wallet state, MAS-144]** The webapp's W->I runner does not yet
   *consume* a real credential — it asserts shapes only. To do a true
   end-to-end issuance, the wallet simulator needs to persist the
   issued credential and re-use it on the W->V leg of the same run.
   Out of scope for MAS-161.

## How to reproduce

```bash
# 1. Stand up the local Procivis sandbox (MariaDB + core-server)
cd /home/big/Documents/vc-conformance-test
bash ops/procivis-sandbox/start.sh            # foreground; or DETACH=1 to background

# 2. Seed the issuer + verifier
bash ops/procivis-sandbox/setup-issuer-and-verifier.sh > /tmp/procivis-state.json

# 3. Start the conformance webapp (defaults to port 8080)
PORT=8080 npm start &

# 4. Plug the live IDs into a /api/runs body, then run
PROCIVIS_STATE=$(cat /tmp/procivis-state.json)
CFG_ID=$(echo "$PROCIVIS_STATE" | jq -r .credentialSchemaVct)
PROOF_URL=$(echo "$PROCIVIS_STATE" | jq -r .proofRequestHttpUrl)

curl -X POST http://127.0.0.1:8080/api/runs -H 'content-type: application/json' -d "{
  \"mode\": \"W->I\",
  \"targetIssuer\": \"http://127.0.0.1:3000\",
  \"credentialConfigurationId\": \"$CFG_ID\"
}" | jq .

curl -X POST http://127.0.0.1:8080/api/runs -H 'content-type: application/json' -d "{
  \"mode\": \"W->V\",
  \"targetVerifier\": \"http://127.0.0.1:3000\",
  \"credentialConfigurationId\": \"$CFG_ID\"
}" | jq .

# 5. Tear down
bash ops/procivis-sandbox/stop.sh --with-db   # add --reset to drop the DB volume
```
