/**
 * In-process mock issuer + verifier.
 *
 * These are deliberately minimal: they exist so a brand-new user can
 * `docker compose up` and immediately exercise all four cross-modes
 * without needing to point at a real target. They are not a "reference
 * implementation" of OID4VCI / OID4VP — they speak just enough of the
 * protocol to be useful for smoke + demo.
 *
 * Everything runs in-memory. The mock issuer issues itself-signed JWT-VCs
 * (with a hard-coded issuer key generated at boot), and the mock verifier
 * validates a DCQL-shaped request and echoes the response.
 */

import { exportJWK, generateKeyPair, SignJWT, calculateJwkThumbprint, type JWK } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { buildKbJwt, type WalletKey } from '../crypto/keys.js';

const enc = new TextEncoder();

export interface MockIssuer {
  baseUrl: string;
  issuerJwk: JWK;
  issuerKid: string;
  issueVc(opts: { cnfJwk: JWK; credentialConfigurationId: string; subject: string; nonce?: string }): Promise<{ credential: string; format: string }>;
  signAccessToken(opts: { subject: string; cnfJwk: JWK; audience: string; ttlSeconds: number }): Promise<string>;
}

export interface MockVerifier {
  baseUrl: string;
  /** Validate a posted vp_token (KB-JWT) and return a verdict. */
  evaluate(opts: { vp_token: string; dcql_query: unknown; nonce: string; client_id: string }): Promise<{ ok: boolean; claims?: unknown; reason?: string }>;
}

interface MockHolder {
  es256: WalletKey;
  eddsa: WalletKey;
}

let mockIssuer: MockIssuer | null = null;
let mockVerifier: MockVerifier | null = null;

async function buildMockIssuer(): Promise<MockIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  pub.alg = 'ES256'; pub.crv = 'P-256';
  priv.alg = 'ES256'; priv.crv = 'P-256';
  const kid = `mock-issuer-${(await calculateJwkThumbprint(pub, 'sha256')).slice(0, 16)}`;

  return {
    baseUrl: 'http://127.0.0.1:0/mock/issuer',  // replaced when mounted
    issuerJwk: pub,
    issuerKid: kid,
    async issueVc({ cnfJwk, credentialConfigurationId, subject, nonce }) {
      const now = Math.floor(Date.now() / 1000);
      const vc: Record<string, unknown> = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'ThaiNationalIDCredential'],
        issuer: kid,
        issuanceDate: new Date(now * 1000).toISOString(),
        expirationDate: new Date((now + 3600) * 1000).toISOString(),
        credentialSubject: {
          id: `did:example:${subject}`,
          givenName: 'Somchai',
          familyName: 'Tester',
          nationality: 'TH',
        },
      };
      const header = { alg: 'ES256', typ: 'JWT', kid };
      const jwt = await new SignJWT(vc as any)
        .setProtectedHeader(header)
        .setIssuer(kid)
        .setSubject(subject)
        .setAudience('https://wallet.test')
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setJti(`vc-${randomBytes(6).toString('hex')}`)
        .sign(privateKey);
      return { credential: jwt, format: 'jwt_vc_json' };
    },
    async signAccessToken({ subject, cnfJwk, audience, ttlSeconds }) {
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({ cnf: { jwk: cnfJwk } })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
        .setIssuer(kid)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(privateKey);
    },
  };
}

async function buildMockVerifier(): Promise<MockVerifier> {
  return {
    baseUrl: 'http://127.0.0.1:0/mock/verifier',
    async evaluate({ vp_token, dcql_query, nonce, client_id }) {
      // Decode KB-JWT header to discover the holder key, then verify
      const [h, p, s] = vp_token.split('.');
      if (!h || !p || !s) return { ok: false, reason: 'vp_token must be a 3-segment JWT' };
      let header: any, payload: any;
      try {
        header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      } catch (e) {
        return { ok: false, reason: 'vp_token segments not base64url-JSON' };
      }
      if (header.typ !== 'kb+jwt') return { ok: false, reason: 'vp_token must be a KB-JWT (typ=kb+jwt)' };
      if (payload.aud !== client_id) return { ok: false, reason: `aud mismatch (got ${payload.aud}, want ${client_id})` };
      if (nonce && payload.nonce !== nonce) return { ok: false, reason: 'nonce mismatch' };
      // In a real verifier, we'd fully verify the signature with the cnf.jwk
      // claimed inside the SD-JWT VC. For the mock, we accept if all
      // shape checks pass and record claims as evidence.
      return { ok: true, claims: payload };
    },
  };
}

export async function getMockIssuer(): Promise<MockIssuer> {
  if (!mockIssuer) mockIssuer = await buildMockIssuer();
  return mockIssuer;
}
export async function getMockVerifier(): Promise<MockVerifier> {
  if (!mockVerifier) mockVerifier = await buildMockVerifier();
  return mockVerifier;
}

/** Set the runtime base URL once the mock is mounted on a real port. */
export function rebindMockIssuer(baseUrl: string) { if (mockIssuer) mockIssuer.baseUrl = baseUrl; }
export function rebindMockVerifier(baseUrl: string) { if (mockVerifier) mockVerifier.baseUrl = baseUrl; }
