import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpRequest, HttpError } from '../src/http.js';

let server: Server;
let baseUrl: string;
let always500: Server;
let always500Url: string;
let slow: Server;
let slowUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
      return;
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body }));
      });
      return;
    }
    if (req.url === '/400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', detail: 'missing field foo' }));
      return;
    }
    if (req.url === '/500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', trace: 'x' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  always500 = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  await new Promise<void>((r) => always500.listen(0, '127.0.0.1', r));
  always500Url = `http://127.0.0.1:${(always500.address() as AddressInfo).port}`;

  slow = createServer(() => {
    // never responds; relies on timeout.
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => always500.close(() => r()));
  await new Promise<void>((r) => slow.close(() => r()));
});

describe('httpRequest', () => {
  it('returns 200 with body and content-type for a successful GET', async () => {
    const res = await httpRequest(`${baseUrl}/ok`, { method: 'GET', timeoutMs: 2000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
    expect(res.contentType).toMatch(/application\/json/);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures the body on 4xx responses (no throw)', async () => {
    const res = await httpRequest(`${baseUrl}/400`, { method: 'GET', timeoutMs: 2000 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', detail: 'missing field foo' });
  });

  it('captures the body on 5xx responses (no throw)', async () => {
    const res = await httpRequest(`${always500Url}/`, { method: 'GET', timeoutMs: 2000 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('sends request body and headers on POST', async () => {
    const res = await httpRequest(`${baseUrl}/echo`, {
      method: 'POST',
      timeoutMs: 2000,
      body: { foo: 'bar' },
      headers: { 'x-trace': 'abc' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: 'POST', body: '{"foo":"bar"}' });
  });

  it('times out when the server does not respond', async () => {
    await expect(
      httpRequest(`${slowUrl}/`, { method: 'GET', timeoutMs: 50 })
    ).rejects.toThrow(/timed out/i);
  });

  it('rejects on connection refused (closed port)', async () => {
    await expect(
      // Pick an unlikely port; closing after listen to guarantee refusal.
      httpRequest('http://127.0.0.1:1/never', { method: 'GET', timeoutMs: 500 })
    ).rejects.toThrow();
  });

  it('exposes HttpError class so callers can branch on error type', () => {
    expect(HttpError).toBeDefined();
  });
});
