# Design notes — vc-conformance-test webapp

A short, evolving record of design decisions for the conformance test webapp.
For the current plan, see [MAS-131 plan document](/MAS/issues/MAS-131#document-plan).

## What it is

A Dockerized webapp that simulates an OID4VCI / OID4VP wallet and runs it
against a target issuer or verifier (or against the in-process mock). It
produces a downloadable conformance report.

## Why one app, not three (issuer / verifier / wallet)

Per the MAS-131 plan, the four role cross-modes need a wallet that is
reusable on both the driver and the EUT sides. Splitting into three apps
would mean two of them were 90% identical. One TS app, one deployment.

## Why in-process mock issuer/verifier

- `docker compose up` must work with no external dependency.
- A real conformance run can swap the target via the UI or env. The mock
  is the "no target" demo path, not a reference implementation.

## Why no SQLite for v1

- In-memory `Map` for the run store is enough at this scale.
- Reports are persisted to `data/reports/<id>.json` so a restart does not
  lose history.
- Add SQLite when we need a query layer for cross-run history or trends.

## Why no PDF

- JSON is the canonical artifact (machine-digestible, easy to diff).
- HTML is the human artifact (downloadable, viewable offline).
- PDF is one more dependency with no concrete user request.

## Why no PKI/CA chain for v1

- v1 uses dev keys generated in-process at server boot.
- A real Thai national ID signing key is a one-way-door decision and is
  explicitly out of scope for v1. See the parent issue plan.

## What v1 explicitly does NOT do

- Auth on the dashboard
- Multi-user support
- Webhook triggers to external CI
- Persistent historical dashboard
- Full 283-case coverage (curated subset only)
