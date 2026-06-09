/**
 * MAS-195: QR payload validation for the concrete flows the tool handles:
 * - receive VC offer QR
 * - receive VP request QR
 * - send VP request QR
 *
 * The validator is exposed through `/api/qr/validate` so the UI and any
 * automation can use the same parsing and error contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server.js';
import { validateQrPayload } from '../src/qr/validate.js';

let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({ logger: false }));
});

afterAll(async () => {
  await app.close();
});

describe('MAS-195: QR helper', () => {
  it('accepts a VC offer QR with credential_offer_uri', () => {
    const result = validateQrPayload(
      'receive-vc-offer',
      'openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fissuer.example.com%2Foffer%2Fabc',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('vc_offer');
    expect(result.details.credential_offer_uri).toBe('https://issuer.example.com/offer/abc');
  });

  it('accepts a VP request QR with request_uri for the receive flow', () => {
    const result = validateQrPayload(
      'receive-vp-request',
      'openid4vp://authorize?client_id=https%3A%2F%2Fverifier.example.com&request_uri=https%3A%2F%2Fverifier.example.com%2Frequest.jwt&response_type=vp_token',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('vp_request');
    expect(result.details.request_uri).toBe('https://verifier.example.com/request.jwt');
  });

  it('accepts a VP request QR with inline DCQL for the send flow', () => {
    const dcql = encodeURIComponent(JSON.stringify({
      credentials: [{ id: 'pid', format: 'dc+sd-jwt' }],
    }));
    const result = validateQrPayload(
      'send-vp-request',
      `openid4vp://authorize?client_id=verifier-test&response_type=vp_token&dcql_query=${dcql}`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('vp_request');
    expect(result.details.dcql_query).toEqual({
      credentials: [{ id: 'pid', format: 'dc+sd-jwt' }],
    });
  });

  it('rejects a VP QR that omits request_uri, dcql_query, and presentation_definition', () => {
    const result = validateQrPayload(
      'receive-vp-request',
      'openid4vp://authorize?client_id=verifier-test&response_type=vp_token',
    );

    expect(result).toEqual({
      ok: false,
      flow: 'receive-vp-request',
      error: 'VP QR must include request_uri, dcql_query, or presentation_definition',
    });
  });
});

describe('MAS-195: /api/qr/validate', () => {
  it('returns a parsed VC offer payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/validate',
      payload: {
        flow: 'receive-vc-offer',
        payload: 'openid-credential-offer://?credential_offer=%7B%22credential_issuer%22%3A%22https%3A%2F%2Fissuer.example.com%22%2C%22credential_configuration_ids%22%3A%5B%22ThaiNationalID%22%5D%7D',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      flow: 'receive-vc-offer',
      kind: 'vc_offer',
      details: {
        credential_issuer: 'https://issuer.example.com',
        credential_configuration_ids: ['ThaiNationalID'],
      },
    });
  });

  it('surfaces validation failures for malformed VP payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/qr/validate',
      payload: {
        flow: 'send-vp-request',
        payload: 'openid4vp://authorize?response_type=vp_token',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      ok: false,
      flow: 'send-vp-request',
      error: 'VP QR must include client_id',
    });
  });
});
