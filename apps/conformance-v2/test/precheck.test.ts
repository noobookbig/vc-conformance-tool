import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { precheck } from '../src/precheck.js';

let ok: Server;
let okUrl: string;
let closed: { url: string };

beforeAll(async () => {
  ok = createServer((req, res) => {
    if (req.url === '/server-error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"oops"}');
      return;
    }
    if (req.url === '/client-error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => ok.listen(0, '127.0.0.1', r));
  okUrl = `http://127.0.0.1:${(ok.address() as AddressInfo).port}`;
  closed = { url: 'http://127.0.0.1:1/never' };
});

afterAll(async () => {
  await new Promise<void>((r) => ok.close(() => r()));
});

describe('precheck', () => {
  it('passes when all targets respond 2xx', async () => {
    const result = await precheck({ targetIssuer: `${okUrl}/.well-known/openid-credential-issuer` });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('passes when no targets are configured (in-process mock mode)', async () => {
    const result = await precheck({});
    expect(result.ok).toBe(true);
  });

  it('fails with "target unreachable" when the port is closed', async () => {
    const result = await precheck({ targetIssuer: closed.url });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target unreachable');
    expect(result.failedTarget).toBe(closed.url);
    expect(result.reason).toMatch(/refused|timeout|unreachable|transport|failure/i);
  });

  it('fails with "target unreachable" on a 5xx response', async () => {
    const result = await precheck({ targetIssuer: `${okUrl}/server-error` });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target unreachable');
    expect(result.status).toBe(500);
  });

  it('fails with "target unreachable" on a 4xx response', async () => {
    const result = await precheck({ targetIssuer: `${okUrl}/client-error` });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target unreachable');
  });

  it('honors a custom timeout', async () => {
    const result = await precheck({ targetIssuer: closed.url, timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target unreachable');
  });
});
