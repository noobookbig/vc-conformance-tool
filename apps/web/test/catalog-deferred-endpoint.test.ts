/**
 * Unit tests for MAS-169: the runner's `deferredCredentialEndpoint` prereq.
 *
 * Defect (before the fix): the four deferred-credential tests in
 * `apps/web/src/wallet/catalog.ts` had `requires: ['issuerMetadata']` plus a
 * hard in-test `if (!ctx.issuerMetadata?.deferred_credential_endpoint) fail(...)`
 * guard. The runner pre-fetched metadata successfully (MAS-167's fix in
 * place), so the prereq was satisfied, and the in-test guard tripped on
 * Procivis One Core's metadata, which does not advertise the deferred
 * endpoint. Net result: 4 W->I tests reported FAIL where the spec actually
 * allows SKIP (OID4VCI 1.0 §8.1 makes `deferred_credential_endpoint`
 * OPTIONAL — issuers are not required to advertise it).
 *
 * Fix: introduce a derived prereq `'deferredCredentialEndpoint'`. The runner
 * treats it as satisfied only when `ctx.issuerMetadata.deferred_credential_endpoint`
 * is a non-empty string. The four tests now use this prereq and drop the
 * in-test `fail()` guard. Issuers that do not advertise the endpoint get
 * the affected tests SKIPPED (not FAILED), matching the existing behavior
 * for `requires: ['issuerMetadata']` when the metadata fetch itself fails.
 *
 * These tests use a small in-process HTTP server on a free port so we can
 * prove the runner really inspects `deferred_credential_endpoint` on the
 * fetched metadata and that the SKIP is emitted cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { runConformance } from '../src/runners/runner.js';
import { listForMode } from '../src/wallet/catalog.js';

let server: http.Server;
let baseUrl = '';

const DEFERRED_TEST_IDS = [
  'FT.IC.DC.I.H.VB.001',
  'FT.IC.DC.I.H.IB.003',
  'FT.IC.DC.I.H.IB.004',
  'FT.WL.DC.W.V.VB.001',
];

function makeMetadata(opts: { includeDeferredEndpoint: boolean }) {
  return {
    credential_issuer: `${baseUrl}/issuer`,
    credential_endpoint: `${baseUrl}/issuer/credential`,
    ...(opts.includeDeferredEndpoint
      ? { deferred_credential_endpoint: `${baseUrl}/issuer/deferred` }
      : {}),
    credential_configurations_supported: {
      'urn:example:test-cred': {
        format: 'jwt_vc_json',
        scope: 'test',
        cryptographic_binding_methods_supported: ['jwk'],
        credential_signing_alg_values_supported: ['ES256'],
        proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
      },
    },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/with-deferred') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(makeMetadata({ includeDeferredEndpoint: true })));
      return;
    }
    if (req.url === '/without-deferred') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(makeMetadata({ includeDeferredEndpoint: false })));
      return;
    }
    if (req.url === '/issuer/credential') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ credential: 'fake-credential-jwt', format: 'jwt_vc_json' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('catalog: deferredCredentialEndpoint prereq (MAS-169)', () => {
  it('SKIPs the 4 deferred tests when the issuer metadata omits deferred_credential_endpoint', async () => {
    const report = await runConformance({
      mode: 'W->I',
      targetIssuer: baseUrl,
      issuerMetadataUrl: `${baseUrl}/without-deferred`,
      credentialConfigurationId: 'urn:example:test-cred',
    });

    expect(report.context.issuerMetadata).toBeDefined();
    expect(report.context.issuerMetadata?.deferred_credential_endpoint).toBeUndefined();

    for (const id of DEFERRED_TEST_IDS) {
      const r = report.results.find((rr) => rr.id === id);
      expect(r, `expected result for ${id}`).toBeDefined();
      expect(r!.message).toBe('SKIPPED (prerequisite not met)');
      // The runner marks SKIPs as pass=true in the result struct (skipped
      // is surfaced via summary.skipped and the message). We assert the
      // pass=true + message pattern to lock in the contract.
      expect(r!.pass).toBe(true);
    }
  });

  it('RUNs the 4 deferred tests when the issuer metadata advertises deferred_credential_endpoint', async () => {
    const report = await runConformance({
      mode: 'W->I',
      targetIssuer: baseUrl,
      issuerMetadataUrl: `${baseUrl}/with-deferred`,
      credentialConfigurationId: 'urn:example:test-cred',
    });

    expect(report.context.issuerMetadata?.deferred_credential_endpoint).toBe(
      `${baseUrl}/issuer/deferred`,
    );

    for (const id of DEFERRED_TEST_IDS) {
      const r = report.results.find((rr) => rr.id === id);
      expect(r, `expected result for ${id}`).toBeDefined();
      expect(r!.message).not.toBe('SKIPPED (prerequisite not met)');
      // The tests do real shape validation; the in-process mock for the
      // deferred endpoint returns 404, which is fine for these shape tests
      // (they validate envelope shape, not endpoint reachability). All
      // four should report pass=true (shape OK).
      expect(r!.pass).toBe(true);
    }
  });

  it('the 4 deferred tests declare the new prereq key (regression guard)', () => {
    const mode = 'W->I';
    for (const id of DEFERRED_TEST_IDS) {
      const tc = listForMode(mode).find((t) => t.id === id)
        ?? listForMode('I->W').find((t) => t.id === id);
      expect(tc, `test case ${id} should exist in the catalog`).toBeDefined();
      expect(tc!.requires, `${id} should declare requires`).toBeDefined();
      expect(tc!.requires).toContain('deferredCredentialEndpoint');
      // And it should NOT carry the old `issuerMetadata` prereq in place
      // of the new one — the new prereq implies issuerMetadata too.
      expect(tc!.requires).not.toContain('issuerMetadata');
    }
  });
});
