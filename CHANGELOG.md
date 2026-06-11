# Changelog

All notable changes to this repository are documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does **not** yet follow SemVer strictly; the major version
identifies the conformance-test generation (v0.1.0 was the original
webapp, v2.0.0 is the new engine + UI + server stack).

## Unreleased — MAS-312.A

Backend slice for the VP-via-QR submission flow ([MAS-312](/MAS/issues/MAS-312)).
No UI changes here (those land in [MAS-312.B](/MAS/issues/MAS-312.B));
no new wallet credential types (existing ThaiNationalID/ThaiUniversityDegree
mocks are reused); no conformance against an external EUT (cross-mode
smoke is enough).

### Added

- **`POST /api/qr/send-vp`** in `apps/web/src/routes/api.ts`. Accepts a
  `send-vp-request` QR payload, parses it via the existing
  `validateQrPayload` helper, builds a KB-JWT (typ `kb+jwt`, `aud =
  client_id`) that satisfies the embedded `dcql_query`, and POSTs the
  VP to the verifier's `response_uri`. Returns
  `{ ok: true, status, response, vpToken, sentTo, evidence }` on a
  verifier 2xx, and `{ ok: false, error, status?, details? }` on any
  pre-flight or verifier-side error. A verifier 4xx surfaces as
  HTTP 502 (Bad Gateway) so the UI can distinguish "we never sent
  anything" (400) from "we sent it and it was rejected" (502). The
  `details.evidence` block carries the QR metadata, the request line
  + body, and the verifier's response so the QA report can render a
  full transaction trace.

- **`runConformanceQrVp` runner entry point** in
  `apps/web/src/runners/runner.ts`. Distinct from `runConformance`
  (which runs the catalog of test cases) — this is the wire-level
  one-shot used by the new HTTP endpoint, the UI
  ([MAS-312.B](/MAS/issues/MAS-312.B)), and the QA fixture
  ([MAS-312.C](/MAS/issues/MAS-312.C)). Always returns a structured
  `QrVpResult` (`ok: true` or `ok: false`) so callers never have to
  translate an exception into a JSON contract.

- **`response_uri` support in `validateQrPayload`** —
  `apps/web/src/qr/validate.ts` now surfaces `response_uri` from the
  QR query string when present (per OID4VP 1.0 §5.1 the verifier MAY
  pin the response endpoint in the request). The runner honours it
  and falls back to `${targetVerifier}/response` when the QR omits
  it. Existing `validateQrPayload` consumers see a new optional
  `details.response_uri` field — purely additive, no breaking change.

- **New YAML catalog case** `IT.PV.AU.H.V.VB.QRP.001` in
  `references/testcases/`. `eut: verifier`, `suite: verifier`,
  `kind: live`. Asserts the VP-via-QR round-trip per
  OID4VP 1.0 §5.1 + §6.1. The new case brings the live catalog
  to 218 live / 100 coverage (well under the 50% guard). The
  `role-filter` test in `apps/conformance-v2/test/role-filter.test.ts`
  is updated to reflect the +1 verifier role entry.

### Tests

- `apps/web/test/qr-send-vp.test.ts` (new file, 8 tests):
  - happy-path VP round-trip against an in-process verifier
  - custom `response_uri` honoured when the QR carries one
  - 400 on a malformed QR (missing `client_id`) without contacting the verifier
  - 400 on a QR that omits `request_uri` / `dcql_query` / `presentation_definition`
  - 502 on a verifier 4xx response
  - `runConformanceQrVp` standalone: happy path
  - `runConformanceQrVp` standalone: invalid-QR failure
  - `validateQrPayload` exposes `client_id` + `dcql_query` on a `send-vp-request` QR

- `apps/conformance-v2/test/qr-send-vp-catalog.test.ts` (new file,
  2 tests): loads the real `references/testcases/` directory and
  asserts the new case is present, well-formed, and survives the
  loader's >50% coverage guard.

- `apps/conformance-v2/test/role-filter.test.ts`: updated the
  hard-coded counts (90 issuer, 27 verifier, 95 wallet) to reflect
  the new live verifier case.

  10 new tests on top of the 118 pre-existing web tests
  and 82 pre-existing v2 tests (128/128 in `apps/web/test/`,
  84/84 in `apps/conformance-v2/test/`).

## v2.1.3 — 2026-06-11

Behaviour follow-up to [MAS-305](/MAS/issues/MAS-305) for the
residual user-reported symptom in [MAS-303](/MAS/issues/MAS-303).
The v2 web UI's "Run log" and the per-case evidence download
now render the **actual HTTP transaction** (request method + URL,
response status + body) for every case — not the
`{"mock": true, "id": "..."}` placeholder the previous fix left
behind. No breaking API / wire change: `Report.results[*]` and
the SSE `case.passed` / `case.failed` payloads gain a new
non-breaking `evidence: { request, response, mock? }` field;
the existing `responseBody` field is preserved for backward
compatibility (it is still the captured response body, exactly
as MAS-305 left it).

### Changed

- **v2 runner / CLI / server now produce structured `evidence`
  for every case.** `apps/conformance-v2/src/runner.ts`
  carries the new optional `evidence` field through on the
  `case.passed` (analogous to the MAS-305 fix for `responseBody`),
  `case.skipped`, and `case.failed` branches. `makeServerRunCase`
  in `apps/conformance-v2/src/server.ts` and `makeRunCase` in
  `apps/conformance-v2/src/cli.ts` build the object for both
  the real HTTP path (capturing the request line + status +
  response body) and the in-process mock path (rendering
  `<in-process-mock> /case/<id>` as the URL and a `note: "answered
  by the in-process mock; no HTTP request was sent"` body, with
  `mock: true`). The CLI's `report.json`, the server's
  `/api/runs/:id/report?format=json`, and the per-case
  `/api/runs/:id/evidence/:caseId` download all surface the
  structured object.

- **v2 web UI renders the request line + response body in the
  inline "Run log" collapsible.** `apps/conformance-v2/web/src/components/CaseRow.tsx`
  adds a request line (`GET <url>`) above the response body,
  with a small `in-process mock` badge when `evidence.mock === true`.
  `apps/conformance-v2/web/src/components/StopOnErrorBanner.tsx`
  threads the same evidence through to the banner's copy-able
  body so the operator sees the full transaction (request line +
  status + body) for the failing case, not just the response
  body. The structured evidence also flows through
  `useRunStream` (so the live SSE view renders the same) and
  `ReportRoute` (so the post-run report view renders the same).
  A new `.case-log-request` / `.case-log-method` / `.case-log-url`
  / `.case-log-mock` CSS block in
  `apps/conformance-v2/web/src/styles.css` styles the request
  line and the mock badge.

- **v2 HTML report writer** now emits a `<details>` "request/response"
  block on every passing case row (in addition to the existing
  failure-detail block on failed rows), so the
  `report.html` download also surfaces the structured transaction.

### Tests

- `apps/conformance-v2/test/stop-on-error.test.ts`:
  - `'a passing case row preserves structured evidence (MAS-306 follow-up)'`
  - `'a failing case row preserves structured evidence (MAS-306 follow-up)'`
  - `'a skipped case row preserves structured evidence (MAS-306 follow-up)'`
  - `'a passing case without evidence still records status but no evidence (MAS-306 follow-up)'`
- `apps/conformance-v2/test/server.api.test.ts`:
  - `case.passed` payload now asserted to carry `evidence` (in addition
    to the legacy `responseStatus` / `responseBody`).
  - per-case `/api/runs/:id/evidence/:caseId` log now asserted to
    include the `request:` / `response:` / `mock:` lines and the
    JSON body.
- `apps/conformance-v2/web/test/CaseRow.test.tsx`:
  - `'renders the request line and response body from structured evidence (MAS-306 follow-up)'`
  - `'shows an "in-process mock" badge on the request line when evidence.mock is true (MAS-306 follow-up)'`

  7 new tests on top of the 76 pre-existing v2 server tests and
  51 pre-existing v2 web tests (83/83 in `apps/conformance-v2/test/`,
  53/53 in `apps/conformance-v2/web/test/`).

## v2.1.2 — 2026-06-11

Behaviour fix on [MAS-305](/MAS/issues/MAS-305) for the user-reported
symptom in [MAS-303](/MAS/issues/MAS-303). The v2 web UI's "Run log"
and the per-case evidence download now show the actual captured
response for a passing case — not just the test case id + a stub
message. No API or wire shape change: the `Report.results[*]` entries
gain an extra non-breaking field for passing cases.

### Fixed

- **v2 runner dropped `responseBody` on a passing case** —
  `apps/conformance-v2/src/runner.ts` line 159-168. The
  `case.passed` branch pushed a result row with `responseStatus`
  but no `responseBody`, even when the `runCase` function
  returned one. The same omission affected the `case.skipped`
  branch. As a result `report.json` had
  `responseBody: undefined` on every passing row, the inline
  collapsible log on the run-results page rendered only the
  placeholder message ("in-process mock" for the in-process
  mock, or the assertion text for a real target) with no body,
  and the per-case evidence `.log` download
  (`GET /api/runs/:id/evidence/:caseId`) was missing its
  `responseBody:` block.

  The fix preserves `responseBody` (and `responseStatus`, on the
  skipped branch) so the inline log + evidence download both
  surface the captured response. The CaseRow component already
  renders the body via `JSON.stringify(c.responseBody, null, 2)`
  inside the `.case-log-body` `<pre>` — it was simply never fed
  the value on a passing case.

### Tests

- `apps/conformance-v2/test/stop-on-error.test.ts`:
  - `'a passing case row preserves responseBody and responseStatus (MAS-305)'`
  - `'a passing case without a responseBody still records status but no body (MAS-305)'`
  - `'a skipped case row preserves responseBody when the runCase provided one (MAS-305)'`

  3 new tests on top of the 70 pre-existing v2 server tests
  (76/76 in `apps/conformance-v2/test/`).

## v2.1.1 — 2026-06-11

Packaging fix on [MAS-306](/MAS/issues/MAS-306) (releases the v2.1.1
patch on the v2.1.0 line). **No engine / CLI / API / UI behaviour
change vs v2.1.0** — the UI and API surface are byte-for-byte
identical to v2.1.0. The only changes are build-time artefacts
that were missing from the v2.1.0 source tarball but were present
in every developer's working tree as untracked files.

### Fixed

- **v2.1.0 source tarball was missing two untracked files** required
  by the `ui-build` stage of `ops/docker-v2/Dockerfile`:
  - `scripts/refresh-case-roles.sh` — regenerates the
    build-time role map from `references/testcases/`.
  - `apps/conformance-v2/web/src/lib/data/case-roles.json` — the
    317-entry map itself, imported by `roles.ts` at `tsc` time.
  Both files are gitignored (the `data/` pattern in `.gitignore`
  covered the JSON, and the script was created in the working tree
  and never `git add`-ed). As a result a clean tarball extraction
  of v2.1.0 failed the SPA build with
  `TS2307: Cannot find module "./data/case-roles.json"`. The
  v2.1.0 release notes documented an inline `node -e` workaround;
  v2.1.1 removes the need for any workaround by shipping the files.

- **Packaging shape**:
  - Tracked `scripts/refresh-case-roles.sh` and the generated
    `case-roles.json` (the script regenerates the JSON in 0.2s).
  - Narrowed `.gitignore` to ignore `apps/web/data/` explicitly
    (the v0.1.0 runtime data dir) instead of the blanket `data/`
    pattern, so the committed v2 webapp data file is not ignored.
  - Wired `refresh-case-roles.sh` into the `ui-build` stage of
    `ops/docker-v2/Dockerfile` so the JSON is always in sync with
    the catalog at build time (added `apk add --no-cache bash` to
    that stage — `node:22-alpine` ships only busybox ash).
  - Added a `"prebuild": "bash ../../../scripts/refresh-case-roles.sh"`
    script to `apps/conformance-v2/web/package.json` so npm-style
    consumers and local `npm run build` also refresh the JSON.
  - Bumped `IMAGE_VERSION` to `2.1.1`, the web `package.json`
    `version` to `2.1.1`, the `docker-compose.yml` `image:` tags
    to `vc-conformance-v2:2.1.1`, and the `CONFORMANCE_V2_VERSION`
    env var to `2.1.1` (so the server's `/api/health` agrees with
    the tag).
  - Updated `README.md` quick-start to point at v2.1.1.

### Verification

- `git ls-tree -r v2.1.1` includes
  `apps/conformance-v2/web/src/lib/data/case-roles.json` (317
  cases: 90 issuer, 26 verifier, 95 wallet, 71 multi, 35 resolver)
  and `scripts/refresh-case-roles.sh`.
- `bash ops/smoke/v2-cli.sh` passes from a clean
  `vc-conformance-v2-2.1.1.tar.gz` extraction (317/317 cases pass
  against the in-process mock; all three report formats written).
- `bash ops/smoke/v2-server.sh` passes from the same clean
  extraction (image builds, container starts, `/api/health`
  returns `version: 2.1.1`, SPA served at `GET /`, full run
  completes, JSON / JUnit / HTML reports downloadable).
- `npm run test --prefix apps/conformance-v2/web` — 51/51 pass.

### Known limitations

- v2.1.1 inherits the v2.1.0 source-only distribution; no GHCR
  image is published. The board's `skip_ghcr` decision on
  [MAS-278](/MAS/issues/MAS-278) still applies.
- The HTTP server has no built-in auth; do not expose port 8080
  to the public internet without a reverse proxy that handles
  auth. Inherited from v2.0.0.

## v2.1.0 — 2026-06-11

Built on [MAS-302](/MAS/issues/MAS-302) "Update V2.1 Web UI". Ships
the entity-driven Suite form, the per-case log/evidence on the Run +
Report pages, and the v2.1 version string end-to-end (sidebar, server
`/api/health`, package metadata, Dockerfile, docker-compose). Same
engine and CLI behaviour as v2.0.0; the changes are UI-facing plus a
new `GET /api/runs/:id/evidence/:caseId` route.

### Added

- **Entity-driven Suite form** (`apps/conformance-v2/web/src/routes/SuiteRoute.tsx`):
  a new "Entity under test" radio group (Issuer / Verifier / Wallet)
  drives the endpoint field's label and placeholder. The standalone
  "Target verifier base URL" textbox is gone — the verifier endpoint
  is the same field, just relabeled when the entity flips. The
  "Wallet URL" field stays as the cross-target for the "Issuer with
  wallet" / "Verifier with wallet" cross-modes and is hidden when
  the entity itself is Wallet (the entity URL is the wallet URL). A
  live caption under the radio group reads e.g. "Issuer with wallet.
  The endpoint textbox below is labeled against this entity."
- **Per-case log on every resolved case** (`apps/conformance-v2/web/src/components/CaseRow.tsx`):
  passed, failed, and skipped cases now show a collapsible
  inline log with the case id, response status, message, and
  response body. The previous implementation only showed the body
  on failed cases; v2.1 surfaces the full per-case trail regardless
  of outcome, so QA can inspect a passing response body without
  re-running the suite.
- **Per-case evidence download** (`apps/conformance-v2/src/server.ts`):
  `GET /api/runs/:id/evidence/:caseId` returns a `text/plain` log
  with the case id, name, operation, status, duration, response
  status, message, and response body. The endpoint sets
  `Content-Disposition: attachment; filename="evidence-<runId>-<caseId>.log"`
  so a click downloads the artifact. The CaseRow "Evidence" link
  points here. The endpoint is server-only — no disk write — and
  serves the in-memory `rec.report.results` so the same data is the
  source of truth for the JSON / JUnit / HTML reports.
- **/api/health version is wired to the build**: the server now
  reports `version: <CONFORMANCE_V2_VERSION>` (default `2.1.0`),
  matching the Dockerfile `IMAGE_VERSION` build-arg. The UI sidebar
  reads "v2.1.0 — Suite → Run → Report."

### Changed

- Bumped `conformance-v2-web` `package.json` from `2.0.0` to `2.1.0`.
- Bumped `ops/docker-v2/Dockerfile` `IMAGE_VERSION` default to `2.1.0`.
- Bumped `docker-compose.yml` `web` and `runner` `image:` tags to
  `vc-conformance-v2:2.1.0`; the `web` service now exports
  `CONFORMANCE_V2_VERSION=2.1.0` so the health endpoint agrees with
  the tag.

### Fixed

- **MAS-275** (run-empty state for precheck-fail runs): the
  RunRoute empty-state paragraph now branches on `state.status` so
  a run that aborts before any case event shows "Run aborted before
  any case could run." instead of the contradictory "Awaiting first
  case event…" / "Connecting to event stream…" copy. The existing
  `RunRoute.test.tsx` (which referenced the "abort" copy but had
  been failing) now passes.

### Migration from v2.0.0

- The wire-level API contract is unchanged. Existing YAML config
  bodies (`targetIssuer`, `targetVerifier`, `wallet`,
  `issuerMetadataUrl`, `useMock`) still parse identically.
- The UI form is restructured: instead of three text boxes
  (`targetIssuer`, `targetVerifier`, `wallet`) you now pick an
  entity and fill one endpoint field. The "Wallet URL" field is
  still present for the cross-modes. The optional
  `issuerMetadataUrl` field is unchanged.
- A new API route is added (`/api/runs/:id/evidence/:caseId`). No
  existing route was removed or renamed.

## v2.0.0 — 2026-06-08

The first release of the **v2 conformance test tool** (engine + HTTP
server + web UI + Docker image), shipping in parallel with the
maintained v0.1.0 webapp. Built on
[MAS-242](/MAS/issues/MAS-242) and its workstream issues
[MAS-254](/MAS/issues/MAS-254),
[MAS-255](/MAS/issues/MAS-255),
[MAS-256](/MAS/issues/MAS-256),
[MAS-257](/MAS/issues/MAS-257),
[MAS-258](/MAS/issues/MAS-258).

### Added

- **v2 conformance test engine** (`apps/conformance-v2/src/`):
  - Iterates the testcase catalog, makes one HTTP call per live case,
    treats 2xx as pass, treats 4xx / 5xx / timeout / refused as real
    failure. The in-process mock is the source of truth for the
    "happy path" — a run with `useMock: true` is the canonical
    green-baseline check.
  - Emits a typed event stream (`run.started`, `case.passed`,
    `case.failed`, `case.skipped`, `run.aborted`, `run.completed`).
  - Precheck gate: a closed port / 4xx / 5xx at the metadata URL
    fails the suite before any case runs (distinct from a per-case
    stop-on-error).
  - Stop-on-error: a real failure latches the `AbortCoordinator` and
    halts the suite. The remaining cases are skipped, and the report
    records `abortedAt: <case-id>`.
  - Reports: `report.json`, `report.junit.xml`, `report.html`. The
    HTML report is self-contained and human-readable; the JUnit XML
    is the standard CI integration point.

- **v2 HTTP server** (`apps/conformance-v2/src/server.ts`):
  - `POST /api/runs` queues a run with a YAML config body.
  - `GET /api/runs/:id` returns a JSON snapshot of run state.
  - `GET /api/runs/:id/events` streams the run as Server-Sent
    Events with the same event names the engine emits.
  - `GET /api/runs/:id/report?format=json|junit|html` serves the
    same report files the CLI writes.
  - `GET /api/health` is a liveness probe.
  - The server is intentionally **stateless** (in-memory `RunStore`).
    The CLI writes the durable report; the server's job is to expose
    the run to a browser.

- **v2 web UI** (`apps/conformance-v2/web/`):
  - Vite + React + React Router SPA, three routes:
    - `/` — Suite (config form + precheck pill + Run button).
    - `/runs/:id` — Run (live SSE progress + `StopOnErrorBanner`).
    - `/runs/:id/report` — Report (filterable case list + download
      links to JSON / JUnit / HTML).
  - The v2 server mounts the built SPA at `GET /`; the SPA uses the
    proxy / direct connection to the same origin's `/api/...`
    endpoints. SPA fallback is wired so client-side routes (e.g.
    `/runs/abc/report`) serve `index.html` and let React Router take
    over.

- **v2 Docker image** (`ops/docker-v2/Dockerfile`):
  - Multi-stage on `node:22-alpine`: `ui-build` (Vite), `deps`
    (npm ci), `runtime` (non-root, su-exec wrapper).
  - Single image for CLI + server; defaults to **server (UI) mode
    on :8080**, CLI is a subcommand. The CLI mode writes reports to
    `/out`; mount a host dir there to capture the artefact.
  - The image is published to
    `ghcr.io/noobookbig/vc-conformance-v2:2.0.0`.

- **v2 smoke scripts** (`ops/smoke/v2-cli.sh`, `ops/smoke/v2-server.sh`):
  - `v2-cli.sh` — builds the image, runs the CLI against the
    in-process mock, asserts `report.{json,junit.xml,html}` are
    produced with 317 / 317 pass.
  - `v2-server.sh` — builds the image, starts the server, curls
    `/api/health` + `GET /` (the SPA) + `POST /api/runs` + the
    snapshot, asserts the report is downloadable in all three
    formats.

- **Structural guards** (the v0.1.0 inflation pattern is now
  impossible):
  - `loadCatalog()` rejects any catalog where more than 50% of
    cases are `kind: coverage`.
  - `coverage` cases require a `justification` string naming the
    spec section.
  - Stop-on-error is on by default.

- **Role filter** on the CLI ([MAS-292](/MAS/issues/MAS-292)):
  - `--role <issuer|verifier|wallet>` partitions the catalog by
    Entity Under Test so each role's conformance run is independent
    of the other two. The four protocol pairings stay covered: an
    Issuer test case is a Wallet↔Issuer exchange at the wire level
    even though only the Issuer side is asserted.
  - `--include-coverage` opts the selected role into `kind: coverage`
    cases (default: `live` only, matching the runner's
    "actually run against the target" contract).
  - `run.started` reports the **filtered** count, not the total.
    A `role filter: role=<r> includeCoverage=<b> kept=<k> of <n>`
    line is printed to stderr so the audit trail shows exactly what
    the engine executed. Shipped catalog partitions to 90 issuer /
    26 verifier / 95 wallet (holder); default (no flag) still
    runs all 317.
  - Invalid `--role` value → exit 2 with a clear error message.

### Changed (breaking vs v0.1.0)

- The v0.1.0 webapp's runner used a "shape-only" pass condition
  inflated by `coverage` cases (see
  [MAS-219](/MAS/issues/MAS-219), the original blocker). The v2
  runner does not — every `live` case contacts a real target or the
  in-process mock. **A conformance score computed with the v0.1.0
  runner is not comparable to a v2 score**; this is the whole point
  of v2.

- The v0.1.0 webapp collected failures forever (the "demo UX").
  The v2 tool halts on the first real failure. There is no
  "continue on error" mode in v2. If you need that, run the failing
  cases one-by-one with separate `run` invocations.

- The v0.1.0 webapp's precheck was advisory. The v2 tool's precheck
  is a separate exit-code-4 gate. A target that is down never
  reaches the catalog loop.

- The v0.1.0 webapp stores run history in a JSON file on disk. The
  v2 server is in-memory only; the CLI writes the report files.
  This is intentional: the CLI is the durable record, the server
  is the UI surface.

### Not changed

- The v0.1.0 webapp (`apps/web/`) is **not** modified by v2. It
  continues to be the recommended tool for browser-driven
  exploration of a single target with skip-tolerant reporting.
  Use v2 for CI-driven conformance scoring.

- The OID4VCI / OID4VP 1.0 Final test case catalog
  (`references/testcases/`, 317 cases) is unchanged from v0.1.0; it
  is now loaded with the v2 catalog loader and run with the v2
  runner.

### Migration notes

- If you have a v0.1.0 deployment that depends on the in-process
  pass rate being 100% on a closed port: it will not, with v2. The
  v0.1.0 webapp will continue to behave the way it always did.
- If you have CI scripts that read `report.csv` (v0.1.0's report
  format): v2 emits `report.json` + `report.junit.xml` + `report.html`.
  The JUnit XML is the standard replacement.
- If you have CI scripts that depend on the v0.1.0 `summary.total`
  field: v2's `Report.summary` uses the same shape (`total`,
  `passed`, `failed`, `skipped`) but the meaning of `passed` is
  different (real per-case pass, not shape-only).

### Security

- The Docker image runs as the non-root `app` user (uid 100) via
  su-exec. The entrypoint wrapper chowns the (possibly tmpfs-
  mounted) report dir and then drops privileges. The node process
  never runs as root.
- The HTTP server has no built-in auth. Do not expose port 8080 to
  the public internet without a reverse proxy that handles auth +
  rate limiting. This is the same posture as the v0.1.0 webapp.

## v0.1.0

The original webapp (`apps/web/`). 120/120 test suite green. The
v0.1.0 release is in active use and is **not** deprecated. See
[MAS-220](/MAS/issues/MAS-220) for the
pass-rate-coverage fix that capped the v0.1.0 inflation pattern.
