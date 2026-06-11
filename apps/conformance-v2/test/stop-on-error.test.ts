import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runConformance } from '../src/runner.js';
import type { TestCase } from '../src/catalog/types.js';

let always500: Server;
let always500Url: string;

beforeAll(async () => {
  always500 = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  await new Promise<void>((r) => always500.listen(0, '127.0.0.1', r));
  always500Url = `http://127.0.0.1:${(always500.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => always500.close(() => r()));
});

function cases(...ids: string[]): TestCase[] {
  return ids.map((id) => ({
    id,
    name: `Test ${id}`,
    operation: 'auth',
    eut: 'issuer',
    suite: 'holder',
    behavior: 'valid',
    kind: 'live',
  }));
}

describe('runConformance stop-on-error', () => {
  it('records one result row and sets abortedAt when the first case fails', async () => {
    const events: string[] = [];
    const report = await runConformance({
      catalog: cases('A', 'B', 'C', 'D'),
      runCase: async () => ({ passed: false, message: '500 boom', responseStatus: 500 }),
      target: { targetIssuer: `${always500Url}/` },
      emit: (e) => events.push(e.type),
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.id).toBe('A');
    expect(report.aborted).toBe(true);
    expect(report.abortedAt).toBe('A');
    expect(events).toEqual(['run.started', 'case.failed', 'run.aborted']);
  });

  it('continues and emits run.completed when every case passes', async () => {
    const events: string[] = [];
    const report = await runConformance({
      catalog: cases('X', 'Y', 'Z'),
      runCase: async () => ({ passed: true, responseStatus: 200 }),
      target: {},
      emit: (e) => events.push(e.type),
    });
    expect(report.results).toHaveLength(3);
    expect(report.aborted).toBe(false);
    expect(report.abortedAt).toBeNull();
    expect(events).toEqual([
      'run.started',
      'case.passed', 'case.passed', 'case.passed',
      'run.completed',
    ]);
    expect(report.summary.passed).toBe(3);
    expect(report.summary.failed).toBe(0);
  });

  it('stops on the first FAILING case and skips every case after it', async () => {
    const casesRun: string[] = [];
    const report = await runConformance({
      catalog: cases('A', 'B', 'C'),
      runCase: async (tc) => {
        casesRun.push(tc.id);
        if (tc.id === 'B') return { passed: false, message: 'fail at B', responseStatus: 500 };
        return { passed: true, responseStatus: 200 };
      },
      target: {},
    });
    expect(casesRun).toEqual(['A', 'B']); // C never runs
    expect(report.results).toHaveLength(2);
    expect(report.abortedAt).toBe('B');
  });

  it('the failing-case record carries the response status, body, and reason', async () => {
    const report = await runConformance({
      catalog: cases('A'),
      runCase: async () => ({
        passed: false,
        message: 'mismatch',
        responseStatus: 500,
        responseBody: { error: 'boom' },
      }),
      target: {},
    });
    const row = report.results[0];
    expect(row?.passed).toBe(false);
    expect(row?.responseStatus).toBe(500);
    expect(row?.responseBody).toEqual({ error: 'boom' });
  });

  it('skipped cases are reported as SKIPPED and do not trigger stop-on-error', async () => {
    const events: string[] = [];
    const report = await runConformance({
      catalog: cases('A', 'B', 'C'),
      runCase: async (tc) => {
        if (tc.id === 'B') return { passed: false, skipped: true, message: 'SKIPPED no fixture' };
        return { passed: true, responseStatus: 200 };
      },
      target: {},
      emit: (e) => events.push(e.type),
    });
    expect(report.aborted).toBe(false);
    expect(report.abortedAt).toBeNull();
    expect(report.summary.passed).toBe(2);
    expect(report.summary.skipped).toBe(1);
  });

  // MAS-305: a passed case row in the report must carry `responseBody`
  // (and `responseStatus`) so the v2 web UI's per-case evidence log
  // surfaces the actual captured response. Before the fix the runner
  // dropped `responseBody` on the pass branch, so the report.json for
  // a passing run had `responseBody: undefined` on every row and the
  // UI's "Run log" / "Failure log" collapsible rendered only the
  // placeholder message — i.e. the evidence cell on the run results
  // page showed essentially the test case id + a stub, instead of the
  // captured response. See MAS-303 for the user-reported symptom.
  it('a passing case row preserves responseBody and responseStatus (MAS-305)', async () => {
    const report = await runConformance({
      catalog: cases('A'),
      runCase: async () => ({
        passed: true,
        message: 'ok',
        responseStatus: 200,
        responseBody: { mock: true, captured: 'value' },
      }),
      target: {},
    });
    const row = report.results[0];
    expect(row?.passed).toBe(true);
    expect(row?.responseStatus).toBe(200);
    expect(row?.responseBody).toEqual({ mock: true, captured: 'value' });
  });

  it('a passing case without a responseBody still records status but no body (MAS-305)', async () => {
    const report = await runConformance({
      catalog: cases('A'),
      runCase: async () => ({ passed: true, responseStatus: 204 }),
      target: {},
    });
    const row = report.results[0];
    expect(row?.passed).toBe(true);
    expect(row?.responseStatus).toBe(204);
    expect(row?.responseBody).toBeUndefined();
  });

  it('a skipped case row preserves responseBody when the runCase provided one (MAS-305)', async () => {
    const report = await runConformance({
      catalog: cases('A', 'B'),
      runCase: async (tc) => {
        if (tc.id === 'B') {
          return {
            passed: false,
            skipped: true,
            message: 'SKIPPED prereq missing',
            responseStatus: 0,
            responseBody: { reason: 'no fixture' },
          };
        }
        return { passed: true, responseStatus: 200 };
      },
      target: {},
    });
    const skipped = report.results.find((r) => r.skipped);
    expect(skipped?.responseStatus).toBe(0);
    expect(skipped?.responseBody).toEqual({ reason: 'no fixture' });
  });
});
