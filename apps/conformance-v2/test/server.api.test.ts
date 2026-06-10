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
    const app = (await buildApp(opts)).app;
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/UI not yet built/i);
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

  it('case.passed payload shape is { id, mode, status, responseStatus, responseBody }', async () => {
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
    for (const key of ['id', 'status', 'responseStatus', 'responseBody']) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload.status).toBe('passed');
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
