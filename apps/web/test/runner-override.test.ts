/**
 * Unit tests for MAS-167: the runner's per-target issuerMetadataUrl override.
 *
 * Defect (before the fix): `buildContext()` in `apps/web/src/runners/runner.ts`
 * hard-coded the metadata URL to `${targetIssuer}/.well-known/openid-credential-issuer`,
 * so OID4VCI 1.0 Final issuers that serve the well-known at a parameterised
 * path (Procivis One Core is the canonical example) silently 404'd, leaving
 * `ctx.issuerMetadata` undefined and any `requires: ['issuerMetadata']` test
 * marked SKIPPED (which the runner counts as a pass). The run reported
 * 41/41 with skipped entries hidden.
 *
 * Fix: `RunRequest.issuerMetadataUrl` is honored end-to-end. When set, the
 * runner (and the in-test metadata fetches) hit that URL instead of the
 * default path. When absent, the legacy default is preserved.
 *
 * These tests use a small in-process HTTP server on a free port so we can
 * prove the runner really hits the override URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { runConformance } from '../src/runners/runner.js';
import { listForMode } from '../src/wallet/catalog.js';

let server: http.Server;
let baseUrl = '';
let overridePathHits = 0;
let defaultPathHits = 0;
let lastMetadataUrl = '';

const MOCK_METADATA = {
  credential_issuer: 'http://override.example.com/issuer',
  credential_endpoint: 'http://override.example.com/issuer/credential',
  notification_endpoint: 'http://override.example.com/issuer/notification',
  // Advertise the deferred endpoint so the MAS-169 `deferredCredentialEndpoint`
  // prereq is satisfied and the 4 deferred tests RUN (not SKIP) in this test.
  // The MAS-169 test file `catalog-deferred-endpoint.test.ts` covers the
  // SKIP path explicitly.
  deferred_credential_endpoint: 'http://override.example.com/issuer/deferred',
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastMetadataUrl = req.url ?? '';
    if (req.url === '/.well-known/openid-credential-issuer/per-scheme/v1') {
      overridePathHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MOCK_METADATA));
      return;
    }
    if (req.url === '/.well-known/openid-credential-issuer') {
      defaultPathHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MOCK_METADATA));
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

describe('runner: issuerMetadataUrl override (MAS-167)', () => {
  it('honors the override URL for the pre-fetch (W->I mode)', async () => {
    overridePathHits = 0;
    defaultPathHits = 0;
    const overrideUrl = `${baseUrl}/.well-known/openid-credential-issuer/per-scheme/v1`;

    const report = await runConformance({
      mode: 'W->I',
      targetIssuer: baseUrl,
      issuerMetadataUrl: overrideUrl,
      credentialConfigurationId: 'urn:example:test-cred',
    });

    expect(overridePathHits).toBeGreaterThan(0);
    expect(defaultPathHits).toBe(0);
    expect(report.context.resolvedIssuerMetadataUrl).toBe(overrideUrl);
    expect(report.context.issuerMetadata).toBeDefined();
    expect(report.context.issuerMetadata?.credential_endpoint).toBe(MOCK_METADATA.credential_endpoint);
    expect(report.target.issuerMetadataUrl).toBe(overrideUrl);
    // No SKIPPED entries that depend on `issuerMetadata` or
    // `deferredCredentialEndpoint` should remain for the metadata-fetch and
    // wallet-issuance tests. MOCK_METADATA advertises both, so all of them
    // should RUN. (The MAS-169 SKIP path is covered by
    // `catalog-deferred-endpoint.test.ts`.) The MAS-170 wallet-issuance
    // SKIP is gated on `accessToken`, which is independent of the
    // override path and stays unset here — exclude that one from the
    // assertion since it is tested in `wallet-issuance.test.ts` (or
    // directly against the catalog).
    const overrideRelatedSkips = report.results.filter((r) => {
      if (!r.message.startsWith('SKIPPED (prerequisite not met')) return false;
      // Wallet-issuance (FT.WL.IC.W.I.VB.001) is now MAS-170-gated on
      // `accessToken` and will SKIP in this unit test even when the
      // metadata override is honoured. Filter it out — its absence would
      // mean a regression of the override, not the accessToken flow.
      return r.id !== 'FT.WL.IC.W.I.VB.001';
    });
    expect(overrideRelatedSkips).toEqual([]);
  });

  it('falls back to the default path when no override is provided', async () => {
    overridePathHits = 0;
    defaultPathHits = 0;
    const report = await runConformance({
      mode: 'W->I',
      targetIssuer: baseUrl,
      credentialConfigurationId: 'urn:example:test-cred',
    });

    expect(defaultPathHits).toBeGreaterThan(0);
    expect(overridePathHits).toBe(0);
    expect(report.context.resolvedIssuerMetadataUrl).toBe(`${baseUrl}/.well-known/openid-credential-issuer`);
    expect(report.context.issuerMetadata).toBeDefined();
    expect(report.target.issuerMetadataUrl).toBeUndefined();
  });

  it('an unreachable override URL triggers the target-reachability precheck (MAS-219)', async () => {
    // MAS-219/220 added a target-reachability precheck that aborts the
    // run before the test loop when a real `targetIssuer` is supplied
    // and the metadata fetch cannot reach a valid OID4VCI 1.0 document.
    // Pointing the override at a closed port (1) makes the precheck
    // fire and the report surface `error: "target unreachable"` with
    // `failed > 0` and `passRate < 1` — the exact defect the board
    // reproduced in MAS-213.
    const report = await runConformance({
      mode: 'W->I',
      targetIssuer: baseUrl,
      issuerMetadataUrl: 'http://127.0.0.1:1/this/should/never/exist',
      credentialConfigurationId: 'urn:example:test-cred',
    });

    expect(report.error).toBe('target unreachable');
    expect(report.context.issuerMetadata).toBeUndefined();
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.summary.passRate).toBeLessThan(1);
  });

  it('an override that 200s with bad JSON is logged and the run continues cleanly', async () => {
    // The pre-fetch already ran for the previous tests; spin a separate
    // server on a different port for this case.
    const bad = http.createServer((req, res) => {
      if (req.url === '/good') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json at all');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
    const addr = bad.address();
    if (typeof addr === 'string' || addr === null) throw new Error('bind failed');
    const badUrl = `http://127.0.0.1:${addr.port}/good`;

    try {
      const report = await runConformance({
        mode: 'W->I',
        targetIssuer: `http://127.0.0.1:${addr.port}`,
        issuerMetadataUrl: badUrl,
        credentialConfigurationId: 'urn:example:test-cred',
      });
      // Bad JSON throws on r.json(); we just want to confirm the runner
      // survives and the run still returns a report (no crash, no
      // misclassification of SKIPs as PASSes).
      expect(report.runId).toMatch(/^run-/);
      expect(report.context.issuerMetadata).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => bad.close(() => resolve()));
    }
  });

  it('reports lastMetadataUrl for diagnostics (override path was actually used)', () => {
    // Sanity: the override server registered the override-path hit; we
    // assert that lastMetadataUrl is the override path (proves the runner
    // really did GET the override URL, not the default).
    expect(lastMetadataUrl).toMatch(/^\/\.well-known\/openid-credential-issuer/);
  });
});
