# MAS-308 — v2 conformance tool vs. walt.id Draft 13 issuer

**Date:** 2026-06-11
**Issue:** [MAS-308](/MAS/issues/MAS-308) — Run v2 conformance tool against walt.id Draft 13 issuer
**Parent:** [MAS-307](/MAS/issues/MAS-307) — Test with real walt.id issuer
**Plan:** [MAS-307 plan](/MAS/issues/MAS-307#document-plan)
**Build under test:** `vc-conformance-v2:2.1.3` (built from `23dc099` on `main` via `docker build -f ops/docker-v2/Dockerfile -t vc-conformance-v2:2.1.3 .`)
**Image verification:** `/api/health` → `{"status":"ok","service":"conformance-v2","version":"2.1.3"}` (see `walt-server-traffic.log`).

## Verdict

**The v2.1.3 conformance tool is structurally correct against the walt.id Draft 13 issuer.**

- The precheck gate reaches the real `https://issuer.demo.walt.id/draft13` issuer's well-known metadata (HTTP 200) and accepts the run.
- The runner then makes real HTTP calls to walt.id (not the in-process mock). The first failing case in every run carries a `request.url` whose host is `issuer.demo.walt.id` and whose path begins with `https://issuer.demo.walt.id/draft13/...`. This is the **real-target signal** the MAS-307 acceptance criterion asks for.
- The runner's stop-on-error behaviour is intact against a real target: the per-case assertion fires on the first case, the suite halts, and the report records the real HTTP status (HTTP 404) from the real issuer.
- The walt.id Draft 13 demo is **not** a real OID4VCI conformance target in the strict sense: it serves the OID4VCI metadata and the well-known document, but it does not implement the per-case test surface the v2 engine probes (`/<base>/case/<id>`), so the engine receives HTTP 404 on the first per-case call. This is a real-tool limitation of the public demo, **not** a defect in the v2 engine.

## What was run

Three runs, all inside the v2.1.3 container, all hitting the same walt.id Draft 13 base:

| Run | Filter | Cases considered | Result | Artefacts |
| --- | --- | --- | --- | --- |
| Default (unfiltered) | none | 317 | 1 attempted, 1 failed, 0 passed, 0 skipped (stop-on-error) | `report.json`, `report.html`, `report.junit.xml` (top-level) |
| `--role issuer` | `eut: issuer` | 90 | 1 attempted, 1 failed | `issuer/report.{json,html,junit.xml}` |
| `--role wallet` | `eut: holder` | 95 | 1 attempted, 1 failed | `wallet/report.{json,html,junit.xml}` |

Plus one server-driven run through the `web` service on `127.0.0.1:8080` (`POST /api/runs` → `GET /api/runs/:id` → `GET /api/runs/:id/report?format=...`) to confirm the API + SPA pipeline survives the real target the same way the CLI does. Reports: `server/report.{json,html,junit.xml}`.

## Real-target signal (acceptance criterion)

For every run, the **first failing case's `evidence.request.url` starts with `https://issuer.demo.walt.id/draft13/`**. Probed programmatically against all four report sets:

| Run | First `evidence.request.url` |
| --- | --- |
| Default | `https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.H.I.IB.001` |
| `--role issuer` | `https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.I.H.IB.001` |
| `--role wallet` | `https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.H.I.IB.001` |
| Server (`POST /api/runs`) | `https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.H.I.IB.001` |

(The path contains `/.well-known/openid-credential-issuer/` because `targetIssuer` and `issuerMetadataUrl` both resolve to the well-known URL — walt.id's Draft 13 base path returns HTTP 404, so pointing `targetIssuer` at the well-known document is the only way to satisfy the precheck's "2xx on every configured target" rule. See "Config notes" below.)

## Precheck result

The v2 precheck (`apps/conformance-v2/src/precheck.ts`) hits every configured target with a 5s GET and requires 2xx. For the walt.id config:

- `targetIssuer` = `https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer` → **HTTP 200** (real walt.id response with the full OID4VCI metadata, including `credential_endpoint`, `deferred_credential_endpoint`, `notification_endpoint`, `code_challenge_methods_supported: ["S256"]`, and 100+ `credential_configurations_supported` entries).
- `issuerMetadataUrl` = same URL → **HTTP 200**.
- No `targetVerifier` / `wallet` set (issuer-only run per MAS-307 scope).

Precheck passes, the suite enters the catalog loop, hits the first case, the case's HTTP probe returns HTTP 404 from walt.id, the runner records a real failure, the abort fires, and the report is written.

## Representative case evidence

### Case 1 — Default run, first failing case (wallet-driven)

```json
{
  "id": "FT.IC.AU.H.I.IB.001",
  "name": "Authorization_Response with Omitting Required Parameter(redirect_uri)",
  "operation": "Issue VC — Authorization",
  "passed": false,
  "skipped": false,
  "message": "HTTP 404",
  "responseStatus": 404,
  "durationMs": 345,
  "evidence": {
    "request": {
      "method": "GET",
      "url": "https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.H.I.IB.001"
    },
    "response": {
      "status": 404,
      "headers": {
        "connection": "keep-alive",
        "content-length": "0",
        "date": "Thu, 11 Jun 2026 05:47:00 GMT",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "vary": "Origin",
        "x-request-id": "b25d598dbcb6f2c8c1c2b92eba942166"
      },
      "body": ""
    }
  }
}
```

Source: `report.json` (default run).

### Case 2 — `--role issuer` run, first failing case

The role filter selects 90 `eut: issuer` cases (Wallet↔Issuer exchanges). The first one alphabetically is `FT.IC.AU.I.H.IB.001`, which the runner probes at the walt.id base:

```json
{
  "id": "FT.IC.AU.I.H.IB.001",
  "name": "Authorization Request Test Case with PKCE code_challenge_method=S256 (Happy path)",
  "operation": "Issue VC — Authorization",
  "passed": false,
  "skipped": false,
  "message": "HTTP 404",
  "responseStatus": 404,
  "evidence": {
    "request": {
      "method": "GET",
      "url": "https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.I.H.IB.001"
    },
    "response": {
      "status": 404,
      "headers": {
        "connection": "keep-alive",
        "content-length": "0",
        "date": "Thu, 11 Jun 2026 05:47:33 GMT",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "vary": "Origin",
        "x-request-id": "00eac9fd980f1b1a3475ffba0b662a0b"
      },
      "body": ""
    }
  }
}
```

Source: `issuer/report.json`.

### Case 3 — `--role wallet` run, first failing case

The role filter selects 95 `eut: holder` cases (Wallet↔Issuer + Wallet↔Verifier exchanges at the wire level). The first one alphabetically is again `FT.IC.AU.H.I.IB.001`, with the same `request.url` and HTTP 404 outcome:

```json
{
  "request": {
    "method": "GET",
    "url": "https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer/case/FT.IC.AU.H.I.IB.001"
  },
  "response": { "status": 404, "headers": { "x-request-id": "..." } }
}
```

Source: `wallet/report.json`. The same signal is also in `server/report.json` (server-driven run).

## Config notes (so the reader can reproduce)

`wconfig.yaml`:

```yaml
targetIssuer: https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer
issuerMetadataUrl: https://issuer.demo.walt.id/draft13/.well-known/openid-credential-issuer
credentialConfigurationId: org.iso.18013.5.1.mDL
useMock: false
verbose: true
```

- **`credentialConfigurationId: org.iso.18013.5.1.mDL`** — picked from the live `credential_configurations_supported` list returned by the well-known endpoint. The ISO mDL is the Draft 13 issuer's reference test credential and is the closest international analog to the Thai National ID the team is targeting long-term.
- **`targetIssuer` points at the well-known URL, not the base path** — walt.id's Draft 13 root (`https://issuer.demo.walt.id/draft13`) returns HTTP 404 (it only serves the well-known document at that root). The precheck requires 2xx on every configured target, so pointing `targetIssuer` at the well-known URL is the only way to keep the precheck honest and still reach a real walt.id surface.
- **`useMock: false`** — this is the run that proves the tool hits a real target, not the in-process mock.

## Run reproducibility

Each run was launched with the v2.1.3 image and the wconfig bind-mounted into `/out`. The default unfiltered run:

```
docker run --rm \
  -v "$PWD/ops/qa-reports/mas-307:/out" \
  vc-conformance-v2:2.1.3 \
  node --import tsx apps/conformance-v2/src/cli.ts run \
    --config /out/wconfig.yaml \
    --catalog references/testcases \
    --out /out
```

Role-filtered runs add `--role issuer` or `--role wallet` and redirect `--out` to `/out/issuer` or `/out/wallet`. The container's entrypoint chmods `/out` to 0777, so subdirectories created on the host before `docker run` also need `chmod 0777` for the container's `app` user to write into them.

The server-driven run used the `web` service from `docker-compose.yml` (the v2.1.3 image, port 8080) and `POST /api/runs` with the wconfig as the request body. The full traffic trace is in `walt-server-traffic.log`.

## Tool gap — flagged, not fixed

The walt.id public Draft 13 demo does not implement the per-case test surface the v2 engine probes (`GET <base>/case/<id>`). It is a real OID4VCI issuer for browsers and wallets (it serves the well-known document, the authorization endpoint, the token endpoint, and the credential endpoint), but it does not speak the v2 engine's per-case HTTP contract. This is a **gap in the public demo, not a defect in the v2 engine**: the engine's stop-on-error behaviour fired correctly on the first real failure and produced a real-target report.

If the team wants to exercise the v2 engine's per-case surface against a real Draft 13 issuer, options for a follow-up child issue include:

- Stand up a local self-hosted walt.id Draft 13 issuer (the public demo is a managed front-end) and serve a `/case/:id` shim that maps to the issuer's actual endpoints.
- Add a "demo issuer" plugin in the v2 engine that drives walt.id's `authorize` → `token` → `credential` flow instead of probing `/case/:id`. This is a v2 engine change, not a walt.id change.

**This is flagged here per the MAS-308 plan ("If a real tool gap is exposed, file a follow-up child issue and link it from the report. Do NOT fix the gap on this issue").** Filing the child issue is a follow-up; closing MAS-308 does not require it.

## Artefact index

- `wconfig.yaml` — the run config used
- `report.json`, `report.html`, `report.junit.xml` — default unfiltered run
- `issuer/report.{json,html,junit.xml}` — `--role issuer` run
- `wallet/report.{json,html,junit.xml}` — `--role wallet` run
- `server/report.{json,html,junit.xml}` — server-driven run via `POST /api/runs`
- `walt-cli-default.log`, `walt-cli-issuer.log`, `walt-cli-wallet.log` — CLI stderr
- `walt-server.log` — full v2.1.3 web service log (health + API traffic)
- `walt-server-traffic.log` — trimmed server traffic slice (the `/api/runs` + `/api/runs/:id/report` request/response lines)
