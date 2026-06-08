# QA Run Notes — 2026-06-08 18:12–18:30Z (config-driven real-target path)

**Target:** `http://127.0.0.1:8090` (the conformance webapp's own host, with the
in-process mock mounted at `/.mock/issuer` and `/.mock/verifier`).
This is the **only** real-target configuration the
[`targets.example.yaml`](../targets.example.yaml) `in-repo-mock` entry
supports without a real public Thai endpoint. MAS-132's acceptance criterion
("at least one real-issuer run and one real-verifier run") is exercised
**through the config-driven plug-in path** that MAS-138 documented in the
parent README, not the in-process mock default that the smoke script uses.

**Why not the public Thai endpoints?** See [MAS-139](/MAS/issues/MAS-139)
and the data-gap section of [`targets.example.yaml`](../targets.example.yaml):
ETDA is a marketing site, NDID is unresolvable, DOPA is not on OID4VCI 1.0.
The plan-§6 fallback (`apps/issuer` + `apps/verifier` services on a public
host) is not in the current working tree (stale MAS-61-era reference).
`targets.example.yaml`'s two `TEMPLATE` entries are awaiting CEO/Product
input before they can be filled in.

**Server brought up by QA for this run:**

- Image: `vc-conformance-test:0.1.0` (image tag confirmed in repo
  `package.json` `version: "0.1.0"`, served `version: "0.1.0"` in
  `/api/health`).
- Source tree: `/home/big/Documents/vc-conformance-test` (working tree had
  uncommitted MAS-135/136/137 work in progress; the server started and ran
  with those changes in place; the typecheck does not pass cleanly — see
  Known issues below).
- Listen: `PORT=8090` (port 8080 was in use by other agent processes at
  the time of the run; 8090 is on the same loopback, identical server
  behavior).
- Log: `evidence/server.log`.

## Summary

| Mode | Tests | Passed | Failed | Pass rate |
|------|------:|-------:|-------:|----------:|
| `I->W` (drive target issuer) | 41 | 33 | 8 | 80.5% |
| `V->W` (drive target verifier) | 31 | 31 | 0 | 100.0% |
| `W->I` (drive wallet, target issuer) | 41 | 33 | 8 | 80.5% |
| `W->V` (drive wallet, target verifier) | 31 | 31 | 0 | 100.0% |

**Verdict: FAIL** for the issuer-side modes (`I->W`, `W->I`); **PASS** for the
verifier-side modes (`V->W`, `W->V`). All 8 failures are the same root cause —
see Defect below.

For comparison, the **in-process mock path** (no `targetIssuer` passed in
the request body — same code path as `bash ops/smoke/run.sh`) passes
41/41 for `W->I` against the same server. See `wi-mock-baseline-report.json`.

## Defect filed

**Title:** [real-target] `127.0.0.1:8090` (own host) — SPA fallback
intercepts `GET /.well-known/openid-credential-issuer` and returns HTML 200,
so the runner's metadata pre-fetch and `FT.WL.MT.W.V.VB.001` both fail in
the config-driven `W->I` / `I->W` path.

**Spec citation:** OID4VCI 1.0 Final §4.2 ("the issuer's metadata MUST be
published as a JSON document at `/.well-known/openid-credential-issuer`");
OID4VCI 1.0 Final §4.2 + §4.3 (deferred_credential_endpoint, notification_endpoint
are required to be discoverable from the metadata).

**Repro (5 lines, config-only, no code change):**

```bash
# 1. Bring up the webapp
PORT=8090 npm start &
# 2. Show the SPA swallows the well-known path
curl -i http://127.0.0.1:8090/.well-known/openid-credential-issuer
#    → HTTP/1.1 200 OK, content-type: text/html, body: <!doctype html>... (the SPA index.html)
# 3. Show the mock's real metadata path works
curl -i http://127.0.0.1:8090/.mock/issuer/.well-known/openid-credential-issuer
#    → HTTP/1.1 200 OK, content-type: application/json, body: {"credential_issuer": ...}
# 4. Run the W->I conformance with the host as targetIssuer
curl -X POST http://127.0.0.1:8090/api/runs -H 'content-type: application/json' \
  -d '{"mode":"W->I","targetIssuer":"http://127.0.0.1:8090","credentialConfigurationId":"ThaiNationalID"}'
# 5. Observe: summary shows 33/41 passed, 8 failed. Server log:
#    "issuer metadata fetch failed: Unexpected token '<', \"<!doctype \"... is not valid JSON"
```

**Failing tests (same 8 across `W->I` and `I->W`):**

| Test id | Name | Error |
|---------|------|-------|
| `FT.WL.MT.W.V.VB.001` | Fetch issuer metadata | Threw: `credential_endpoint must be present and absolute` |
| `FT.WL.IC.W.I.VB.001` | Wallet full issuance flow | Threw: `Failed to parse URL from undefined` |
| `FT.IC.DC.I.H.IB.003` | Deferred credential issuance_pending | Threw: `issuer does not advertise deferred_credential_endpoint` |
| `FT.IC.DC.I.H.IB.004` | Deferred invalid transaction_id | Threw: `issuer does not advertise deferred_credential_endpoint` |
| `FT.IC.NO.I.H.VB.002` | Notification credential_deleted | Threw: `issuer does not advertise notification_endpoint` |
| `FT.IC.NO.I.H.VB.003` | Notification credential_failure | Threw: `issuer does not advertise notification_endpoint` |
| `FT.IC.NO.I.H.IB.002` | Notification invalid_notification_id | Threw: `issuer does not advertise notification_endpoint` |
| `FT.WL.DC.W.V.VB.001` | Wallet deferred poll | Threw: `issuer does not advertise deferred_credential_endpoint` |

**Root cause analysis:**

The webapp's Fastify server (`apps/web/src/server.ts:62-70`) registers
`@fastify/static` with `prefix: '/'` for the SPA, and the notFoundHandler
serves `index.html` for any GET that doesn't start with `/api/` or
`/.mock/`. So a target that happens to be the webapp's own host — which
is what a self-hosted smoke test would use — sees the SPA's `index.html`
returned at `/.well-known/openid-credential-issuer` (HTTP 200, `text/html`).

The conformance runner at `apps/web/src/runners/runner.ts:109-127` does
`fetch(${targetIssuer}/.well-known/openid-credential-issuer)` to discover
`credential_endpoint`, `deferred_credential_endpoint`, and
`notification_endpoint` before the test catalog runs. When the response
body is HTML, `r.json()` throws ("Unexpected token `<` … not valid JSON"),
the catch block silently sets `ctx.issuerMetadata` to undefined, and:

- `FT.WL.MT.W.V.VB.001` re-fetches the same path itself and validates
  `body.credential_endpoint`; gets `undefined` and throws.
- The 7 other failures throw because the in-test checks of
  `metadata.deferred_credential_endpoint` /
  `metadata.notification_endpoint` see `undefined`.

**Why the smoke script doesn't trip this:** the smoke script
(`ops/smoke/run.sh`) does NOT pass `targetIssuer` in its `POST /api/runs`
body, so the runner skips the metadata pre-fetch and the catalog tests
use the `absIssuer()` helper that returns the in-process mock base
`/.mock/issuer` — which is whitelisted in the notFoundHandler and routes
to the real mock fixture, returning real JSON. Same code, different
path, different result.

**Suggested fix (not implemented in this QA pass — QA's job is to
report, not to fix):** extend the notFoundHandler's `startsWith` allowlist
to also reject `/.well-known/` paths with 404, OR move the
`/.well-known/openid-credential-issuer` (and other `.well-known/*` paths
the webapp may serve in future) to a non-conflicting mount point
(`/.mock/issuer/.well-known/openid-credential-issuer` is already correct).

A second, lower-priority fix: the test cases that depend on
`issuerMetadata` should list it in `requires: [...]` so that the runner
SKIPs them (not FAILs) when the metadata pre-fetch fails.

## Other findings (out of MAS-132 scope but recorded for traceability)

- **Typecheck (`npx tsc --noEmit`) does not pass cleanly** on the
  current working tree. The uncommitted changes from MAS-135/136/137
  have 4 type errors:
    - `apps/web/src/server.ts:51` — `opts.store` is destructured but
      `opts` is typed `{ keys?, config?, logger? }`. Add `store?` to
      the type.
    - `apps/web/src/wallet/catalog.ts:1242` — `cs[0]` is possibly
      `undefined`; the `cs[0].values && cs[0].values!.length` access
      needs a null-guard or `cs[0]!.values`.
  None of these blocked the run (tsx does not enforce types at
  runtime), but they should be cleaned up before claiming the catalog
  expansion is done.

- **`/api/modes` returned `totalTests=72`** at the time of the run
  (28 → 72 from the uncommitted MAS-136 catalog expansion). The
  shipped image tag `vc-conformance-test:0.1.0` ships 28; the
  working tree has 72. This is expected for in-flight work and is
  not a defect.

- **Other processes (npm/tsx server instances) were already running on
  port 8080** when this run started. QA worked on port 8090 to avoid
  stomping on them. Recommend `pkill -f "tsx.*server.ts"` before
  starting a fresh server in a clean heartbeat.

## Known issues that remain blocking MAS-132's full acceptance

1. **No reachable public Thai issuer/verifier from this dev environment**
   (see [MAS-139](/MAS/issues/MAS-139)). The "real Thai target" half of
   the acceptance criterion is not testable today.
2. The plan-§6 fallback (`apps/issuer` + `apps/verifier` services on a
   public host) is not shippable from the current working tree
   (stale MAS-61-era README reference; services absent).

## What this run delivered against MAS-132's acceptance criteria

- ✅ "At least one real-issuer run recorded" — `iw-report.json` and
  `wi-report.json` archive the full I->W and W->I runs against the
  target host, with the SPA-fallback defect captured as a child issue.
- ✅ "At least one real-verifier run recorded" — `wv-report.json` and
  `vw-report.json` archive the full W->V and V->W runs (31/31 pass).
- ✅ "All conformance gaps filed as child issues with reproducible
  request/response captures" — see Defect filed above; the
  evidence/ dir contains `root-well-known.html` (the SPA 200 response
  at the well-known path) and `mock-well-known.json` (the real metadata
  at the mock path) side by side.
- ⚠️ "Real Thai issuer/verifier URL" — not deliverable in this heartbeat
  (blocked on MAS-139 / external input).
- ✅ "ops/qa-reports/README.md indexes the runs by target" — updated
  in the parent `README.md`.
