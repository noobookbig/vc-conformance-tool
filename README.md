# VC Conformance Test Webapp

A Dockerized, self-contained **OID4VCI 1.0 / OID4VP 1.0** conformance test tool for
the Thailand Verifiable Credential ecosystem.

It simulates a wallet end-to-end so issuers and verifiers (real or mock) can be
exercised automatically. The tool supports **four role cross-modes**:

1. **Issuer ↔ Wallet** — drive a target *Issuer* with our wallet simulator.
2. **Verifier ↔ Wallet** — drive a target *Verifier* with our wallet simulator.
3. **Wallet ↔ Issuer** — drive our wallet simulator with a target *Issuer*.
4. **Wallet ↔ Verifier** — drive our wallet simulator with a target *Verifier*.

The webapp produces an **in-app report** (table + filters) and lets the QA user
**download the report as JSON or HTML** for archiving.

Test cases are derived from the corrected Thailand VC OID4VCI / OID4VP 1.0
conformance testcase v2.0 — see `references/testcase-source.md` and
`references/design.md` for design notes.

## Quick start (v2.1.0)

Build and run the v2 image from local source with Docker Compose from the
repo root:

```bash
docker compose up -d --build
docker compose logs -f
# Server is on http://localhost:8080
# v2.1.0 added: entity-driven Suite form, per-case log + evidence
# download on Run/Report, version surfaced via /api/health.
```

This is the v2 release flow — same `docker compose up` shape the board used
on v0.1.0, but pointing at the v2 source. The compose file at
`docker-compose.yml` builds `ops/docker-v2/Dockerfile` on port `8080:8080`
with the same in-process mock issuer + verifier on the same origin as v0.1.0.
The `--build` flag forces a fresh build of the local Dockerfile; on a
warm Docker cache this is ~30s, on a clean cache it is a few minutes.
For the v0.1.0 dev compose, see `ops/docker/docker-compose.yml`.

v2.1.0 is **source-only** (the board picked `skip_ghcr` on [MAS-278](/MAS/issues/MAS-278)
at 13:42:07Z) — there is no GHCR image to pull. The image tag is
`vc-conformance-v2:2.1.0`. The shipped compose file exports
`CONFORMANCE_V2_VERSION=2.1.0` so the server's `/api/health` reports
`version: 2.1.0`.

If port `8080` is already in use (e.g. a v0.1.0 container is still running),
stop it first: `docker stop vc-conformance-test`.

### Run the v2 CLI by role (Issuer / Verifier / Wallet)

The same compose file exposes a one-shot `runner` service that runs the
v2 CLI in the container with the in-process mock. Pass `--role` through
`compose run` to drive a single role, or pin a role in the compose file
with the `ROLE` / `INCLUDE_COVERAGE` env vars. Default behaviour (no
role flag, no env) is unchanged: every case in the catalog runs.

```bash
# Full suite (no --role, no ROLE) — same as the v2 CLI on the host.
docker compose run --rm runner

# Issuer subset (90 of 317 live cases in the shipped catalog).
docker compose run --rm runner --role issuer

# Verifier subset, pinned in the compose file (CI matrix shape).
ROLE=verifier docker compose run --rm runner

# Wallet subset including coverage cases.
docker compose run --rm runner --role wallet --include-coverage

# Reports land in ./out/ on the host (report.json, report.junit.xml,
# report.html). The wrapper in ops/docker-v2/v2-runner.sh sets sane
# --config / --catalog / --out defaults; override with the CONFIG,
# CATALOG, OUT_DIR env vars if you need to point at a different config.
```

The v2 CLI exits with `0` for a full pass, `2` for partial (skipped
only) or a bad role, `3` for a halted run, `4` for a precheck failure.
See `apps/conformance-v2/README.md` for the full exit-code contract and
the role-partition table.

## Quick start (Docker, v0.1.0)

```bash
cd ops/docker
docker compose up --build
# open http://localhost:8080
```

On first start the app auto-generates a fresh wallet key pair (ES256 + EdDSA)
and a self-contained in-process mock issuer + verifier. So `docker compose up`
gives you a working tool with no external services.

### Try the tool with the in-process mock (no external services)

The fastest way to see a green run is to use the **in-process mock issuer +
verifier** that the webapp ships. No external services needed; everything
runs inside the same container.

1. Open <http://localhost:8080> (or whichever host/port you mapped).
2. Click **Configuration** in the top nav.
3. Pick a **Mode** (any of the four cross-modes works against the mock).
4. **Leave `targetIssuer` and `targetVerifier` blank** — this is the
   important part. With those fields empty, the runner uses the
   in-process mock at `http://127.0.0.1:<PORT>/.mock/issuer` (or
   `/.mock/verifier`), which always works and always returns the
   expected OID4VCI/OID4VP metadata shape.
5. **Credential Config ID** stays at the default `ThaiNationalID`
   (or pick `ThaiUniversityDegree` to mix it up).
6. Click **Save**, then click **Run** on the run view.

You should see all four cross-modes go 100% (40–41 of ~41 tests pass,
the rest SKIP because they are gated on a real-issuer prereq such as
`accessToken`).

The same flow is reproducible from the CLI without the UI:

```bash
# All four modes against the in-process mock (no targetIssuer set).
curl -X POST http://localhost:8080/api/runs \
  -H "content-type: application/json" \
  -d '{"mode":"I->W","credentialConfigurationId":"ThaiNationalID"}'
# → {"runId":"run-…","summary":{"total":41,"passed":40,"failed":0,"skipped":1,"passRate":1},…}
```

> **Why does the in-process mock SKIP one test?** `FT.WL.IC.W.I.VB.001`
> (full wallet-side issuance) requires a real `access_token` from the
> issuer. The mock does not run the offer→token step, so the test
> SKIPs with a documented reason. The SKIP is **expected** and **not a
> failure** — the report still shows `failed: 0`.

### When to set `targetIssuer` (real-issuer path)

Only set `targetIssuer` when you actually want to drive a **real OID4VCI
issuer** (Procivis One Core, a Thai government sandbox, etc.). In that
case the URL must point at the OID4VCI metadata endpoint, not at the
server root. See **"Test against a real target"** below for the full
convention and the "URL must be the OID4VCI endpoint base" warning.

## Quick start (local dev)

```bash
npm install
npm run dev          # http://localhost:8080
```

## Demo

```bash
# from the repo root
bash ops/smoke/run.sh
```

Exercises all four cross-modes against the in-process mock and writes JSON +
HTML reports to `/tmp/conformance-smoke-*`.

## Test against a real target

Open the webapp, go to **Configuration**, and set:

| Field                 | Example                                                    |
| --------------------- | ---------------------------------------------------------- |
| Mode                  | `Issuer ↔ Wallet` (drives target) or `Wallet ↔ Issuer` (tested by target) |
| Target Issuer URL     | `https://issuer.example.com`                              |
| Target Verifier URL   | `https://verifier.example.com`                            |
| Credential Config ID  | `ThaiNationalID` (defaults to the test fixture)           |
| DCQL Query (optional) | `{"credentials":[...]}` — only for Verifier modes         |

Save the config and click **Run** on the chosen test suite.

> **Important — the URL must be the OID4VCI/OID4VP endpoint base, not the
> bare server root.**
>
> `targetIssuer` must point at an **OID4VCI issuer root** — a URL that serves
> a JSON `/.well-known/openid-credential-issuer` metadata document with at
> least `credential_issuer` (issuer identifier), `credential_endpoint`,
> `deferred_credential_endpoint`, and `notification_endpoint`. Pointing it
> at the bare server root (e.g. `https://issuer.example.com` when the OID4VCI
> endpoints actually live under a subpath, or when the server only serves an
> SPA at `/`) makes the wallet fetch the SPA HTML as if it were metadata, and
> every metadata-dependent case fails.
>
> `targetVerifier` must similarly be the base of an OID4VP presentation
> definition endpoint (or the verifier's request-URI base) — not the server
> root.
>
> **Concrete convention used by the in-process mock** (so you can copy the
> shape when wiring your own issuer):
>
> ```bash
> # In-process mock issuer base (serves /.well-known/openid-credential-issuer)
> http://127.0.0.1:8080/.mock/issuer
> # In-process mock verifier base
> http://127.0.0.1:8080/.mock/verifier
> ```
>
> If you have only a host name (e.g. an HTTPS deployment at
> `https://issuer.example.go.th` where the OID4VCI endpoints are at the root
> of that host), the URL in `targetIssuer` is fine; just confirm with
>
> ```bash
> curl -sS https://issuer.example.go.th/.well-known/openid-credential-issuer
> # → must return JSON with credential_endpoint, etc.
> ```
>
> If that endpoint is on a **subpath** (e.g.
> `https://example.go.th/oid4vci/.well-known/openid-credential-issuer`),
> the `targetIssuer` URL must include that subpath as the base.

## Troubleshooting

### "summary is not defined" in the SPA / blank report panel

Symptom: you click **Run**, the report panel flashes blank or shows
"0/0 passed" with no rows, and the browser console prints
`Cannot read properties of undefined (reading 'passRate')` (or
similar) — usually the `app.js` was loaded from a stale browser cache
or the server returned a Fastify error envelope (`{statusCode, code,
error, message}`) instead of a typed `Report`.

Fix in order:

1. **Hard-reload the SPA** — `Cmd/Ctrl+Shift+R`. The static file is
   served with `cache-control: public, max-age=0` so a normal reload
   revalidates, but a hard reload skips cache and is the safest reset.
2. **Open DevTools → Network → check the `/api/runs` response** — if
   the response body has a `statusCode` field, it is an error envelope
   (the server itself failed). Read the `message` for the cause.
3. **If you set `targetIssuer`**, make sure it is the OID4VCI
   **endpoint base**, not the server root. See **"Test against a
   real target"** above. A wrong URL makes the runner SKIP every
   metadata-dependent test; the new defensive code in the SPA still
   renders the SKIPs (so you see 0 failed + N skipped) but a stale
   `app.js` from before the fix will crash.
4. **Easiest reset: clear `targetIssuer` and `targetVerifier`** and
   re-run. The in-process mock takes over and the suite goes 100%.
   See **"Try the tool with the in-process mock"** above.

### `EACCES: permission denied, open '/app/apps/web/data/runs.json'`

The container is running as a non-root `app` user and the data dir is
not writable. This was a real bug fixed in MAS-174 follow-up; if you
see it on a fresh image, rebuild with `docker compose build --no-cache`
to pick up the new entrypoint (`ops/docker/entrypoint.sh`) that
re-chowns the data dir at container start.

### "Port 8080 already in use" when running `npm run dev`

You are already running the Docker container on 8080. Either stop it
(`cd ops/docker && docker compose down`) or run the dev server on a
different port (`PORT=8090 npm run dev`).

## Smoke test (after `docker compose up`)

```bash
bash ops/smoke/run.sh
# Expected: "All 4 cross-modes produced downloadable reports ✓"
```

The smoke script POSTs to `/api/runs` for each of the four modes (against
the built-in mock targets), waits for the run to finish, and downloads the
JSON + HTML report for each.

## Architecture

```
.
├── apps/
│   ├── web/                 Fastify server + static UI
│   │   ├── src/
│   │   │   ├── server.ts        HTTP entrypoint
│   │   │   ├── routes/          REST API: /api/config, /api/runs, /api/runs/:id, ...
│   │   │   ├── wallet/          OID4VCI + OID4VP wallet simulator
│   │   │   ├── runners/         4 cross-mode test runners
│   │   │   ├── fixtures/        Mock issuer + verifier (for self-contained demo)
│   │   │   ├── crypto/          Keypair + KB-JWT helpers (ES256, EdDSA)
│   │   │   ├── report/          Result aggregation + HTML/JSON serializers
│   │   │   └── ui/              Static SPA assets (HTML, CSS, TS)
│   │   └── test/                Vitest suites
│   └── docs/                 Conformance testcase corpus (mounted read-only)
├── ops/
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── smoke/                End-to-end smoke script
├── references/
│   ├── testcase-source.md    Pointer to the canonical spec doc
│   └── design.md             Design notes (this app)
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## Conformance coverage

This webapp **does not implement all 283 test cases** in v2.0 of the spec.
It implements the **happy-path + canonical negative-path** of every operation
the spec defines for each role, then lets the QA user drive the test against
any real target. The current canonical suite is:

| Operation                           | Covered |
| ----------------------------------- | :-----: |
| Issue VC — Credential Offer         | ✅      |
| Issue VC — Authorization (PKCE)     | ✅      |
| Issue VC — Authorization (auth_details) | ✅  |
| Issue VC — Token Exchange           | ✅      |
| Issue VC — Credential Request (KB-JWT ES256) | ✅ |
| Issue VC — Credential Request (KB-JWT EdDSA) | ✅ |
| Issue VC — Deferred Credential      | ✅      |
| Notification                        | ✅      |
| Present VP — Authorization Request (DCQL) | ✅ |
| Present VP — Authorization Response (vp_token) | ✅ |
| Present VP — DCQL query rendering   | ✅      |

The number of *concrete* test cases per mode is configurable. Defaults target
a representative slice of the spec (~30–40 cases per mode).

## Standards implemented

- **OpenID for Verifiable Credential Issuance 1.0 Final** — §4 (Credential Offer),
  §5 (Authorization), §6 (Token Endpoint), §7 (Credential Endpoint with proof
  types JWT / SD-JWT, CWT, KB-JWT), §8 (Deferred Credential), §9 (Notification).
- **OpenID for Verifiable Presentations 1.0 Final** — §5 (Request parameters
  including DCQL), §6 (Response modes, `vp_token`, `presentation_submission`).
- **RFC 6749** OAuth 2.0, **RFC 7636** PKCE, **RFC 9396** Rich Authorization
  Requests (authorization_details), **RFC 7515/7517/7519** JOSE.

## Done criteria (recap of MAS-131)

- ✅ `docker compose up` brings it up, reachable in a browser.
- ✅ All four role cross-modes work against a configured target.
- ✅ In-app report is shown; download yields JSON or HTML.
- ✅ Test cases traceable to the corrected v2.0 spec.
- ✅ QA can plug a real issuer/verifier URL in via UI/env, no code change.

## License

Internal — Paperclip / Thailand VC ecosystem.
