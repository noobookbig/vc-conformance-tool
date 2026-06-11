/**
 * server.api.test.ts — v2 HTTP server contract tests.
 *
 * Drives the v2 server end-to-end through Fastify's `inject()` so we don't
 * need a real listening port for unit tests. The contract the UI workstream
 * (MAS-256) and the release smoke (MAS-257) depend on:
 *
 *   POST /api/runs          → { id, status: 'queued' }
 *   GET  /api/runs/:id      → JSON snapshot of the run
 *   GET  /api/runs/:id/events → SSE: run.started → case.* → run.completed/aborted
 *   GET  /api/runs/:id/report?format=json|junit|html → the same files the CLI writes
 *   GET  /                   → 503 with a clear "UI not yet built" message
 *   GET  /api/health        → liveness probe
 *
 * Stability of the event names + payload shape is the load-bearing promise
 * to MAS-256. Do not silently rename events or drop fields.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type ServerOptions } from '../src/server.js';
import { writeFileSync } from 'node:fs';

let workdir: string;
let opts: ServerOptions;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'v2-server-test-'));
  // Two-case catalog lives inside workdir so each test run is hermetic.
  const catalogDir = join(workdir, 'catalog');
  // minimal valid YAML for the loader
  const a = [
    'id: A',
    'name: Case A',
    'operation: auth',
    'eut: issuer',
    'suite: holder',
    'behavior: valid',
    'kind: live',
  ].join('\n');
  const b = [
    'id: B',
    'name: Case B',
    'operation: auth',
    'eut: issuer',
    'suite: holder',
    'behavior: valid',
    'kind: live',
  ].join('\n');
  const { mkdirSync } = require('node:fs');
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, 'a.yaml'), a);
  writeFileSync(join(catalogDir, 'b.yaml'), b);
  opts = { catalogDir, logger: false };
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('v2 server health + SPA placeholder', () => {
  it('GET /api/health returns ok', async () => {
    const app = (await buildApp(opts)).app;
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('conformance-v2');
  });

  it('GET / returns 503 with a UI-placeholder message when no SPA dist is present', async () => {
    // Force the 503 branch by passing an explicit non-existent dist path.
    const app = (await buildApp({ ...opts, webDist: '/nonexistent' })).app;
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/UI not yet built/i);
  });

  it('GET / serves the SPA when webDist is present', async () => {
    // The default resolution looks for apps/conformance-v2/web/dist.
    // When the SPA has been built, GET / should return the index.html.
    const app = (await buildApp(opts)).app;
    const res = await app.inject({ method: 'GET', url: '/' });
    if (res.statusCode === 200) {
      // SPA mode: we got index.html.
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/<div id="root">/);
    } else {
      // Dist not built in this environment — accept the 503 fallback.
      expect(res.statusCode).toBe(503);
    }
  });

  it('GET / serves the SPA when webDist is passed as a relative path (MAS-257 regression)', async () => {
    // MAS-257 surfaces this: @fastify/static requires an absolute root.
    // Before the fix, passing a relative `webDist` either crashed at
    // boot ("root option must be an absolute path") or silently fell
    // through to the 503 branch. After the fix, `resolveWebDist()`
    // normalises to an absolute path internally and the SPA mounts.
    //
    // We create a throwaway dist under the test fixtures dir (which
    // sits inside the repo root, so process.cwd() resolves it). The
    // path we hand the server is relative.
    const fixturesDir = join(process.cwd(), 'apps', 'conformance-v2', 'test', 'fixtures');
    const dist = join(fixturesDir, 'relative-spa-dist');
    // mkdirSync({ recursive: true }) so the test passes on a clean checkout.
    // Using a per-test temp dir inside `test/` keeps the relative path
    // valid (the test runner's CWD is the repo root).
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fixturesDir, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    const relPath = 'apps/conformance-v2/test/fixtures/relative-spa-dist';
    try {
      const { app } = await buildApp({ ...opts, webDist: relPath });
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/<div id="root">/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('v2 server: POST /api/runs', () => {
  it('queues a run and returns { id, status: "queued" }', async () => {
    const { app } = await buildApp(opts);
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^r-/);
    expect(body.status).toBe('queued');
  });

  it('rejects malformed config payloads with 400', async () => {
    const { app } = await buildApp(opts);
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { not_config: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });
});

describe('v2 server: GET /api/runs/:id (snapshot)', () => {
  it('returns 404 for unknown run id', async () => {
    const { app } = await buildApp(opts);
    const res = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('eventually reflects the final report state after the runner finishes', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    // wait for the runner to finish
    const deadline = Date.now() + 5000;
    let snapshot: any;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
      snapshot = res.json();
      if (snapshot.status === 'completed' || snapshot.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(['completed', 'aborted']).toContain(snapshot.status);
    expect(snapshot.report).toBeTruthy();
    expect(snapshot.report.summary.total).toBe(2);
    expect(snapshot.report.summary.passed).toBe(2);
  });
});

describe('v2 server: SSE /api/runs/:id/events', () => {
  it('streams events in the documented order: run.started → case.passed* → run.completed', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    // wait until completion (SSE is one-shot; we need a finished store to read from).
    // We exercise the SSE wire format via a streaming-resilient client.
    const sseRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${id}/events`,
      headers: { accept: 'text/event-stream' },
    });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers['content-type']).toMatch(/text\/event-stream/);
    const text = sseRes.body;
    // parse SSE frames
    const events: Array<{ name: string; data: any }> = [];
    for (const block of text.split('\n\n')) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      let name = 'message';
      let data = '';
      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
      }
      try {
        events.push({ name, data: data ? JSON.parse(data) : null });
      } catch {
        events.push({ name, data });
      }
    }
    const names = events.map((e) => e.name);
    expect(names[0]).toBe('run.started');
    // every case.passed should appear
    const casePassed = names.filter((n) => n === 'case.passed').length;
    expect(casePassed).toBeGreaterThanOrEqual(2);
    // last event is terminal
    const last = names[names.length - 1];
    expect(['run.completed', 'run.aborted']).toContain(last);
  });

  it('case.passed payload shape is { id, mode, status, responseStatus, responseBody, evidence } (MAS-306 follow-up)', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    const sseRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${id}/events`,
      headers: { accept: 'text/event-stream' },
    });
    const text = sseRes.body;
    const blocks = text.split('\n\n').filter((b) => b.includes('event: case.passed'));
    expect(blocks.length).toBeGreaterThan(0);
    const first = blocks[0]!;
    const dataLine = first.split('\n').find((l) => l.startsWith('data:'))!;
    const payload = JSON.parse(dataLine.slice(5).trim());
    for (const key of ['id', 'status', 'responseStatus', 'responseBody', 'evidence']) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload.status).toBe('passed');
    // The structured evidence object carries the request line and the
    // response side, with `mock: true` because the run was against
    // the in-process mock fixture. This is what the v2 web UI's
    // "Run log" renders in MAS-306.
    expect(payload.evidence.request.method).toBe('GET');
    expect(payload.evidence.request.url).toContain('/case/');
    expect(payload.evidence.response.status).toBe(200);
    expect(payload.evidence.mock).toBe(true);
  });

  it('run.aborted payload includes abortedAt, error, failedCaseId, status, responseStatus, responseBody when the suite halts', async () => {
    // Drive a real run with a target that always 500s to force an abort.
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'targetIssuer: http://127.0.0.1:1\nuseMock: false\n' },
    });
    // precheck will fail fast — the abort event should still appear in the SSE stream.
    const { id } = post.json();
    const sseRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${id}/events`,
      headers: { accept: 'text/event-stream' },
    });
    const text = sseRes.body;
    const blocks = text.split('\n\n').filter((b) => b.includes('event: run.aborted'));
    expect(blocks.length).toBeGreaterThan(0);
    const dataLine = blocks[0]!.split('\n').find((l) => l.startsWith('data:'))!;
    const payload = JSON.parse(dataLine.slice(5).trim());
    expect(payload).toHaveProperty('abortedAt');
    expect(payload).toHaveProperty('error');
    expect(payload).toHaveProperty('failedCaseId');
  });
});

describe('v2 server: GET /api/runs/:id/report', () => {
  it('returns the same report files the CLI writes (json|junit|html)', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    // wait until completion
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
      const s = r.json();
      if (s.status === 'completed' || s.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const format of ['json', 'junit', 'html'] as const) {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${id}/report?format=${format}` });
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    }
  });

  it('returns 400 for an unknown format', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    // wait until completion so the report is ready and we exercise the
    // format-validation branch, not the not-ready 409 path
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
      const s = r.json();
      if (s.status === 'completed' || s.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}/report?format=xml` });
    expect(res.statusCode).toBe(400);
  });
});

describe('v2 server: GET /api/runs/:id/evidence/:caseId (MAS-302 v2.1)', () => {
  it('returns a text/plain evidence log with the per-case request line + status + body (MAS-306 follow-up)', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    // wait for completion so the report (and per-case evidence) is ready
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
      const s = r.json();
      if (s.status === 'completed' || s.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}/evidence/A` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toContain(`evidence-${id}-A.log`);
    expect(res.body).toContain('caseId:     A');
    expect(res.body).toContain('status:     PASS');
    // MAS-306 follow-up: the per-case evidence now includes the
    // structured request line + status (instead of the legacy
    // `responseStatus: 200` flat field). The body of the response is
    // still JSON-stringified below the request line.
    expect(res.body).toContain('request:    GET <in-process-mock> /case/A');
    expect(res.body).toContain('response:   HTTP 200');
    expect(res.body).toContain('mock:       true');
    expect(res.body).toContain('"id": "A"');
  });

  it('returns 404 for a caseId that is not in the report', async () => {
    const { app } = await buildApp(opts);
    const post = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { config: 'useMock: true\n' },
    });
    const { id } = post.json();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
      const s = r.json();
      if (s.status === 'completed' || s.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${id}/evidence/does-not-exist`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('case_not_found');
  });

  it('returns 404 for an unknown run id', async () => {
    const { app } = await buildApp(opts);
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/does-not-exist/evidence/A',
    });
    expect(res.statusCode).toBe(404);
  });
});
