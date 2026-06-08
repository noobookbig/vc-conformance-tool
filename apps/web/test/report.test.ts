/**
 * Unit tests for the diff helper and CSV serializer.
 *
 * These are the small "I shipped this and it does what the name says"
 * tests required by MAS-137 acceptance.
 */

import { describe, it, expect } from 'vitest';
import { diffReports, type RunDiff } from '../src/report/diff.js';
import { toCsv } from '../src/report/csv.js';
import { evidenceToCurl } from '../src/report/curl.js';
import type { Report } from '../src/runners/runner.js';

function makeReport(overrides: Partial<Report> & { runId: string; results: Report['results'] }): Report {
  const passed = overrides.results.filter((r) => r.pass).length;
  const failed = overrides.results.length - passed;
  return {
    runId: overrides.runId,
    mode: overrides.mode ?? 'W->I',
    startedAt: overrides.startedAt ?? '2024-01-01T00:00:00Z',
    finishedAt: overrides.finishedAt ?? '2024-01-01T00:00:01Z',
    durationMs: overrides.durationMs ?? 1000,
    target: overrides.target ?? { credentialConfigurationId: 'ThaiNationalID' },
    results: overrides.results,
    summary: overrides.summary ?? { total: overrides.results.length, passed, failed, skipped: 0, passRate: passed / (overrides.results.length || 1) },
    context: overrides.context ?? { keys: { es256Kid: 'k1', eddsaKid: 'k2' }, pkce: { codeChallengeMethod: 'S256' as const } },
  };
}

describe('diff', () => {
  it('detects pass-to-fail and fail-to-pass', () => {
    const left = makeReport({
      runId: 'L',
      results: [
        { id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 1 },
        { id: 'A.2', name: 'b', pass: false, message: 'boom', durationMs: 2 },
      ],
    });
    const right = makeReport({
      runId: 'R',
      results: [
        { id: 'A.1', name: 'a', pass: false, message: 'regressed', durationMs: 1 },
        { id: 'A.2', name: 'b', pass: true, message: 'fixed', durationMs: 2 },
      ],
    });
    const d: RunDiff = diffReports(left, right);
    expect(d.summary.passToFail).toBe(1);
    expect(d.summary.failToPass).toBe(1);
    expect(d.summary.unchanged).toBe(0);
    const a1 = d.rows.find((r) => r.id === 'A.1')!;
    const a2 = d.rows.find((r) => r.id === 'A.2')!;
    expect(a1.flip).toBe('pass-to-fail');
    expect(a2.flip).toBe('fail-to-pass');
  });

  it('detects new and removed test ids', () => {
    const left = makeReport({ runId: 'L', results: [{ id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 1 }] });
    const right = makeReport({
      runId: 'R',
      results: [
        { id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 1 },
        { id: 'A.2', name: 'b', pass: false, message: 'new fail', durationMs: 2 },
      ],
    });
    const d = diffReports(left, right);
    expect(d.summary.newFail).toBe(1);
    expect(d.summary.newPass).toBe(0);
    const a1 = d.rows.find((r) => r.id === 'A.1')!;
    expect(a1.flip).toBe('unchanged');
  });

  it('treats SKIPPED as a non-failure for diff purposes', () => {
    const left = makeReport({ runId: 'L', results: [{ id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 1 }] });
    const right = makeReport({ runId: 'R', results: [{ id: 'A.1', name: 'a', pass: true, message: 'SKIPPED (prereq missing)', durationMs: 0 }] });
    const d = diffReports(left, right);
    expect(d.summary.unchanged).toBe(1);
  });

  it('orders rows: regressions first, then improvements, then unchanged', () => {
    const left = makeReport({
      runId: 'L',
      results: [
        { id: 'X.1', name: 'unchanged', pass: true, message: 'ok', durationMs: 1 },
        { id: 'X.2', name: 'regressed', pass: true, message: 'ok', durationMs: 1 },
        { id: 'X.3', name: 'fixed', pass: false, message: 'no', durationMs: 1 },
      ],
    });
    const right = makeReport({
      runId: 'R',
      results: [
        { id: 'X.1', name: 'unchanged', pass: true, message: 'ok', durationMs: 1 },
        { id: 'X.2', name: 'regressed', pass: false, message: 'no', durationMs: 1 },
        { id: 'X.3', name: 'fixed', pass: true, message: 'ok', durationMs: 1 },
      ],
    });
    const d = diffReports(left, right);
    expect(d.rows[0]?.id).toBe('X.2');
    expect(d.rows[1]?.id).toBe('X.3');
    expect(d.rows[2]?.id).toBe('X.1');
  });
});

describe('csv', () => {
  it('emits a header row and one row per result', () => {
    const r = makeReport({
      runId: 'csv-1',
      results: [
        { id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 5 },
        { id: 'A.2', name: 'b', pass: false, message: 'no', durationMs: 7 },
      ],
    });
    const csv = toCsv(r);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('runId,mode,startedAt,finishedAt,durationMs,targetIssuer,targetVerifier,credentialConfigurationId,testId,testName,result,testDurationMs,message');
    expect(lines).toHaveLength(1 + r.results.length);
    expect(lines[1]).toContain('A.1');
    expect(lines[1]).toContain('PASS');
    expect(lines[2]).toContain('A.2');
    expect(lines[2]).toContain('FAIL');
  });

  it('RFC4180-quotes fields that contain commas, quotes, or newlines', () => {
    const r = makeReport({
      runId: 'csv-q',
      results: [
        { id: 'A.1', name: 'name, with comma', pass: true, message: 'msg "with quotes"\nnew line', durationMs: 1 },
      ],
    });
    const csv = toCsv(r);
    expect(csv).toContain('"name, with comma"');
    expect(csv).toContain('"msg ""with quotes""\nnew line"');
  });

  it('uses \\r\\n line endings (Excel-friendly)', () => {
    const r = makeReport({ runId: 'csv-lf', results: [{ id: 'A.1', name: 'a', pass: true, message: 'ok', durationMs: 1 }] });
    const csv = toCsv(r);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.includes('\n\r')).toBe(false);
  });

  it('handles empty results with just a header', () => {
    const r = makeReport({ runId: 'csv-empty', results: [] });
    const csv = toCsv(r);
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });
});

describe('evidenceToCurl', () => {
  it('builds a curl command from method/url/body', () => {
    const c = evidenceToCurl({ method: 'POST', url: 'https://issuer/x', body: { foo: 'bar' } });
    expect(c).toContain('curl -X POST');
    expect(c).toContain('https://issuer/x');
    expect(c).toContain('--data-raw');
    expect(c).toContain('{"foo":"bar"}');
  });

  it('returns null when no url is present', () => {
    expect(evidenceToCurl({ method: 'GET' })).toBeNull();
    expect(evidenceToCurl(undefined)).toBeNull();
  });

  it('shell-quotes a URL with special characters', () => {
    const c = evidenceToCurl({ method: 'GET', url: 'https://issuer/?q=a b&r=2' });
    expect(c).toContain("'https://issuer/?q=a b&r=2'");
  });
});
