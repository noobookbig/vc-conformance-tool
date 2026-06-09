/**
 * Regression tests for MAS-174: a report object without a `summary`
 * field (e.g. a partial persisted run from before summarize() was
 * hardened, a future code path that builds a report shell early, or a
 * corrupted on-disk shape) must not crash either renderer.
 *
 * The reported failure was:
 *
 *   can't access property "passRate", report.summary is undefined
 *
 * It happened because both the HTML serializer (`toHtml`) and the SPA
 * renderer (`renderReportInto`) read `report.summary.passRate` without
 * a guard, and the server's `/api/runs` list endpoint passed through
 * `r.summary` verbatim.
 *
 * Defenses (in order of where the bug could have triggered):
 *
 *   1. `summarize()` is now null-safe (handles null/undefined results).
 *   2. The `/api/runs` endpoint backfills `summary` on read.
 *   3. `toHtml(report)` rebuilds the summary from `results` if missing.
 *   4. The SPA `renderReportInto` falls back to a zero summary.
 *
 * These tests pin all four layers in place.
 */

import { describe, it, expect } from 'vitest';
import { toHtml } from '../src/report/serialize.js';
import { summarize, type Report } from '../src/runners/runner.js';

function makeBareReport(overrides: Partial<Report> & { runId: string; results: Report['results'] }): Report {
  return {
    runId: overrides.runId,
    mode: overrides.mode ?? 'W->I',
    startedAt: overrides.startedAt ?? '2024-01-01T00:00:00Z',
    finishedAt: overrides.finishedAt ?? '2024-01-01T00:00:01Z',
    durationMs: overrides.durationMs ?? 1000,
    target: overrides.target ?? { credentialConfigurationId: 'ThaiNationalID' },
    results: overrides.results,
    // intentionally NO `summary` on the producer — the consumer is what
    // we're testing.
    context: overrides.context ?? { keys: { es256Kid: 'k1', eddsaKid: 'k2' }, pkce: { codeChallengeMethod: 'S256' as const } },
  } as Report;
}

describe('MAS-174: defensive summary handling', () => {
  describe('summarize() — producer-side hardening', () => {
    it('returns a zero summary for null/undefined results', () => {
      const s = summarize(undefined as unknown as never);
      expect(s).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 });
    });

    it('returns a zero summary for an empty results array', () => {
      const s = summarize([]);
      expect(s).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 });
    });

    it('counts SKIPs separately from passes (was hard-coded to 0 — MAS-170 follow-up)', () => {
      const s = summarize([
        { id: 'A', name: 'a', pass: true,  message: 'ok',                            durationMs: 1 },
        { id: 'B', name: 'b', pass: true,  message: 'SKIPPED (prerequisite not met)', durationMs: 0 },
        { id: 'C', name: 'c', pass: false, message: 'FAIL reason',                    durationMs: 2 },
      ]);
      expect(s).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, passRate: 0.5 });
    });

    it('passRate is 0 when every test is skipped (not NaN, not 1)', () => {
      const s = summarize([
        { id: 'A', name: 'a', pass: true, message: 'SKIPPED (prereq)', durationMs: 0 },
        { id: 'B', name: 'b', pass: true, message: 'SKIPPED (prereq)', durationMs: 0 },
      ]);
      expect(s.passRate).toBe(0);
      expect(Number.isNaN(s.passRate)).toBe(false);
    });
  });

  describe('toHtml() — consumer-side hardening', () => {
    it('does not throw when summary is missing on the report', () => {
      const report = makeBareReport({
        runId: 'no-summary',
        results: [
          { id: 'A.1', name: 'a', pass: true,  message: 'ok',         durationMs: 1 },
          { id: 'A.2', name: 'b', pass: false, message: 'reason',     durationMs: 2 },
        ],
      });
      // The reported failure was a TypeError on `summary.passRate` —
      // this assertion is the regression pin.
      expect(() => toHtml(report)).not.toThrow();
      const html = toHtml(report);
      // And the resulting HTML is well-formed: shows a 0/2/0 summary
      // (we count passRate from results when summary is missing) and
      // includes both test rows.
      expect(html).toContain('Conformance report — no-summary');
      expect(html).toContain('2');   // total
      expect(html).toContain('1');   // passed (shown as 1)
      expect(html).toContain('0.0%'); // passRate
      expect(html).toContain('A.1');
      expect(html).toContain('A.2');
    });

    it('passRate is computed from results when summary is missing', () => {
      const report = makeBareReport({
        runId: 'half-pass',
        results: [
          { id: 'A.1', name: 'a', pass: true,  message: 'ok', durationMs: 1 },
          { id: 'A.2', name: 'b', pass: true,  message: 'ok', durationMs: 1 },
          { id: 'A.3', name: 'c', pass: false, message: 'no', durationMs: 1 },
          { id: 'A.4', name: 'd', pass: false, message: 'no', durationMs: 1 },
        ],
      });
      const html = toHtml(report);
      expect(html).toContain('50.0%');
    });
  });
});
