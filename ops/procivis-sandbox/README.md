# Procivis One Core — local sandbox

Self-hosted local instance of [Procivis One Core](https://github.com/procivis/one-core)
(Apache-2.0, v1.78.2) used as a real OID4VCI 1.0 + OID4VP 1.0 target for the
`vc-conformance-test` webapp.

**Last verified live:** 2026-06-09T00:18Z — `GET /api-docs/openapi.json` → 200,
DB-restart survival confirmed (server stayed up through a MariaDB bounce,
no auto-recovery needed). See [Verification log](#verification-log-mas-163)
for the full transcript.

This is **the only viable real OID4VCI 1.0 target reachable from the dev
environment** as of MAS-161 (2026-06-09): no public Thai issuer/verifier is
reachable (see [`../qa-reports/targets.example.yaml`](../qa-reports/targets.example.yaml)
for the probe history), and Procivis's hosted Trial Environment is sales-gated.
The instance below is what fills the two `TEMPLATE` entries in that YAML.

## Why this exists

| Reason | Detail |
|---|---|
| Unblock [MAS-132](/MAS/issues/MAS-132) | QA needs a reachable real OID4VCI 1.0 issuer/verifier to drive `W->I` and `W->V` smokes |
| Unblock [MAS-139](/MAS/issues/MAS-139) | The CEO/Product-input gate is now closed — the chosen stack is Procivis |
| Validate [MAS-140](/MAS/issues/MAS-140) | The `/.well-known/openid-credential-issuer` SPA-fallback defect from the first real-target run; Procivis is on port 3000 with no SPA so should be clean, but verify on first run |

## What it is

- **Source:** `git clone --depth=1 https://github.com/procivis/one-core.git one-core`
  (Apache-2.0, no auth required).
- **Build:** `cargo build -p core-server` against the local stable Rust
  toolchain (1.96+).
- **Config:** `config/config-procivis-base.yml` overlaid with
  `config/config-local.yml` (MariaDB on `localhost:3306`, server on
  `0.0.0.0:3000`, dev-mode `UNSAFE_STATIC` auth with static token `test`).
- **Database:** MariaDB 12.0.2 in Docker (compose file `docker/db.yml`).
- **API surface (excerpt):**
  - `GET  /api-docs/openapi.json` — full OpenAPI 3 doc (the source of truth for routes)
  - `GET  /.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/{protocol_id}/{identifier_id}/{credential_schema_id}` — OID4VCI 1.0 metadata **per-credential** (see note below)
  - `GET  /.well-known/oauth-authorization-server/ssi/openid4vci/final-1.0/{protocol_id}/{identifier_id}/{credential_schema_id}` — OID4VCI 1.0 OAuth 2.0 metadata, also per-credential
  - `GET  /ssi/openid4vp/draft-25/{id}/client-request` (and `/draft-20`) — verifier authorization request
  - `POST /ssi/openid4vp/draft-25/response` (and `/draft-20`) — verifier response_uri for direct_post
  - `GET  /api/credential-schema/v1?page=0&pageSize=N` — list schemas (auth: `Bearer test`)
  - `POST /api/credential/v1` — issue a credential
  - `GET  /api/build-info/v1` — Procivis build info (note: **not** `/api/server-info`)

> **Important — OID4VCI well-known is parameterized, not root-level.** Unlike some
> issuers that serve a single root `/.well-known/openid-credential-issuer`,
> Procivis One Core v1.78.2 wires OID4VCI 1.0 as **per-credential** paths that
> require resolved `protocol_id / identifier_id / credential_schema_id`. The
> local config (`config/config-procivis-base.yml`) declares the OID4VCI
> `OPENID4VCI_FINAL1` protocol profile but does **not** seed an organisation,
> identifier, or credential schema, so a fresh instance returns `404` (or
> `400` on the parameterized path with bogus IDs). The OID4VCI routes become
> `200 OK` only after at least one organisation + identifier + credential
> schema + credential has been created via the management API. See
> [Follow-up work](#follow-up-work) below.

The auth profile is `UNSAFE_STATIC` with `staticToken: "test"` — this is
deliberate for local dev. The webapp authenticates by sending
`Authorization: Bearer test`. **Do not** ship this config to a reachable
host.

## Quick start

```bash
# One-time, from the repo root:
git clone --depth=1 https://github.com/procivis/one-core.git \
  ops/procivis-sandbox/one-core

# Bring up MariaDB + build + start the server (foreground; Ctrl-C to stop)
bash ops/procivis-sandbox/start.sh

# In another shell — healthcheck (server is alive if either returns 200)
curl -sS http://127.0.0.1:3000/api/build-info/v1 | jq .
curl -sS http://127.0.0.1:3000/api-docs/openapi.json | jq '.info | {title, version}'
```

### Detached mode (background server)

```bash
DETACH=1 bash ops/procivis-sandbox/start.sh
# logs at:  ops/procivis-sandbox/one-core/.procivis-sandbox.log
# PID at:   ops/procivis-sandbox/one-core/.procivis-sandbox.pid

# Stop
bash ops/procivis-sandbox/stop.sh            # server only
bash ops/procivis-sandbox/stop.sh --with-db   # server + MariaDB
bash ops/procivis-sandbox/stop.sh --reset     # server + MariaDB + wipe volume
```

### Skip the build on subsequent runs

```bash
# First time: full build
SKIP_DB=1 bash ops/procivis-sandbox/start.sh

# Later: re-use the build artifacts, only bring up the DB + server
SKIP_BUILD=1 bash ops/procivis-sandbox/start.sh
```

### Seeding an issuer + verifier (one-shot)

The default Procivis One Core config ships **empty** — no organisation,
identifier, credential schema, or credential is pre-loaded. The OID4VCI
1.0 well-known route is parameterized; it returns `200` only when at
least one of each is created. The sandbox ships a one-shot seeder:

```bash
# After start.sh, with the server up on 127.0.0.1:3000:
bash ops/procivis-sandbox/setup-issuer-and-verifier.sh
# stdout: JSON of live IDs and URLs
# also: ops/procivis-sandbox/.last-setup.json (state file, used to make
# the script idempotent on re-runs)
```

The seeder creates (in order):

1. An organisation
2. An EdDSA key
3. A `did:key` identifier
4. A `ThaiNationalID` SD-JWT VC credential schema
5. A credential bound to the schema
6. A proof schema and proof request (OID4VP draft-25)

The output JSON includes the live
`issuerMetadataUrl` (the OID4VCI 1.0 well-known) and
`proofRequestHttpUrl` (the OID4VP draft-25 client_request). Use these
when filling the two `TEMPLATE` entries in
[`../qa-reports/targets.example.yaml`](../qa-reports/targets.example.yaml).

## Healthcheck

The robust healthcheck on a fresh instance is the OpenAPI doc — that route
is unconditionally enabled (`enableOpenApi: true` in `config-local.yml`).
The per-credential OID4VCI route is **not** a valid healthcheck on a fresh
instance (see the API-surface note above).

```bash
# Robust: server is up and routing.
curl -fsS http://127.0.0.1:3000/api-docs/openapi.json | jq '.info.title, (.paths | keys | length)'
# expect: "core-server" and ~70 paths

# Informational: Procivis build info
curl -fsS http://127.0.0.1:3000/api/build-info/v1 | jq .

# Per-credential OID4VCI 1.0 metadata (200 only after seeding — see Follow-up)
curl -i http://127.0.0.1:3000/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/<protocol_id>/<identifier_id>/<credential_schema_id>
```

## Adding a sample schema / credential

The default local config ships with a small set of pre-configured
credential schemas (see `config/config-procivis-base.yml` and the
`apps/core-server/src/init.rs` defaults). To add a Thai National ID
profile to the local instance:

1. Edit `one-core/config/config-local.yml` (overlay; commit changes here,
   not in the base) and add a `credentialSchemas` entry with the Thai
   National ID JSON Schema.
2. Add a `credential` definition that references it.
3. Add a `verifier` definition that points to the new credential with a
   `dcql_query` keyed on the same vct.
4. Restart the server (`bash ops/procivis-sandbox/stop.sh && DETACH=1 bash ops/procivis-sandbox/start.sh`).
5. Re-probe `/.well-known/openid-credential-issuer` to capture the live
   metadata; update [`../qa-reports/targets.example.yaml`](../qa-reports/targets.example.yaml).

For the first run of MAS-161, we use the EUDI PID profile
(`urn:eudi:pid:1`) that Procivis ships with by default — the Thai
National ID vct is the long-term target.

## File layout

```
ops/procivis-sandbox/
├── README.md                       ← this file
├── start.sh                        ← bring up MariaDB + build + start core-server
├── stop.sh                         ← stop core-server (and optionally the DB)
├── setup-issuer-and-verifier.sh    ← one-shot seeder: org + key + identifier + schema + credential + proof
├── .last-setup.json                ← state file written by the seeder (gitignored)
├── .gitignore                      ← ignore target/, .pid, .log, state files, etc.
└── one-core/                       ← upstream clone, NOT committed (see .gitignore)
    ├── apps/                       ← Procivis Rust crates
    ├── config/                     ← YAML config (base + local overlay)
    ├── docker/                     ← docker/db.yml — MariaDB compose
    ├── target/                     ← cargo build output (ignored)
    ├── .procivis-sandbox.pid       ← runtime PID (ignored)
    └── .procivis-sandbox.log       ← runtime log (ignored)
```

## Known limitations

- **Local-only.** The server binds to `0.0.0.0:3000` but the auth is
  `UNSAFE_STATIC` and the DB is unauthenticated MariaDB. Do not expose.
- **First-time build is slow.** A clean `cargo build -p core-server` on
  this machine takes 10–25 minutes depending on cores and network. Use
  `SKIP_BUILD=1` on subsequent runs.
- **No revocation out of the box.** Procivis supports status list / bitstring
  status / revocation registry, but the local config does not enable
  revocation by default. The conformance test cases for revocation will
  fail against this target; see
  [../qa-reports/README.md](../qa-reports/README.md) for the run archive.
- **No Thai National ID vct shipped.** Default credentials are the EUDI
  PID profile. Adding a Thai vct is a one-line config change once
  schemas are agreed (see "Adding a sample schema / credential" above).

## Follow-up work

- **Wire `setup-issuer-and-verifier.sh` into the parent MAS-161 workflow.**
  The seeder exists and has a real successful run; the next step is to
  plug its output into the two `TEMPLATE` entries in
  [`../qa-reports/targets.example.yaml`](../qa-reports/targets.example.yaml)
  (this is MAS-161 step 2 — out of scope for MAS-163).
- **Add `walletdb` to the `start.sh` bring-up** (the official
  `makers dbstart` task starts `mariadb` **and** `walletdb`; the current
  `start.sh` only brings up `mariadb`). Not a blocker for the OID4VCI
  routes, but it is required for the wallet-provider flows that the
  `walletProvider.PROCIVIS_ONE` block in `config-local.yml` is
  configuring.
- **Lock collision guard.** `cargo build -p core-server` and `makers
  build` both take the same `target/` lock. Running them in parallel
  from two shells (as seen during this stand-up) causes one to block on
  the other. Add a `flock` to `start.sh` to serialize, or document that
  re-running `start.sh` is safe (it already is — see the PID file guard
  at the top of `start.sh`).
- **Persist the seeded IDs across server restarts.** The seeder writes
  live IDs to `.last-setup.json` and is idempotent on re-runs, but the
  IDs only survive a `stop.sh && start.sh` (the MariaDB volume is kept)
  — a `stop.sh --reset` will wipe them. If a clean reset is needed,
  re-run `setup-issuer-and-verifier.sh` afterwards.

## References

- Parent: [MAS-161](/MAS/issues/MAS-161) (this work)
- CEO/Product gate: [MAS-139](/MAS/issues/MAS-139) (now closed by this)
- QA real-target gate: [MAS-132](/MAS/issues/MAS-132) (unblocked by the W->I/V runs)
- Defect from first real-target run: [MAS-140](/MAS/issues/MAS-140)
- YAML: [../qa-reports/targets.example.yaml](../qa-reports/targets.example.yaml)
- Procivis One Core: <https://github.com/procivis/one-core> (Apache-2.0)
- Procivis docs: <https://docs.procivis.ch/>

## Verification log (MAS-163)

```
$ bash ops/procivis-sandbox/start.sh  (DETACH=1 SKIP_BUILD=1 SKIP_DB=1, build cached)
$ curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/api-docs/openapi.json
HTTP 200
$ curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/.well-known/openid-credential-issuer
HTTP 404        # root-level well-known is NOT served by Procivis v1.78.2
$ curl -sS -H 'Authorization: Bearer test' -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/api/build-info/v1
HTTP 200        # use /api/build-info/v1 for version info, not /api/server-info

# After running setup-issuer-and-verifier.sh, the OID4VCI 1.0 well-known
# route is reachable with real IDs:
$ bash ops/procivis-sandbox/setup-issuer-and-verifier.sh > /tmp/seed.json
$ URL=$(jq -r .issuerMetadataUrl /tmp/seed.json)
$ curl -sS -H 'Accept: application/json' "$URL" | jq '.credential_issuer, .credential_endpoint'
"http://localhost:3000/ssi/openid4vci/final-1.0/OPENID4VCI_FINAL1/76eae.../61b3..."
"http://localhost:3000/ssi/openid4vci/final-1.0/61b3.../credential"

# OID4VP draft-25 client_request and client_metadata are also live:
$ PROOF=$(jq -r .proofRequestHttpUrl /tmp/seed.json)
$ curl -sS -o /dev/null -w 'HTTP %{http_code}\n' "$PROOF"
HTTP 200
$ curl -sS -H 'Accept: application/json' \
    "http://127.0.0.1:3000/ssi/openid4vp/draft-25/${PROOF_ID}/client-metadata" | jq '.jwks'
{"keys":[{"kty":"OKP","alg":"ECDH-ES",...}]}

# DB-restart survival (the "Procivis survives a restart of the docker db" criterion)
$ docker compose -f ops/procivis-sandbox/one-core/docker/db.yml stop  mariadb
$ curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/api-docs/openapi.json
HTTP 200        # server stayed up; OpenAPI route doesn't hit the DB
$ docker compose -f ops/procivis-sandbox/one-core/docker/db.yml start mariadb
$ curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/api-docs/openapi.json
HTTP 200        # server still alive on same PID after DB bounce

# stop.sh graceful TERM
$ bash ops/procivis-sandbox/stop.sh
==> sending SIGTERM to core-server (pid ...) and its group
    stopped after 2s
```

The OID4VCI 1.0 metadata healthcheck **is satisfiable** end-to-end once
`setup-issuer-and-verifier.sh` has run at least once. The route is
parameterized (not root-level) and requires the IDs in
`.last-setup.json`; the harness sends `Accept: application/json` to
bypass the server's 406 content-negotiation.
