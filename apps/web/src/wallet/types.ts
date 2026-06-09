/**
 * Conformance testcase catalog.
 *
 * Each test case is a self-contained executable definition derived from
 * the corrected Thailand VC OID4VCI / OID4VP 1.0 conformance testcase v2.0
 * (see /home/big/Documents/vc-test).
 *
 * Format inspired by DIF Conformance / ETSI plugtest suites:
 *   id        — stable, spec-aligned identifier
 *   name      — human-readable title
 *   eut       — Entity Under Test (Issuer / Verifier / Wallet)
 *   role      — which cross-mode this test belongs to
 *   specRef   — normative section reference
 *   operation — operation bucket (e.g. "Issue VC — Authorization")
 *   behavior  — Valid (VB) / Invalid (IB)
 *   dependsOn — array of test ids that must run first
 *   run       — the actual test function
 */

import type { Alg, WalletKey } from '../crypto/keys.js';

export type Behavior = 'VB' | 'IB';
export type Role = 'wallet' | 'issuer' | 'verifier';
export type Mode = 'I->W' | 'V->W' | 'W->I' | 'W->V';

export interface RunContext {
  /** Resolved target URLs. */
  targetIssuer?: string;
  targetVerifier?: string;
  /**
   * Optional absolute override for the issuer metadata URL. When set, the
   * runner and the in-test metadata fetches hit this URL instead of the
   * default `${targetIssuer}/.well-known/openid-credential-issuer`. This
   * is the OID4VCI 1.0 Final escape hatch for issuers that serve the
   * well-known at a parameterised path (e.g. Procivis One Core:
   * `/.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/...`).
   */
  issuerMetadataUrl?: string;
  /** Selected credential configuration id. */
  credentialConfigurationId: string;
  /** Wallet keys (in-process). */
  keys: { es256: WalletKey; eddsa: WalletKey };
  /** PKCE verifier chosen at run time, reused for the auth+token step. */
  pkce: { codeVerifier: string; codeChallenge: string };
  /** Holder state. */
  state: string;
  /** OID4VCI server metadata (after /.well-known/openid-credential-issuer). */
  issuerMetadata?: IssuerMetadata;
  /** Resolved absolute URL the metadata was fetched from (override or default). */
  resolvedIssuerMetadataUrl?: string;
  /** OID4VCI access token. */
  accessToken?: string;
  /** OID4VCI c_nonce. */
  cnonce?: string;
  /** Last credential issued. */
  credential?: unknown;
  /** OID4VP request (if received). */
  presentationRequest?: PresentationRequest;
  /** VC presented back. */
  presentation?: unknown;
  /** Shared log for the run. */
  log: LogFn;
}

export type LogFn = (msg: string, ...rest: unknown[]) => void;

export interface TestCase {
  id: string;
  name: string;
  eut: Role;
  specRef: string;
  operation: string;
  behavior: Behavior;
  /**
   * When this test is run:
   * - mode-specific.
   * - The runner picks the subset that matches the current cross-mode.
   */
  modes: Mode[];
  /**
   * Optional prerequisites. The runner will skip the test (and mark
   * it as SKIPPED) if any are missing from the context.
   *
   * In addition to the run-context keys below, two derived prereqs are
   * recognised:
   *
   * - `'issuerMetadata'`: satisfied when `ctx.issuerMetadata` is defined.
   * - `'deferredCredentialEndpoint'`: satisfied when
   *   `ctx.issuerMetadata?.deferred_credential_endpoint` is a non-empty
   *   string. Lets the catalog SKIP (not FAIL) deferred-credential tests
   *   against issuers that do not advertise the deferred endpoint
   *   (e.g. Procivis One Core's base metadata, per OID4VCI 1.0 §8.1
   *   optionality).
   */
  requires?: Array<keyof RunContext | 'accessToken' | 'issuerMetadata' | 'deferredCredentialEndpoint' | 'credential'>;
  /**
   * Optional human-readable reason surfaced in the report and the runner log
   * when the test is SKIPPED because a `requires` prerequisite is not met.
   * Lets a test explain *why* the prereq is missing so the run report is
   * self-documenting (e.g. "wallet token step not yet driven for real
   * targets — tracked in MAS-170"). When absent, the runner falls back to
   * the generic "SKIPPED (prerequisite not met)" message.
   */
  skipReason?: string;
  /** Returns a result record. */
  run: (ctx: RunContext) => Promise<TestResult>;
}

export interface TestResult {
  id: string;
  name: string;
  pass: boolean;
  message: string;
  evidence?: Record<string, unknown>;
  durationMs: number;
}

// ---------- Spec-shaped types (minimal, validated by zod at the HTTP boundary) ----------

export interface IssuerMetadata {
  credential_issuer: string;
  authorization_servers?: string[];
  credential_endpoint: string;
  deferred_credential_endpoint?: string;
  notification_endpoint?: string;
  /**
   * OID4VCI 1.0 §7.2: optional endpoint the wallet can POST to in order
   * to obtain a fresh c_nonce. Some issuers (Procivis One Core) return
   * a c_nonce here rather than in the token response body.
   */
  nonce_endpoint?: string;
  credential_configurations_supported: Record<string, CredentialConfiguration>;
  display?: Array<{ name: string; locale?: string }>;
}

export interface CredentialConfiguration {
  format: string;                              // 'jwt_vc_json' | 'ldp_vc' | 'vc+sd-jwt' | ...
  scope?: string;
  cryptographic_binding_methods_supported?: string[];
  credential_signing_alg_values_supported?: string[];
  proof_types_supported?: Record<string, { proof_signing_alg_values_supported: Alg[] }>;
  display?: Array<{ name: string; locale?: string }>;
  vct?: string;                                 // SD-JWT VC
  claims?: Record<string, unknown>;
}

export interface PresentationRequest {
  response_type: string;
  response_mode?: string;
  client_id: string;
  nonce?: string;
  state?: string;
  dcql_query?: DCQLQuery;
  presentation_definition?: unknown;            // legacy
  redirect_uri?: string;
}

export interface DCQLQuery {
  credentials: DCQLCredential[];
  credential_sets?: Array<{ options: string[][]; required: boolean }>;
}

export interface DCQLCredential {
  id: string;
  format: string;
  meta?: { vct_values?: string[]; doctype_value?: string };
  claims?: Array<{ path: string[]; values?: unknown[] }>;
  cryptographic_holder_binding_required?: boolean;
  credential_holder_binding_required?: boolean;
  trusted_authorities?: Array<{ type: string; values: string[] }>;
}

// ---------- Helper builders (used by the catalog) ----------

export function makeCredentialConfigurationId(id: string): string {
  return id;
}
