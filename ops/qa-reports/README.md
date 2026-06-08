# Real-Target Conformance QA Reports

This directory holds artifacts from real-target runs of the `vc-conformance-test:0.1.0`
webapp against actual Thai (and other) issuers / verifiers, as required by
[MAS-132](/MAS/issues/MAS-132).

## How to plug a `targets.example.yaml` entry into the webapp

[MAS-138](/MAS/issues/MAS-138) ships a `targets.example.yaml` next to this
README. Once a real Thai entry is filled in (the two `TEMPLATE` entries
are blocked on CEO/Product input), QA can point the conformance tool at
it three ways. All three are **config-only** — no code change to the
webapp is required.

### A. Web UI

1. Open the webapp (`http://localhost:8080` after `docker compose up`,
   or your deployed URL).
2. Go to **Configuration**.
3. Set:
   - **Mode** — one of `I->W`, `V->W`, `W->I`, `W->V`. Use `W->I` /
     `W->V` to drive the wallet simulator against a real target
     issuer / verifier.
   - **Target Issuer URL** — copy `baseUrl` from the YAML entry.
   - **Target Verifier URL** — copy `baseUrl` from the YAML entry.
   - **Credential Config ID** — copy `credentials[0].configurationId`
     (typically `ThaiNationalID`).
   - **DCQL Query (optional)** — for verifier modes, paste
     `dcqlQuery` from the verifier entry as JSON.
4. Click **Save**.
5. Go to **Run** and pick the suite.

### B. API — `PUT /api/config` then `POST /api/runs`

```bash
# 1. Save the target config
curl -X PUT http://localhost:8080/api/config \
  -H 'content-type: application/json' \
  -d '{
    "mode": "W->I",
    "targetIssuer": "https://issuer.example.go.th",
    "credentialConfigurationId": "ThaiNationalID"
  }'

# 2. Start a run
curl -X POST http://localhost:8080/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "mode": "W->I",
    "targetIssuer": "https://issuer.example.go.th",
    "credentialConfigurationId": "ThaiNationalID"
  }' | jq .
```

The run response contains the same fields as the JSON report at
`GET /api/runs/{id}/report.json`. Save the `runId`, then archive:

```bash
RUN_ID=run-xxxxxxxx-xxxx
mkdir -p ./<target-host>/$(date -u +%Y%m%dT%H%M%SZ)
curl -sS http://localhost:8080/api/runs/${RUN_ID}/report.json > ./<target-host>/.../report.json
curl -sS http://localhost:8080/api/runs/${RUN_ID}/report.html > ./<target-host>/.../report.html
curl -sS http://localhost:8080/api/runs/${RUN_ID}            > ./<target-host>/.../run.json
```

### C. API — one-shot, no save

The same body in `POST /api/runs` runs immediately and stores the
result regardless of the saved config. Use this for ad-hoc CI runs.

## Layout

```
ops/qa-reports/
├── README.md                      ← this index
├── targets.example.yaml           ← [MAS-138] ship the fixture file
└── <target-host>/
    └── <UTC-timestamp>/
        ├── run.json               ← raw /api/runs response
        ├── report.json            ← /api/runs/{runId}/report.json
        ├── report.html            ← /api/runs/{runId}/report.html
        ├── evidence/              ← captured request/response logs, headers, raw bodies
        └── notes.md               ← QA observation notes, defect links, spec-citation refs
```

## Runs index

| # | Date (UTC) | Target | Mode(s) | Result | Report dir | Filed defects |
|--:|-----------|--------|---------|:------:|------------|---------------|
| 1 | 2026-06-08 18:12–18:30Z | `http://127.0.0.1:8090` (webapp's own host; in-process mock mounted at `/.mock/issuer`, `/.mock/verifier`) | `I->W` 33/41, `V->W` 31/31, `W->I` 33/41, `W->V` 31/31 | **FAIL** for issuer modes; **PASS** for verifier modes. Root cause: SPA fallback intercepts `GET /.well-known/openid-credential-issuer` on the target's own host (see notes.md §"Defect filed") | [127.0.0.1:8090/20260608T183045Z/](./127.0.0.1:8090/20260608T183045Z/) | [MAS-140](/MAS/issues/MAS-140) (filed this run) |

> Run #1 is the config-driven real-target path (not the in-process mock
> default that the smoke script uses). The same server's in-process mock
> path (no `targetIssuer` passed) passes 41/41 on the same code — see
> `wi-mock-baseline-report.json` in the report dir. The defect is
> mode-asymmetric: it only affects `I->W` and `W->I` (the modes that need
> issuer metadata); `V->W` and `W->V` (verifier-only flows) are clean.

## Status snapshot (as of 2026-06-08)

- Baseline tooling: `vc-conformance-test:0.1.0` Docker image and the in-process
  mock pass 56/56 across all 4 cross-modes (`bash ops/smoke/run.sh`).
  Note: the working tree at the time of run #1 had the uncommitted
  MAS-136 catalog expansion in place; the in-process mock path on
  that expanded catalog passes 41/41 for W->I (`wi-mock-baseline-report.json`).
- `targets.example.yaml` is in this directory ([MAS-138](/MAS/issues/MAS-138)),
  with the in-repo mock fully filled and two TEMPLATE entries for the Thai
  public sandbox (issuer + verifier) — fields pending CEO/Product input.
- Real Thai targets: **still no URLs reachable from the dev environment**.
  Probes 2026-06-08: ETDA marketing site only, NDID host unresolvable,
  DOPA e-Service not on OID4VCI 1.0. The plan-§6 fallback ("apps/issuer
  + apps/verifier services running on a publicly reachable host") is also
  not shippable: those services are not present in the current working
  tree (stale MAS-61-era README reference).
- **Run #1 filed defect:** [MAS-140](/MAS/issues/MAS-140) — the config-driven
  `targetIssuer=...` path is broken when the target happens to be the
  webapp's own host, because the SPA static handler swallows
  `/.well-known/openid-credential-issuer` with an HTML 200. The in-process
  mock path (smoke / no target) is unaffected. Fix is straightforward
  (whitelist `/.well-known/` in the notFoundHandler) but out of QA scope.
- MAS-132 still needs a real Thai issuer + verifier URL to be fully green.
  See [MAS-139](/MAS/issues/MAS-139) for the external input dependency.
- Prior QA run [MAS-61 interop report](/MAS/issues/MAS-61#document-evidence)
  exercised the in-repo `apps/holder-portal / apps/issuer / apps/verifier`
  only — no production Thai endpoints were reachable in the runner env.
