/**
 * MAS-312.A: end-to-end tests for the VP-via-QR submission endpoint
 * (`POST /api/qr/send-vp`) and the matching runner entry point
 * (`runConformanceQrVp`).
 *
 * The "send-vp-request" flow is what a tester drives when they scan an
 * `openid4vp://` QR with a phone wallet and the wallet then POSTs the
 * signed vp_token back to the verifier. The conformance tool needs to
 * exercise the same path on behalf of the wallet simulator, so the
 * endpoint accepts the QR payload, parses it, and submits the VP.
 *
 * What this test file proves:
 *   1. The endpoint returns `{ ok: true, status, response }` on a
 *      well-formed QR plus a happy-path verifier response.
 *   2. It returns `{ ok: false, error, details }` on a malformed QR
 *      (missing client_id, missing dcql_query, etc.) without
 *      touching the network.
 *   3. It returns `{ ok: false, error }` when the verifier responds
 *      with a non-2xx (e.g. an audience mismatch on the KB-JWT).
 *   4. The runner entry point is callable independently (so MAS-312.B
 *      and MAS-312.C can drive it from the UI and from QA fixtures).
 *
 * The verifier is stubbed with a tiny in-process HTTP server (same
 * pattern as `runner-override.test.ts`) so the test is hermetic and
 * does not need the full webapp mounted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp } from '../src/server.js';
import { runConformanceQrVp } from '../src/runners/runner.js';
import { validateQrPayload } from '../src/qr/validate.js';

interface CapturedPost {
  url: string;
  contentType: string;
  body: unknown;
}

let server: http.Server;
let verifierBaseUrl = '';
let captured: CapturedPost[] = [];

const dcql = { credentials: [{ id: 'pid', format: 'dc+sd-jwt' }] };

function vpRequestQr(verifierPath = '/response'): string {
  const params = new URLSearchParams({
    client_id: `${verifierBaseUrl}${verifierPath}`.replace(/\/response$/, ''),
    response_type: 'vp_token',
    dcql_query: JSON.stringify(dcql),
  });
  return `openid4vp://authorize?${params.toString()}`;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/response' || req.url?.startsWith('/response?'))) {
      let chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        captured.push({
          url: req.url ?? '',
          contentType: (req.headers['content-type'] as string) ?? '',
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 'ok' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('failed to bind test server');
  verifierBaseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('MAS-312.A: validateQrPayload("send-vp-request", …)', () => {
  it('parses a QR with inline DCQL and exposes client_id + dcql_query', () => {
    const r = validateQrPayload('send-vp-request', vpRequestQr());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('vp_request');
    expect(r.details.client_id).toBe(verifierBaseUrl);
    expect(r.details.dcql_query).toEqual(dcql);
  });
});

describe('MAS-312.A: POST /api/qr/send-vp (happy path)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];

  beforeAll(async () => {
    ({ app } = await buildApp({ logger: false }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses a well-formed QR, builds a VP, and POSTs it to the verifier response_uri', async () => {
    captured = [];
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/send-vp',
      payload: {
        qrPayload: vpRequestQr(),
        targetVerifier: verifierBaseUrl,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(captured.length).toBe(1);
    const sent = captured[0] as { url: string; contentType: string; body: unknown };
    expect(sent.url).toBe('/response');
    expect(sent.contentType).toMatch(/application\/json/);
    const sentBody = sent.body as { vp_token?: string; dcql_query?: unknown; state?: string; client_id?: string };
    expect(typeof sentBody.vp_token).toBe('string');
    expect(sentBody.vp_token?.split('.').length).toBe(3);
    expect(sentBody.dcql_query).toEqual(dcql);
  });

  it('honours a custom response_uri when the QR carries one', async () => {
    captured = [];
    const customUri = `${verifierBaseUrl}/response?run=custom`;
    const qrParams = new URLSearchParams({
      client_id: verifierBaseUrl,
      response_type: 'vp_token',
      response_uri: customUri,
      dcql_query: JSON.stringify(dcql),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/send-vp',
      payload: {
        qrPayload: `openid4vp://authorize?${qrParams.toString()}`,
        targetVerifier: verifierBaseUrl,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe('/response?run=custom');
  });

  it('returns 400 on a malformed QR (missing client_id) without contacting the verifier', async () => {
    captured = [];
    const badQr = 'openid4vp://authorize?response_type=vp_token&dcql_query=' + encodeURIComponent(JSON.stringify(dcql));
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/send-vp',
      payload: {
        qrPayload: badQr,
        targetVerifier: verifierBaseUrl,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/client_id/);
    expect(captured.length).toBe(0);
  });

  it('returns 400 on a QR that omits request_uri / dcql_query / presentation_definition', async () => {
    const badQr = 'openid4vp://authorize?client_id=' + encodeURIComponent(verifierBaseUrl) + '&response_type=vp_token';
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/send-vp',
      payload: {
        qrPayload: badQr,
        targetVerifier: verifierBaseUrl,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/request_uri|dcql_query|presentation_definition/);
  });

  it('returns { ok: false } when the verifier responds with a 4xx', async () => {
    // Re-bind a one-off server that always 400s so the happy-path test
    // suite above stays stable. We then close it before the next test.
    const bad = http.createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'aud mismatch' }));
    });
    await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
    const addr = bad.address();
    if (typeof addr === 'string' || addr === null) throw new Error('failed to bind bad verifier');
    const badBase = `http://127.0.0.1:${addr.port}`;
    const badQrParams = new URLSearchParams({
      client_id: badBase,
      response_type: 'vp_token',
      dcql_query: JSON.stringify(dcql),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/send-vp',
      payload: {
        qrPayload: `openid4vp://authorize?${badQrParams.toString()}`,
        targetVerifier: badBase,
      },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(400);
    expect(body.error).toMatch(/verifier/);
    await new Promise<void>((resolve) => bad.close(() => resolve()));
  });
});

describe('MAS-312.A: runConformanceQrVp (runner entry point)', () => {
  it('produces a result with a KB-JWT and a verifier response status', async () => {
    captured = [];
    const result = await runConformanceQrVp({
      qrPayload: vpRequestQr(),
      targetVerifier: verifierBaseUrl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(captured.length).toBe(1);
    const sent = captured[0] as { url: string; body: { vp_token?: string } };
    expect(sent.body.vp_token?.split('.').length).toBe(3);
  });

  it('returns an invalid_qr failure when the QR has no client_id', async () => {
    const r = await runConformanceQrVp({
      qrPayload: 'openid4vp://authorize?response_type=vp_token',
      targetVerifier: verifierBaseUrl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/client_id/);
  });
});
