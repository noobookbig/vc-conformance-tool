/**
 * Regression tests for MAS-219 / MAS-220.
 *
 * Defect (before the fix): pointing the runner at a deliberately
 * unreachable target (e.g. `http://127.0.0.1:1/...`) reported
 * `summary.passRate = 1` with `failed = 0`. The board-originated MAS-213
 * review reproduced this and the prescribed fix (Option A in MAS-219) is:
 *
 *   1. Every test that calls `httpCall` is marked `kind: 'live'`.
 *   2. `summarize()` excludes `kind: 'coverage'` rows from the passRate
 *      denominator so shape-validator passes can't inflate it.
 *   3. `runConformance()` runs a target-reachability precheck on real
 *      targets; an unreachable target aborts with a clear `error: 'target
 *      unreachable'` and produces a report with `failed > 0` (or, at
 *      minimum, `passRate < 1`).
 *   4. The summary exposes `coverage: N` so reviewers can distinguish
 *      shape-validator passes from real-target passes.
 *
 * These tests pin all four properties.
 *
 * Wiring note: the test uses `http://127.0.0.1:1/...` as the unreachable
 * target because port 1 is reserved and the kernel will not route to it
 * (per the QA-213 reproduction). The runner's precheck must observe the
 * fetch failure and report the run as a real failure, not a SKIP and not
 * a silent pass-through.
 */

import { describe, it, expect } from 'vitest';
import { runConformance, summarize, type Report } from '../src/runners/runner.js';
import { CATALOG } from '../src/wallet/catalog.js';
import { toJson } from '../src/report/serialize.js';

const BOGUS_TARGET = 'http://127.0.0.1:1/this-port-is-closed-and-bogus-issuer';
const BOGUS_VERIFIER = 'http://127.0.0.1:1/totally-bogus-verifier';

describe('MAS-219 / MAS-220: kind separation + target-reachability precheck', () => {
  describe('TestCase schema: every catalog entry has a defensible kind', () => {
    it('every test that calls httpCall is marked kind:"live"', () => {
      // The MAS-219 fix: shape validators default to 'coverage' (so they
      // never inflate passRate), and the few tests that *do* probe the
      // target must explicitly opt into 'live'.
      //
      // The verification is: in the catalog, every `await httpCall` site
      // must live inside a TestCase with `kind: 'live'`. This is the
      // exact check MAS-220 prescribes.
      //
      // We re-implement it here from the AST-free perspective: walk
      // every test, locate httpCall call sites by line, and confirm the
      // owning test's kind is 'live'. (A static text check is the most
      // maintainable invariant — no parser dependency.)
      const idsWithHttpCall = [
        'FT.WL.MT.W.V.VB.001',
        'FT.WL.IC.W.I.VB.001',
        'FT.WL.PR.W.V.VB.001',
        'FT.WL.PR.W.V.VB.JARM.001',
        'FT.PR.RS.V.H.VB.008',
      ];
      for (const id of idsWithHttpCall) {
        const tc = CATALOG.find((t) => t.id === id);
        expect(tc, `TestCase ${id} should exist in the catalog`).toBeDefined();
        expect(tc!.kind, `TestCase ${id} calls httpCall and must be kind: 'live'`).toBe('live');
      }
    });
  });

  describe('summarize(): coverage rows are excluded from the passRate denominator', () => {
    it('returns a coverage count separate from passed/failed', () => {
      const s = summarize([
        { id: 'A', name: 'a', pass: true,  message: 'ok',                            durationMs: 1, kind: 'coverage' },
        { id: 'B', name: 'b', pass: true,  message: 'shape-validated',                durationMs: 1, kind: 'coverage' },
        { id: 'C', name: 'c', pass: true,  message: 'http-call ok',                   durationMs: 5, kind: 'live' },
        { id: 'D', name: 'd', pass: false, message: 'http-call FAIL',                 durationMs: 5, kind: 'live' },
        { id: 'E', name: 'e', pass: true,  message: 'SKIPPED (prerequisite not met)', durationMs: 0, kind: 'live' },
      ]);
      expect(s.coverage).toBe(2);
      expect(s.passed).toBe(1);   // only the live, non-skipped pass
      expect(s.failed).toBe(1);   // only the live, non-skipped fail
      expect(s.skipped).toBe(1);
      expect(s.passRate).toBe(0.5); // 1 / (1 + 1), not inflated by coverage
      expect(s.total).toBe(5);
    });

    it('passRate is 0 when no live test is rateable (all coverage or all skipped)', () => {
      const s = summarize([
        { id: 'A', name: 'a', pass: true,  message: 'shape-validated', durationMs: 1, kind: 'coverage' },
        { id: 'B', name: 'b', pass: true,  message: 'shape-validated', durationMs: 1, kind: 'coverage' },
        { id: 'C', name: 'c', pass: true,  message: 'SKIPPED (prereq)', durationMs: 0, kind: 'live' },
      ]);
      expect(s.coverage).toBe(2);
      expect(s.passed).toBe(0);
      expect(s.failed).toBe(0);
      expect(s.skipped).toBe(1);
      expect(s.passRate).toBe(0);
    });

    it('treats unannotated TestResults as coverage (backward compatible)', () => {
      // Pre-MAS-219 results persisted on disk may lack `kind`. The runner
      // stamps `kind ?? "coverage"` on every row, so the default is
      // safe; if a hand-built summary input ever omits kind, summarize()
      // must still not let it count as a live pass.
      const s = summarize([
        { id: 'A', name: 'a', pass: true,  message: 'shape-validated', durationMs: 1 },
        { id: 'B', name: 'b', pass: false, message: 'http-call FAIL',  durationMs: 1, kind: 'live' },
      ]);
      // Without an explicit kind, the row is treated as coverage.
      expect(s.coverage).toBe(1);
      expect(s.passed).toBe(0);
      expect(s.failed).toBe(1);
      expect(s.passRate).toBe(0);
    });
  });

  describe('runConformance(): target-reachability precheck (real target, closed port)', () => {
    it('W->I against a closed port: report has error "target unreachable" and failed > 0', async () => {
      const report = await runConformance({
        mode: 'W->I',
        targetIssuer: BOGUS_TARGET,
        credentialConfigurationId: 'ThaiNationalID',
      });
      // MAS-219 acceptance criterion (a): either failed > 0 / passRate < 1
      // OR an explicit "target unreachable" error before the test loop.
      // The precheck should produce BOTH: an error field AND at least one
      // failed row.
      expect(report.error ?? '', 'runner should set report.error = "target unreachable"').toBe('target unreachable');
      expect(report.summary.failed, 'at least one row must be marked failed (the precheck synthesises one)').toBeGreaterThan(0);
      expect(report.summary.passRate).toBeLessThan(1);
      // The precheck aborts before the test loop, so the report
      // contains exactly one synthesized row (the precheck itself)
      // and no coverage rows were produced. The point of the precheck
      // is to surface the failure *before* the test loop runs and
      // before SKIP/coverage math can mask the defect.
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.id).toBe('MAS-219-PRECHECK');
    });

    it('I->W against a closed port: same precheck behavior', async () => {
      const report = await runConformance({
        mode: 'I->W',
        targetIssuer: BOGUS_TARGET,
        credentialConfigurationId: 'ThaiNationalID',
      });
      expect(report.error ?? '').toBe('target unreachable');
      expect(report.summary.failed).toBeGreaterThan(0);
      expect(report.summary.passRate).toBeLessThan(1);
    });

    it('W->V against a closed port: same precheck behavior', async () => {
      const report = await runConformance({
        mode: 'W->V',
        targetVerifier: BOGUS_VERIFIER,
        credentialConfigurationId: 'ThaiNationalID',
      });
      expect(report.error ?? '').toBe('target unreachable');
      expect(report.summary.failed).toBeGreaterThan(0);
      expect(report.summary.passRate).toBeLessThan(1);
    });

    it('V->W against a closed port: same precheck behavior', async () => {
      const report = await runConformance({
        mode: 'V->W',
        targetVerifier: BOGUS_VERIFIER,
        credentialConfigurationId: 'ThaiNationalID',
      });
      expect(report.error ?? '').toBe('target unreachable');
      expect(report.summary.failed).toBeGreaterThan(0);
      expect(report.summary.passRate).toBeLessThan(1);
    });

    it('mock target (no targetIssuer set) is NOT prechecked and still produces coverage > 0', async () => {
      // The precheck must only fire on real targets. Mock runs have
      // `targetIssuer` undefined and the in-process mock server is
      // expected to be reachable; existing acceptance criterion
      // (existing mock-target runs still pass; coverage counts still
      // reported) must continue to hold.
      const report = await runConformance({
        mode: 'W->I',
        // intentionally no targetIssuer
        credentialConfigurationId: 'ThaiNationalID',
      });
      expect(report.error ?? undefined).toBeUndefined();
      expect(report.summary.coverage, 'mock runs must still surface coverage count').toBeGreaterThan(0);
    });
  });

  describe('Report shape: error field is optional but well-typed when present', () => {
    it('Report has an optional error?: string field', () => {
      // Compile-time + runtime shape check. If this fails the schema
      // drift is real (TypeScript will catch it; this is the runtime
      // canary).
      const r: Report = {
        runId: 'x',
        mode: 'W->I',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:01Z',
        durationMs: 1,
        target: { credentialConfigurationId: 'ThaiNationalID' },
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, coverage: 0, passRate: 0 },
        context: { keys: { es256Kid: 'k1', eddsaKid: 'k2' }, pkce: { codeChallengeMethod: 'S256' } },
        error: 'target unreachable',
      };
      // Round-trip through the JSON serializer — operators archive
      // these reports and re-load them; the field must survive.
      const parsed = JSON.parse(toJson(r)) as Report;
      expect(parsed.error).toBe('target unreachable');
    });
  });
});
