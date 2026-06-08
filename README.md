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

## Quick start (Docker)

```bash
cd ops/docker
docker compose up --build
# open http://localhost:8080
```

On first start the app auto-generates a fresh wallet key pair (ES256 + EdDSA)
and a self-contained in-process mock issuer + verifier. So `docker compose up`
gives you a working tool with no external services.

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
