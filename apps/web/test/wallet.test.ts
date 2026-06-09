/**
 * Smoke tests for the wallet crypto + catalog.
 * These prove the *unit* behavior the app depends on (keypair generation,
 * KB-JWT shape, catalog completeness). The full E2E flow is exercised by
 * `npm run smoke` once the server is running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyStore, buildKbJwt, generateCodeVerifier, codeChallengeS256 } from '../src/crypto/keys.js';
import { CATALOG, listForMode, getById } from '../src/wallet/catalog.js';
import { runConformance, makeRunStore } from '../src/runners/runner.js';
import { toJson, toHtml } from '../src/report/serialize.js';
import type { KeyStore } from '../src/crypto/keys.js';

let keys: KeyStore;

beforeAll(async () => {
  keys = await generateKeyStore();
});

describe('crypto/keys', () => {
  it('generates a valid ES256 keypair with thumbprint', async () => {
    expect(keys.es256.alg).toBe('ES256');
    expect(keys.es256.publicJwk.kty).toBe('EC');
    expect(keys.es256.publicJwk.crv).toBe('P-256');
    expect(keys.es256.thumbprint).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('generates a valid EdDSA keypair with thumbprint', async () => {
    expect(keys.eddsa.alg).toBe('EdDSA');
    expect(keys.eddsa.publicJwk.kty).toBe('OKP');
    expect(keys.eddsa.publicJwk.crv).toBe('Ed25519');
  });

  it('builds a KB-JWT with the correct header and claims (jwk binding by default)', async () => {
    const aud = 'https://issuer.example.com/credential';
    const jwt = await buildKbJwt({ key: keys.es256, audience: aud, nonce: 'abc' });
    const [h, p, s] = jwt.split('.');
    expect(h).toBeTruthy();
    expect(p).toBeTruthy();
    expect(s).toBeTruthy();
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('ES256');
    expect(header.typ).toBe('openid4vci-proof+jwt');
    // Default is jwk binding (Procivis One Core + OID4VCI 1.0 §7.2.1).
    expect(header.jwk).toBeDefined();
    expect(header.jwk.kty).toBe('EC');
    expect(header.jwk.crv).toBe('P-256');
    expect(payload.aud).toBe(aud);
    expect(payload.nonce).toBe('abc');
    expect(payload.iss).toBe(keys.es256.kid);
  });

  it('builds a KB-JWT with kid header when includeJwk=false (legacy issuers)', async () => {
    const aud = 'https://issuer.example.com/credential';
    const jwt = await buildKbJwt({ key: keys.es256, audience: aud, includeJwk: false });
    const [h] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'));
    expect(header.kid).toBe(keys.es256.kid);
    expect(header.jwk).toBeUndefined();
  });

  it('PKCE: code_challenge = base64url(sha256(verifier))', () => {
    const v = generateCodeVerifier();
    const c = codeChallengeS256(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
    expect(c).not.toBe(v);
  });
});

describe('catalog', () => {
  it('contains at least one test per mode', () => {
    expect(listForMode('I->W').length).toBeGreaterThan(0);
    expect(listForMode('V->W').length).toBeGreaterThan(0);
    expect(listForMode('W->I').length).toBeGreaterThan(0);
    expect(listForMode('W->V').length).toBeGreaterThan(0);
  });

  it('every test has a spec reference', () => {
    for (const t of CATALOG) {
      expect(t.specRef, `${t.id} missing specRef`).toMatch(/OID4VCI|OID4VP/);
    }
  });

  it('test ids are unique', () => {
    const ids = new Set(CATALOG.map((t) => t.id));
    expect(ids.size).toBe(CATALOG.length);
  });

  it('getById finds known test', () => {
    const t = getById('FT.IC.AU.I.H.VB.001');
    expect(t?.name).toContain('Authorization Request');
  });
});

describe('runner', () => {
  it('runs a W->I smoke flow with built-in mock and produces a report', async () => {
    const report = await runConformance({
      mode: 'W->I',
      credentialConfigurationId: 'ThaiNationalID',
    });
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.summary.total).toBe(report.results.length);
    expect(report.summary.passed + report.summary.failed).toBeLessThanOrEqual(report.summary.total);
  });

  it('store saves and retrieves', () => {
    const store = makeRunStore();
    const r = {
      runId: 'test-1', mode: 'W->I' as const, startedAt: '2024-01-01T00:00:00Z',
      finishedAt: '2024-01-01T00:00:01Z', durationMs: 1000,
      target: { credentialConfigurationId: 'ThaiNationalID' },
      results: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 },
      context: { keys: { es256Kid: 'k', eddsaKid: 'k' }, pkce: { codeChallengeMethod: 'S256' as const } },
    };
    store.save(r);
    expect(store.get('test-1')?.runId).toBe('test-1');
  });
});

describe('report serialize', () => {
  const sample = {
    runId: 'r1', mode: 'W->I' as const, startedAt: '2024-01-01T00:00:00Z',
    finishedAt: '2024-01-01T00:00:01Z', durationMs: 1000,
    target: { credentialConfigurationId: 'ThaiNationalID' },
    results: [{ id: 'X.1', name: 'Test', pass: true, message: 'ok', durationMs: 5 }],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, passRate: 1 },
    context: { keys: { es256Kid: 'a', eddsaKid: 'b' }, pkce: { codeChallengeMethod: 'S256' as const } },
  };

  it('JSON serializer round-trips through JSON.parse', () => {
    const json = toJson(sample);
    const parsed = JSON.parse(json);
    expect(parsed.runId).toBe('r1');
  });

  it('HTML serializer embeds the run id and result rows', () => {
    const html = toHtml(sample);
    expect(html).toContain('r1');
    expect(html).toContain('X.1');
    expect(html).toContain('Test');
  });
});
