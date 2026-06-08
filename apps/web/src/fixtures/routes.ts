/**
 * Mock issuer + verifier HTTP routes, mounted on the same Fastify server.
 *
 * Endpoints:
 *   GET  /.mock/issuer/.well-known/openid-credential-issuer   → issuer metadata
 *   POST /.mock/issuer/credential                              → issue VC
 *   POST /.mock/issuer/token                                   → token exchange
 *   POST /.mock/verifier/presentation-request                  → initiate VP request
 *   POST /.mock/verifier/response                              → submit vp_token
 */

import type { FastifyInstance } from 'fastify';
import { exportJWK, importJWK, calculateJwkThumbprint } from 'jose';
import { getMockIssuer, getMockVerifier } from './mocks.js';

export async function mountMockFixtures(app: FastifyInstance): Promise<void> {
  const issuer = await getMockIssuer();
  const verifier = await getMockVerifier();

  app.get('/.mock/issuer/.well-known/openid-credential-issuer', async (req, reply) => {
    const base = `${req.protocol}://${req.headers.host}/.mock/issuer`;
    reply.send({
      credential_issuer: base,
      authorization_servers: [base],
      credential_endpoint: `${base}/credential`,
      deferred_credential_endpoint: `${base}/credential/deferred`,
      notification_endpoint: `${base}/notification`,
      credential_configurations_supported: {
        ThaiNationalID: {
          format: 'jwt_vc_json',
          scope: 'th_national_id',
          cryptographic_binding_methods_supported: ['jwk'],
          credential_signing_alg_values_supported: ['ES256'],
          proof_types_supported: {
            jwt: { proof_signing_alg_values_supported: ['ES256', 'EdDSA'] },
          },
          display: [{ name: 'Thai National ID', locale: 'th-TH' }],
          claims: {
            givenName: { display: [{ name: 'ชื่อ', locale: 'th-TH' }] },
            familyName: { display: [{ name: 'นามสกุล', locale: 'th-TH' }] },
            nationality: { display: [{ name: 'สัญชาติ', locale: 'th-TH' }] },
          },
        },
        ThaiUniversityDegree: {
          format: 'jwt_vc_json',
          scope: 'th_univ_degree',
          cryptographic_binding_methods_supported: ['jwk'],
          credential_signing_alg_values_supported: ['ES256'],
          proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
          display: [{ name: 'Thai University Degree', locale: 'th-TH' }],
        },
      },
    });
  });

  app.post('/.mock/issuer/credential', async (req, reply) => {
    const body = req.body as { credential_configuration_id?: string; proofs?: { jwt?: string[] } } | undefined;
    if (!body?.credential_configuration_id) return reply.code(400).send({ error: 'invalid_request', error_description: 'credential_configuration_id required' });
    if (!body.proofs?.jwt?.[0]) return reply.code(400).send({ error: 'invalid_request', error_description: 'proofs.jwt required' });
    const proof = body.proofs.jwt[0];
    const [h, p] = proof.split('.');
    if (!h || !p) return reply.code(400).send({ error: 'invalid_request', error_description: 'malformed proof' });
    let header: any, payload: any;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'malformed proof base64' });
    }
    if (header.typ !== 'openid4vci-proof+jwt') return reply.code(400).send({ error: 'invalid_proof', error_description: 'proof typ must be openid4vci-proof+jwt' });
    if (!header.jwk && !header.kid) return reply.code(400).send({ error: 'invalid_proof', error_description: 'proof must reference holder jwk/kid' });
    const result = await issuer.issueVc({
      cnfJwk: header.jwk,
      credentialConfigurationId: body.credential_configuration_id,
      subject: `did:example:${(payload.iss || 'holder').toString().slice(-8)}`,
    });
    return reply.send({
      format: result.format,
      credential: result.credential,
      c_nonce: randomNonceStr(),
      c_nonce_expires_in: 86400,
    });
  });

  app.post('/.mock/issuer/token', async (req, reply) => {
    const body = req.body as Record<string, string> | undefined;
    if (body?.grant_type !== 'authorization_code') return reply.code(400).send({ error: 'unsupported_grant_type' });
    if (!body.code) return reply.code(400).send({ error: 'invalid_request', error_description: 'code required' });
    // For the mock, just mint a short-lived signed access token.
    const cnfJwk = (req.headers as any)['x-debug-cnf-jwk']
      ? JSON.parse((req.headers as any)['x-debug-cnf-jwk'])
      : { kty: 'EC', crv: 'P-256', x: '0', y: '0' };
    const access_token = await issuer.signAccessToken({
      subject: 'did:example:holder',
      cnfJwk,
      audience: '/.mock/issuer',
      ttlSeconds: 600,
    });
    return reply.send({ access_token, token_type: 'Bearer', expires_in: 600 });
  });

  app.post('/.mock/issuer/notification', async (_req, reply) => {
    return reply.code(204).send();
  });

  app.post('/.mock/verifier/presentation-request', async (req, reply) => {
    const body = req.body as { dcql_query?: unknown; nonce?: string; state?: string; client_id?: string; response_mode?: string } | undefined;
    if (!body?.dcql_query) return reply.code(400).send({ error: 'invalid_request', error_description: 'dcql_query required' });
    if (!body.client_id) return reply.code(400).send({ error: 'invalid_request', error_description: 'client_id required' });
    return reply.send({
      response_type: 'vp_token',
      response_mode: body.response_mode ?? 'direct_post',
      client_id: body.client_id,
      nonce: body.nonce,
      state: body.state,
      dcql_query: body.dcql_query,
      redirect_uri: '/.mock/verifier/response',
    });
  });

  app.post('/.mock/verifier/response', async (req, reply) => {
    const body = req.body as { vp_token?: string; dcql_query?: unknown; nonce?: string; state?: string; client_id?: string } | undefined;
    if (!body?.vp_token) return reply.code(400).send({ error: 'invalid_request', error_description: 'vp_token required' });
    const verdict = await verifier.evaluate({
      vp_token: body.vp_token,
      dcql_query: body.dcql_query,
      nonce: body.nonce ?? '',
      client_id: body.client_id ?? '',
    });
    if (!verdict.ok) return reply.code(400).send({ error: 'invalid_request', error_description: verdict.reason });
    return reply.send({ result: 'ok', claims: verdict.claims });
  });
}

function randomNonceStr(): string {
  // Stable import (no Node import at module top — we want this to stay tiny)
  return Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64url');
}
