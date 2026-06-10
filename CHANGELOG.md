# Changelog

All notable changes to this repository are documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does **not** yet follow SemVer strictly; the major version
identifies the conformance-test generation (v0.1.0 was the original
webapp, v2.0.0 is the new engine + UI + server stack).

## v2.0.0 — unreleased

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
