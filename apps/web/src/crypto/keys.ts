/**
 * Crypto helpers for the wallet simulator.
 *
 * Supports:
 * - ES256 (P-256, SHA-256) — the default OID4VCI proof type
 * - EdDSA (Ed25519)        — v2.0 mandate per OID4VCI §7.2.1
 *
 * Built on Node's `crypto.subtle` via the `jose` library for JOSE wrapping.
 */

import { generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, SignJWT, type JWK, type KeyLike, type CryptoKey } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

export type Alg = 'ES256' | 'EdDSA';

export interface WalletKey {
  alg: Alg;
  privateJwk: JWK;
  publicJwk: JWK;
  thumbprint: string;
  kid: string;
}

export interface KeyStore {
  es256: WalletKey;
  eddsa: WalletKey;
}

const enc = new TextEncoder();

/** RFC 7638 JWK thumbprint — used as stable kid suffix and audience hint. */
async function thumb(jwk: JWK): Promise<string> {
  return calculateJwkThumbprint(jwk, 'sha256');
}

export async function generateWalletKey(alg: Alg, kidHint?: string): Promise<WalletKey> {
  const crv = alg === 'ES256' ? 'P-256' : 'Ed25519';
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  // jose's exportJWK does not always set `alg` — add it for downstream consumers
  privateJwk.alg = alg;
  publicJwk.alg = alg;
  if (alg === 'ES256') {
    privateJwk.crv = 'P-256';
    publicJwk.crv = 'P-256';
  } else {
    privateJwk.crv = 'Ed25519';
    publicJwk.crv = 'Ed25519';
  }
  const tp = await thumb(publicJwk);
  const kid = kidHint ?? `${alg.toLowerCase()}-${tp.slice(0, 16)}`;
  return { alg, privateJwk, publicJwk, thumbprint: tp, kid };
}

export async function generateKeyStore(): Promise<KeyStore> {
  const [es256, eddsa] = await Promise.all([
    generateWalletKey('ES256'),
    generateWalletKey('EdDSA'),
  ]);
  return { es256, eddsa };
}

/** Build a `cnf.jwk` claim suitable for binding a DPoP/access token to this key. */
export function cnfJwk(key: WalletKey): { jwk: JWK } {
  return { jwk: key.publicJwk };
}

/** Hash a string with SHA-256 → base64url. */
export function sha256B64u(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

/** PKCE code_verifier (43–128 chars, RFC 7636 §4.1). */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** PKCE code_challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export function codeChallengeS256(verifier: string): string {
  return sha256B64u(verifier);
}

/** Random URL-safe nonce. */
export function randomNonce(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Build a KeyBinding JWT (KB-JWT) per OID4VCI §7.2 — used as Credential Request `proof`. */
export interface KbJwtInput {
  key: WalletKey;
  audience: string;        // issuer's Credential Endpoint URL
  nonce?: string;          // server-supplied c_nonce, if any
  issuedAt?: number;
}

export async function buildKbJwt(input: KbJwtInput): Promise<string> {
  const iat = Math.floor((input.issuedAt ?? Date.now()) / 1000);
  const header: Record<string, unknown> = { alg: input.key.alg, typ: 'openid4vci-proof+jwt', kid: input.key.kid };
  const payload: Record<string, unknown> = {
    iss: input.key.kid,           // per §7.2.1: client_id of the credential endpoint
    aud: input.audience,
    iat,
  };
  if (input.nonce) payload.nonce = input.nonce;

  const key = await importJWK(input.key.privateJwk, input.key.alg);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: input.key.alg as 'ES256' | 'EdDSA', typ: 'openid4vci-proof+jwt', kid: input.key.kid })
    .sign(key as KeyLike | Uint8Array);
}

/** Build a signed DPoP proof JWT per RFC 9449. */
export interface DpopInput {
  key: WalletKey;
  htu: string;               // the resource URI
  htm: string;               // HTTP method
  nonce?: string;
  accessToken?: string;
  jti?: string;
}

export async function buildDpopProof(input: DpopInput): Promise<string> {
  const header: Record<string, unknown> = {
    alg: input.key.alg,
    typ: 'dpop+jwt',
    jwk: input.key.publicJwk,
  };
  const payload: Record<string, unknown> = {
    htu: input.htu,
    htm: input.htm,
    iat: Math.floor(Date.now() / 1000),
    jti: input.jti ?? randomNonce(8),
  };
  if (input.nonce) payload.nonce = input.nonce;
  if (input.accessToken) payload.ath = sha256B64u(input.accessToken);

  const key = await importJWK(input.key.privateJwk, input.key.alg);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: input.key.alg as 'ES256' | 'EdDSA', typ: 'dpop+jwt', jwk: input.key.publicJwk })
    .sign(key as KeyLike | Uint8Array);
}
