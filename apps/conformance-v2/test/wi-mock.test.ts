import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runConformance } from '../src/runner.js';
import { httpRequest } from '../src/http.js';
import { precheck } from '../src/precheck.js';
import { EXIT_CODES } from '../src/abort.js';
import type { TestCase } from '../src/catalog/types.js';

let mock: Server;
let mockUrl: string;
let mockHits: string[];

beforeAll(async () => {
  mockHits = [];
  mock = createServer((req, res) => {
    mockHits.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
});

function liveCases(...ids: string[]): TestCase[] {
  return ids.map((id) => ({
    id,
    name: `Live ${id}`,
    operation: 'auth',
    eut: 'issuer',
    suite: 'holder',
    behavior: 'valid',
    kind: 'live',
  }));
}

describe('wi-mock (in-process mock issuer; all live cases pass; exit 0)', () => {
  it('precheck passes against the mock', async () => {
    const r = await precheck({ targetIssuer: `${mockUrl}/.well-known/openid-credential-issuer` });
    expect(r.ok).toBe(true);
  });

  it('runner exits 0 and writes a full pass when every case matches the mock', async () => {
    const cases = liveCases('A', 'B', 'C', 'D', 'E');
    const report = await runConformance({
      catalog: cases,
      runCase: async (tc) => {
        const res = await httpRequest(`${mockUrl}/case/${tc.id}`, { method: 'GET', timeoutMs: 2000 });
        return { passed: res.status === 200, responseStatus: res.status, responseBody: res.body };
      },
      target: { targetIssuer: mockUrl },
    });
    expect(report.aborted).toBe(false);
    expect(report.abortedAt).toBeNull();
    expect(report.summary.passed).toBe(cases.length);
    expect(report.summary.failed).toBe(0);
    // Exit code contract: full pass = 0.
    expect(EXIT_CODES.PASS).toBe(0);
    // The mock was actually contacted for every case.
    expect(mockHits.filter((h) => h.startsWith('/case/'))).toHaveLength(cases.length);
  });

  it('summary numbers add up to the catalog size when all pass', async () => {
    const cases = liveCases('X', 'Y', 'Z');
    const report = await runConformance({
      catalog: cases,
      runCase: async () => ({ passed: true, responseStatus: 200 }),
      target: {},
    });
    expect(report.summary.passed + report.summary.failed + report.summary.skipped).toBe(cases.length);
  });
});
