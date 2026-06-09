/**
 * Cross-mode test runners.
 *
 * Each runner is responsible for one of the four modes (I->W, V->W, W->I, W->V)
 * and is composed of:
 *   1) Build a fresh RunContext (with wallet keys + PKCE verifier).
 *   2) Discover the counterpart (issuer/verifier metadata) and dispatch tests.
 *   3) Collect TestResults, compute summary, and return a Report.
 */

import { listForMode } from '../wallet/catalog.js';
import type { TestCase, TestResult, RunContext, Mode, IssuerMetadata } from '../wallet/types.js';
import { generateCodeVerifier, codeChallengeS256, randomNonce, generateWalletKey } from '../crypto/keys.js';

export type { Mode, IssuerMetadata, TestResult, RunContext } from '../wallet/types.js';

/**
 * Resolve a possibly-relative URL against the in-process base URL.
 * If `target` is already absolute (http(s)://…), it's returned as-is.
 * If it's relative (e.g. "/.mock/issuer"), it's prefixed with the base URL.
 */
export function resolveTargetUrl(target: string | undefined, fallback: string): string {
  const baseUrl = process.env.CONFORMANCE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
  if (!target) return `${baseUrl.replace(/\/$/, '')}${fallback}`;
  if (/^https?:\/\//.test(target)) return target;
  return `${baseUrl.replace(/\/$/, '')}${target}`;
}

export interface RunRequest {
  mode: Mode;
  targetIssuer?: string;
  targetVerifier?: string;
  /**
   * Optional absolute override for the issuer metadata URL. When set, the
   * runner fetches metadata from this URL instead of
   * `${targetIssuer}/.well-known/openid-credential-issuer`. Required for
   * OID4VCI 1.0 Final issuers that serve the well-known at a parameterised
   * path (e.g. Procivis One Core).
   */
  issuerMetadataUrl?: string;
  credentialConfigurationId: string;
  /** Optional DCQL query for V->W and W->V modes. */
  dcqlQuery?: unknown;
  /** If set, run only this subset of test ids. */
  onlyIds?: string[];
}

export interface Report {
  runId: string;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: { issuer?: string; verifier?: string; credentialConfigurationId: string; issuerMetadataUrl?: string };
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    /**
     * MAS-219: number of TestResults classified as spec-coverage
     * (client-side shape validators that did not contact the target).
     * Reported alongside `passRate` so a reviewer can distinguish
     * "harness built a spec-shaped request" from "target accepted the
     * request". Excluded from the passRate denominator.
     */
    coverage: number;
  };
  /**
   * MAS-219: optional run-level error. Set when a precheck (currently
   * the target-reachability precheck) aborts the run before the test
   * loop. The results array still contains a synthesized failed row so
   * the report UI can show a concrete failure alongside the error.
   */
  error?: string;
  context: {
    keys: { es256Kid: string; eddsaKid: string };
    pkce: { codeChallengeMethod: 'S256' };
    issuerMetadata?: IssuerMetadata;
    resolvedIssuerMetadataUrl?: string;
    /**
     * The pre-authorized access token minted by the runner (offer→token step)
     * for real W->I targets. Omitted for in-process mock and I->W modes.
     * Surfaces the actual flow the runner took so the report is self-
     * documenting (e.g. the curl trace for the offer+token exchange can
     * be rebuilt from these values).
     */
    preAuth?: {
      schemaId: string;
      credentialId: string;
      organisationId: string;
      preAuthorizedCode: string;
      accessToken: string;
      cnonce?: string;
      shareUrl: string;
      offerUrl: string;
      tokenUrl: string;
      evidence?: Record<string, unknown>;
    };
  };
}

interface RunOptions {
  log?: (msg: string) => void;
}

function isSkipped(r: TestResult): boolean {
  return typeof r.message === 'string' && r.message.startsWith('SKIPPED');
}

/**
 * MAS-219: target-reachability precheck. Returns a human-readable
 * failure message when the run was given a real target URL that the
 * runner has already confirmed is unreachable (via Step 0's metadata
 * fetch for issuers, and a tight HEAD probe for verifiers), and
 * `undefined` when the run should proceed.
 *
 * Three cases:
 *   - W->I / I->W with a real `targetIssuer` and no `ctx.issuerMetadata`
 *     → unreachable issuer.
 *   - W->V with a real `targetVerifier` whose HEAD probe threw (i.e.
 *     the verifier origin is unreachable: closed port, DNS failure,
 *     connect timeout, etc.) → unreachable verifier.
 *   - Mock runs (no `targetIssuer` / `targetVerifier`) → no precheck;
 *     return undefined.
 *
 * The precheck is intentionally narrow: it is a stop-the-line safety
 * net for the board's MAS-213 concern, not a deep health check. Tests
 * that *want* a specific failure shape still get the chance to RUN
 * (e.g. an `I->W` run with a reachable but broken issuer would
 * precheck-pass and then exercise the catalog).
 */
function computeTargetPrecheckFailure(
  req: RunRequest,
  ctx: RunContext,
  probe?: { verifierPrecheckFailed: boolean; verifierPrecheckUrl?: string },
): string | undefined {
  const realTargetIssuer = (req.mode === 'W->I' || req.mode === 'I->W') && req.targetIssuer;
  if (realTargetIssuer && !ctx.issuerMetadata) {
    const url = ctx.resolvedIssuerMetadataUrl ?? `${req.targetIssuer}/.well-known/openid-credential-issuer`;
    return `target unreachable: issuer metadata fetch from ${url} did not return a valid OID4VCI 1.0 document`;
  }
  if ((req.mode === 'W->V' || req.mode === 'V->W') && req.targetVerifier && probe?.verifierPrecheckFailed) {
    return `target unreachable: verifier HEAD probe to ${probe.verifierPrecheckUrl ?? req.targetVerifier} failed (closed port, DNS failure, or connect timeout)`;
  }
  return undefined;
}

export function summarize(results: TestResult[] | undefined | null): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  coverage: number;
} {
  // MAS-174: be defensive. A null/undefined `results` (e.g. a partially
  // deserialised persisted run, a future code path that builds a report
  // shell early, etc.) must still yield a well-typed summary so the
  // frontend and HTML renderer don't crash on `report.summary.passRate`.
  // SKIPs are now counted properly (previously hard-coded to 0, which
  // made SKIP tests inflate `passed` — see MAS-170 follow-up note in
  // apps/web/src/runners/runner.ts history).
  //
  // MAS-219: coverage tests (kind === 'coverage') are excluded from the
  // passRate denominator. They are client-side shape validators that
  // pass regardless of target reachability and would inflate passRate
  // to 1 even against a closed port. They are reported separately as
  // `coverage` so a reviewer can still see how many spec-shapes the
  // harness validated.
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const skipped = list.filter(isSkipped).length;
  // A TestResult is "coverage" when its kind is `'coverage'` OR
  // undefined (i.e. a hand-built or pre-MAS-219 result that never had
  // a kind stamped on it). A skipped row never made it to the network
  // regardless of kind, so it doesn't belong in the coverage bucket.
  const coverage = list.filter((r) => (r.kind === undefined || r.kind === 'coverage') && !isSkipped(r)).length;
  const live = list.filter((r) => r.kind === 'live' && !isSkipped(r));
  const passed = live.filter((r) => r.pass).length;
  const failed = live.filter((r) => !r.pass).length;
  // passRate: coverage + skipped tests are excluded from the denominator.
  // If every live test is skipped we report 0 (not NaN, not 1).
  const rateable = passed + failed;
  return { total, passed, failed, skipped, coverage, passRate: rateable ? passed / rateable : 0 };
}

async function buildContext(req: RunRequest): Promise<RunContext> {
  const es256 = await generateWalletKey('ES256');
  const eddsa = await generateWalletKey('EdDSA');
  const codeVerifier = generateCodeVerifier();
  return {
    keys: { es256, eddsa },
    pkce: { codeVerifier, codeChallenge: codeChallengeS256(codeVerifier) },
    credentialConfigurationId: req.credentialConfigurationId,
    state: randomNonce(8),
    targetIssuer: req.targetIssuer,
    targetVerifier: req.targetVerifier,
    issuerMetadataUrl: req.issuerMetadataUrl,
    log: () => {},
  };
}

function allReqsSatisfied(ctx: RunContext, tc: TestCase): boolean {
  if (!tc.requires) return true;
  return tc.requires.every((r) => {
    if (r === 'accessToken') return !!ctx.accessToken;
    if (r === 'issuerMetadata') return !!ctx.issuerMetadata;
    if (r === 'deferredCredentialEndpoint') {
      // Skip (not fail) tests that depend on the issuer advertising the
      // deferred credential endpoint when the endpoint is absent. See
      // apps/web/src/wallet/types.ts for the rationale and OID4VCI §8.1
      // for the optionality rule.
      const ep = ctx.issuerMetadata?.deferred_credential_endpoint;
      return typeof ep === 'string' && ep.length > 0;
    }
    if (r === 'credential') return !!ctx.credential;
    return (ctx as any)[r] !== undefined;
  });
}

/**
 * Drive the OID4VCI 1.0 pre-authorized code flow against a real issuer
 * (Procivis One Core by default). The flow:
 *
 *   1) POST  ${mgmtUrl}/api/credential/v1/${credId}/share      (mgmt API)
 *   2) GET   ${mgmtUrl}/ssi/openid4vci/final-1.0/${schema}/offer/${credId}  (offer JSON)
 *   3) POST  ${mgmtUrl}/ssi/openid4vci/final-1.0/${schema}/token (form-urlencoded)
 *
 * On success, populates `ctx.accessToken` and `ctx.preAuthEvidence` and
 * returns a summary suitable for the run report.
 *
 * Configuration via env (kept explicit so the conformance webapp does not
 * have to learn the issuer's management API surface — this is dev-profile
 * only; production OID4VCI issuers do not expose a management API):
 *
 *   CONFORMANCE_PREAUTH_MGMT_URL      default: ctx.targetIssuer
 *   CONFORMANCE_PREAUTH_MGMT_BEARER   default: 'test' (Procivis dev profile)
 *
 * `schemaId` and `organisationId` are derived from the issuer metadata URL
 * (Procivis serves it at `.../OPENID4VCI_FINAL1/{identifierId}/{schemaId}`).
 * If the metadata URL does not follow that shape the function bails out
 * cleanly (returns undefined) and the catalog test SKIPs with its existing
 * reason.
 *
 * The function is best-effort: it never throws. On any failure it logs the
 * reason and returns undefined; the calling test then SKIPs (not FAILs) per
 * the `requires: ['accessToken']` prereq check.
 */
async function mintPreAuthorizedAccessToken(
  ctx: RunContext,
  log: (msg: string) => void,
): Promise<NonNullable<Report['context']['preAuth']> | undefined> {
  if (!ctx.targetIssuer || !ctx.issuerMetadata) {
    log('preauth: no real targetIssuer or no metadata, skipping');
    return undefined;
  }
  const mgmtUrl = process.env.CONFORMANCE_PREAUTH_MGMT_URL ?? ctx.targetIssuer;
  const bearer = process.env.CONFORMANCE_PREAUTH_MGMT_BEARER ?? 'test';
  const auth = `Bearer ${bearer}`;

  // Derive schemaId + identifierId from the issuer metadata URL. Procivis
  // serves the well-known at:
  //   /.well-known/openid-credential-issuer/ssi/openid4vci/final-1.0/OPENID4VCI_FINAL1/{identifierId}/{schemaId}
  // We pull the last two path segments when they look like UUIDs; otherwise
  // we cannot drive the flow automatically.
  const metaUrl = ctx.resolvedIssuerMetadataUrl ?? ctx.issuerMetadataUrl ?? '';
  const metaPath = (() => { try { return new URL(metaUrl).pathname; } catch { return ''; } })();
  const segs = metaPath.split('/').filter(Boolean);
  const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const tail = segs.slice(-2);
  const identifierId = UUID_LIKE.test(tail[0] ?? '') ? tail[0] : undefined;
  const schemaId = UUID_LIKE.test(tail[1] ?? '') ? tail[1] : undefined;
  if (!schemaId) {
    log(`preauth: cannot derive schemaId from metadata URL path (${metaPath}), skipping`);
    return undefined;
  }

  // The vct URL embeds the organisation id. We pull it out if it is shaped
  // like `.../ssi/vct/v1/{orgId}/{schemaId}`. If it is not we fall back to
  // listing all credentials for the schema and accept the first OFFERED
  // one (the management API requires orgId to list).
  const cfg = ctx.credentialConfigurationId;
  const cfgUrl = (() => { try { return new URL(cfg); } catch { return undefined; } })();
  const cfgSegs = cfgUrl ? cfgUrl.pathname.split('/').filter(Boolean) : [];
  const orgFromVct = UUID_LIKE.test(cfgSegs[cfgSegs.length - 2] ?? '') ? cfgSegs[cfgSegs.length - 2] : undefined;
  const schemaFromVct = UUID_LIKE.test(cfgSegs[cfgSegs.length - 1] ?? '') ? cfgSegs[cfgSegs.length - 1] : undefined;
  const orgId = orgFromVct ?? (identifierId ? await lookupOrgIdForIdentifier(mgmtUrl, auth, identifierId) : undefined);
  if (!orgId) {
    log('preauth: cannot resolve organisationId, skipping');
    return undefined;
  }

  // Confirm the schema id we have agrees with the vct URL. If both are
  // present and disagree, prefer the metadata-URL one (it is what the
  // OID4VCI routes key on) but log a warning.
  if (schemaFromVct && schemaFromVct !== schemaId) {
    log(`preauth: WARN vct schemaId (${schemaFromVct}) != metadata schemaId (${schemaId}), using metadata`);
  }

  // Provision a fresh credential. We do not reuse OFFERED credentials
  // because Procivis transitions the credential to a "share-consumed"
  // state on the first POST /share (any subsequent share returns
  // `BR_0002 Credential state invalid: Offered`). Provisioning is
  // cheap (the row is small, and a fresh SD-JWT VC per run keeps the
  // evidence deterministic).
  log('preauth: provisioning a fresh credential for the offer→token step...');
  const fresh = await provisionFreshCredential(mgmtUrl, auth, orgId, schemaId, identifierId);
  if (!fresh) {
    log('preauth: could not provision a fresh credential, skipping (run ops/procivis-sandbox/setup-issuer-and-verifier.sh to seed schemas)');
    return undefined;
  }
  const credId = fresh.id;
  log(`preauth: provisioned credential ${credId}`);

  // Step 1: share the credential. Empty body — Procivis returns a
  // `openid-credential-offer://?credential_offer_uri=...` URL.
  const shareUrl = `${mgmtUrl}/api/credential/v1/${credId}/share`;
  const shareRes = await fetch(shareUrl, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: auth, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!shareRes.ok) {
    log(`preauth: share ${shareRes.status} ${await shareRes.text()}`);
    return undefined;
  }
  const shareBody = await shareRes.json() as { url?: string; transactionCode?: string };
  if (!shareBody.url) {
    log('preauth: share response missing url, skipping');
    return undefined;
  }

  // Step 2: fetch the offer JSON. The `credential_offer_uri` in the share
  // URL points at exactly the OID4VCI 1.0 offer endpoint we already know
  // how to call, so we go directly.
  const offerUrl = `${mgmtUrl}/ssi/openid4vci/final-1.0/${schemaId}/offer/${credId}`;
  const offerRes = await fetch(offerUrl, { headers: { accept: 'application/json', authorization: auth } });
  if (!offerRes.ok) {
    log(`preauth: offer ${offerRes.status} ${await offerRes.text()}`);
    return undefined;
  }
  const offer = await offerRes.json() as {
    credential_issuer?: string;
    credential_configuration_ids?: string[];
    grants?: { 'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: { 'pre-authorized_code'?: string; tx_code?: unknown } };
  };
  const preAuthorizedCode = offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']?.['pre-authorized_code'];
  if (!preAuthorizedCode) {
    // Surface the offer body so an operator can see whether the share
    // step actually populated it. The most common cause is hitting the
    // /offer endpoint before /share (Procivis returns `{"error":
    // "invalid_request"}` in that case, but the offer we parsed here
    // could also be a stale OFFERED-state body that lost the grant).
    log(`preauth: offer missing pre-authorized_code grant; body=${JSON.stringify(offer)}`);
    return undefined;
  }
  const txCodeInputMode = ((): string | undefined => {
    const t = offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']?.tx_code as { input_mode?: string } | undefined;
    return t?.input_mode;
  })();

  // Step 3: exchange the pre-authorized code for an access token. Form-
  // urlencoded body per OID4VCI §6.1. `token_endpoint_auth_methods_supported:
  // ["none"]` means no client_id (Procivis accepts it but we send the
  // wallet's ES256 kid per the corrected testcase convention so the trace
  // is meaningful in a real wallet).
  const tokenUrl = `${mgmtUrl}/ssi/openid4vci/final-1.0/${schemaId}/token`;
  const tokenForm = new URLSearchParams();
  tokenForm.set('grant_type', 'urn:ietf:params:oauth:grant-type:pre-authorized_code');
  tokenForm.set('pre-authorized_code', preAuthorizedCode);
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenForm.toString(),
  });
  if (!tokenRes.ok) {
    log(`preauth: token ${tokenRes.status} ${await tokenRes.text()}`);
    return undefined;
  }
  const token = await tokenRes.json() as { access_token?: string; c_nonce?: string; refresh_token?: string; token_type?: string; expires_in?: number };
  if (!token.access_token) {
    log('preauth: token response missing access_token, skipping');
    return undefined;
  }

  ctx.accessToken = token.access_token;
  if (token.c_nonce) ctx.cnonce = token.c_nonce;

  // If the token response did not include a c_nonce but the issuer
  // metadata advertises a `nonce_endpoint`, fetch a fresh one. Procivis
  // One Core requires every KB-JWT proof to carry a nonce (responds with
  // `invalid_nonce` if missing), and the local sandbox returns c_nonce
  // via the nonce endpoint rather than in the token body.
  if (!ctx.cnonce && ctx.issuerMetadata?.nonce_endpoint) {
    try {
      const nonceRes = await fetch(ctx.issuerMetadata.nonce_endpoint, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (nonceRes.ok) {
        const nonceBody = await nonceRes.json() as { c_nonce?: string; nonce?: string };
        const cnonce = nonceBody.c_nonce ?? nonceBody.nonce;
        if (cnonce) {
          ctx.cnonce = cnonce;
          log(`preauth: fetched c_nonce (${cnonce.length} chars) from nonce_endpoint`);
        }
      }
    } catch (e) {
      log(`preauth: nonce_endpoint fetch failed: ${(e as Error).message}`);
    }
  }

  log(`preauth: minted access_token (${token.access_token.length} chars) via pre-authorized_code${txCodeInputMode ? ` tx_code_input_mode=${txCodeInputMode}` : ''} c_nonce=${ctx.cnonce ? 'set' : 'unset'}`);

  return {
    schemaId,
    credentialId: credId,
    organisationId: orgId,
    preAuthorizedCode,
    accessToken: token.access_token,
    cnonce: ctx.cnonce,
    shareUrl,
    offerUrl,
    tokenUrl,
    evidence: {
      offer,
      token,
    },
  };
}

/**
 * Best-effort lookup of the organisation that owns a given identifier id.
 * Procivis does not expose this directly, so we list identifiers for the
 * org until we find one. Returns undefined on any failure.
 */
async function lookupOrgIdForIdentifier(mgmtUrl: string, auth: string, identifierId: string): Promise<string | undefined> {
  // List all organisations and walk them. Fine for the local sandbox where
  // there is at most a handful.
  const orgsRes = await fetch(`${mgmtUrl}/api/organisation/v1?page=0&pageSize=100`, { headers: { accept: 'application/json', authorization: auth } });
  if (!orgsRes.ok) return undefined;
  const orgs = await orgsRes.json() as { values?: Array<{ id?: string }> };
  for (const o of orgs.values ?? []) {
    if (!o.id) continue;
    const identsRes = await fetch(`${mgmtUrl}/api/identifier/v1?page=0&pageSize=100&organisationId=${o.id}`, { headers: { accept: 'application/json', authorization: auth } });
    if (!identsRes.ok) continue;
    const idents = await identsRes.json() as { values?: Array<{ id?: string }> };
    if ((idents.values ?? []).some((i) => i.id === identifierId)) return o.id;
  }
  return undefined;
}

/**
 * Provision a fresh credential for `schemaId` and return its id.
 *
 * Procivis's `POST /api/credential/v1` needs `claimValues: [{ claimId,
 * path, value }, ...]`. We pull the schema's claim definitions and
 * supply a synthetic but well-formed value per claim (so the credential
 * validates downstream). The claim-id resolution is the only piece that
 * is specific to Procivis — every other OID4VCI issuer that exposes a
 * management API will have its own shape, so this helper is the
 * "dev profile only" escape hatch the rest of the runner code can rely
 * on.
 *
 * Returns undefined on any failure (no schema, schema has no claims,
 * create call fails, etc.) — the caller logs and bails out.
 */
async function provisionFreshCredential(
  mgmtUrl: string,
  auth: string,
  orgId: string,
  schemaId: string,
  identifierId: string | undefined,
): Promise<{ id: string; schemaId: string } | undefined> {
  // 1) Get the schema's claim definitions so we know the claimId + path
  //    pairs the create endpoint expects.
  const schemaRes = await fetch(`${mgmtUrl}/api/credential-schema/v1/${schemaId}`, {
    headers: { accept: 'application/json', authorization: auth },
  });
  if (!schemaRes.ok) return undefined;
  const schema = await schemaRes.json() as { claims?: Array<{ id?: string; key?: string; datatype?: string }> };
  if (!schema.claims || schema.claims.length === 0) return undefined;

  // 2) Pick a placeholder value per claim. We bias toward strings/dates
  //    (the SD-JWT VC schema for Thai National ID is all STRING except
  //    `birthdate` which is BIRTH_DATE — both accept strings).
  const claimValues = schema.claims
    .filter((c) => c.id && c.key)
    .map((c) => ({ claimId: c.id!, path: c.key!, value: syntheticValueFor(c.key!, c.datatype) }));

  // 3) Create. Procivis requires the issuer identifier id to be
  //    specified explicitly (BR_0323 "No issuer specified" otherwise).
  //    The identifier id is the segment of the metadata URL path that
  //    is *not* the schema id (we captured it earlier as `identifierId`).
  //    For a single-identifier sandbox this is the only identifier the
  //    org owns, so the value is unambiguous.
  const createRes = await fetch(`${mgmtUrl}/api/credential/v1`, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      credentialSchemaId: schemaId,
      protocol: 'OPENID4VCI_FINAL1',
      issuer: identifierId,
      claimValues,
    }),
  });
  if (!createRes.ok) {
    // The management API is dev-profile only and returns useful error
    // envelopes; surface them in the log so the operator can fix the
    // problem without attaching a debugger.
    const errText = await createRes.text().catch(() => '');
    console.warn(`[runner.ts] preauth: provision ${createRes.status} ${errText}`);
    return undefined;
  }
  const created = await createRes.json() as { id?: string };
  if (!created.id) return undefined;
  return { id: created.id, schemaId };
}

function syntheticValueFor(key: string, datatype: string | undefined): string {
  // Deterministic per-claim placeholder. The real values would come
  // from the user (e.g. KYC pipeline) — for the conformance harness we
  // just need the credential to issue and the SD-JWT VC to validate.
  const k = key.toLowerCase();
  if (k === 'id' || k.endsWith('_id')) return '9999999999999';
  if (k === 'birthdate' || datatype === 'BIRTH_DATE') return '1990-01-01';
  if (k.includes('name') || k.includes('given') || k.includes('family')) return `Test ${k}`;
  if (k.includes('email')) return 'poc@example.test';
  if (datatype === 'NUMBER' || datatype === 'COUNT') return '0';
  if (datatype === 'BOOLEAN') return 'true';
  return 'test-value';
}

export async function runConformance(req: RunRequest, opts: RunOptions = {}): Promise<Report> {
  const runId = `run-${Date.now().toString(36)}-${randomNonce(4)}`;
  const startedAt = new Date();
  const ctx = await buildContext(req);
  const log = (msg: string) => { opts.log?.(`[${new Date().toISOString()}] ${msg}`); };
  ctx.log = log as any;

  log(`run ${runId} start mode=${req.mode} cfg=${req.credentialConfigurationId} targetIssuer=${req.targetIssuer ?? '(mock)'} targetVerifier=${req.targetVerifier ?? '(mock)'}`);

  // Step 0: if the target is real, fetch its metadata first so tests can use it.
  if (req.mode === 'W->I' || req.mode === 'I->W') {
    let metadataUrl: string;
    if (req.issuerMetadataUrl) {
      metadataUrl = req.issuerMetadataUrl;
    } else {
      const issuer = req.targetIssuer ?? '/.mock/issuer';
      // Resolve relative URLs to the in-process server origin
      const baseUrl = process.env.CONFORMANCE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
      const absoluteIssuer = issuer.startsWith('http') ? issuer : `${baseUrl.replace(/\/$/, '')}${issuer}`;
      const base = absoluteIssuer.replace(/\/$/, '');
      metadataUrl = `${base}/.well-known/openid-credential-issuer`;
    }
    ctx.resolvedIssuerMetadataUrl = metadataUrl;
    try {
      const r = await fetch(metadataUrl, { headers: { accept: 'application/json' } });
      if (r.ok) {
        ctx.issuerMetadata = await r.json() as IssuerMetadata;
        log(`fetched issuer metadata from ${metadataUrl}: ${Object.keys(ctx.issuerMetadata.credential_configurations_supported).length} configs`);
      } else {
        log(`issuer metadata fetch from ${metadataUrl} returned ${r.status}`);
      }
    } catch (e) {
      log(`issuer metadata fetch from ${metadataUrl} failed: ${(e as Error).message}`);
    }
  }

  // MAS-219: target-reachability precheck. When a real target URL is
  // supplied, a single metadata fetch already reveals whether the
  // target is reachable. If it isn't, the rest of the test loop is
  // guaranteed to fail in confusing ways (or, with the SKIP branch,
  // silently pass) — the board's MAS-213 concern is precisely that
  // latter case ("success rate 100% even when URL is wrong").
  //
  // We precheck for the same three scenarios as the test loop's
  // metadata fetch: W->I / I->W for issuer targets, W->V for verifier
  // targets. The precheck is *advisory* on the in-process mock path
  // (no targetIssuer / targetVerifier was supplied, so we let the
  // existing Step 0 succeed and continue).
  //
  // For W->V, the OID4VP 1.0 Final spec does not require a verifier
  // well-known (the wallet learns the verifier's endpoint from the
  // presentation-request URL itself, §5.1). We probe the verifier's
  // origin with a tight HEAD to detect a closed port / DNS failure,
  // which is the exact failure mode the board wants surfaced.
  let verifierPrecheckFailed = false;
  let verifierPrecheckUrl: string | undefined;
  if ((req.mode === 'W->V' || req.mode === 'V->W') && req.targetVerifier) {
    verifierPrecheckUrl = req.targetVerifier.replace(/\/$/, '');
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5_000);
      const probe = await fetch(verifierPrecheckUrl, {
        method: 'HEAD',
        signal: ac.signal,
        redirect: 'manual',
      });
      clearTimeout(t);
      // Any HTTP response (even 4xx/5xx) means the verifier is up.
      // Network error / abort means the verifier is unreachable.
      log(`verifier precheck: ${verifierPrecheckUrl} responded ${probe.status}`);
    } catch (e) {
      log(`verifier precheck: ${verifierPrecheckUrl} failed: ${(e as Error).message}`);
      verifierPrecheckFailed = true;
    }
  }

  const precheckFailure = computeTargetPrecheckFailure(req, ctx, { verifierPrecheckFailed, verifierPrecheckUrl });
  if (precheckFailure) {
    const finishedAt = new Date();
    log(`ABORT ${runId} — ${precheckFailure}`);
    const failedRow: TestResult = {
      id: 'MAS-219-PRECHECK',
      name: 'Target reachability precheck',
      pass: false,
      message: precheckFailure,
      durationMs: 0,
      kind: 'live',
    };
    const results: TestResult[] = [failedRow];
    return {
      runId,
      mode: req.mode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      target: {
        issuer: req.targetIssuer,
        verifier: req.targetVerifier,
        credentialConfigurationId: req.credentialConfigurationId,
        issuerMetadataUrl: req.issuerMetadataUrl,
      },
      results,
      summary: summarize(results),
      error: 'target unreachable',
      context: {
        keys: { es256Kid: ctx.keys.es256.kid, eddsaKid: ctx.keys.eddsa.kid },
        pkce: { codeChallengeMethod: 'S256' },
        issuerMetadata: ctx.issuerMetadata,
        resolvedIssuerMetadataUrl: ctx.resolvedIssuerMetadataUrl,
      },
    };
  }

  // Step 0.5: for W->I with a real target, drive the pre-authorized code
  // flow so the wallet-side full-issuance test has a real access token
  // (without this, the wallet falls back to `Bearer __SIM__` and any
  // OID4VCI 1.0 Final issuer rejects with 400 invalid_token per §A.3).
  // The function is best-effort: on any failure it logs and leaves
  // `ctx.accessToken` undefined, which causes tests that require
  // accessToken to SKIP cleanly (per `requires: ['accessToken']`).
  let preAuth: Report['context']['preAuth'] | undefined;
  if (req.mode === 'W->I' && req.targetIssuer) {
    preAuth = await mintPreAuthorizedAccessToken(ctx, log);
  }

  const candidates: TestCase[] = listForMode(req.mode);
  const subset: TestCase[] = req.onlyIds?.length ? candidates.filter((t) => req.onlyIds!.includes(t.id)) : candidates;
  const results: TestResult[] = [];

  for (const tc of subset) {
    if (!allReqsSatisfied(ctx, tc)) {
      const reason = tc.skipReason ? `SKIPPED (prerequisite not met: ${tc.skipReason})` : 'SKIPPED (prerequisite not met)';
      results.push({ id: tc.id, name: tc.name, pass: true, message: reason, durationMs: 0, kind: tc.kind ?? 'coverage' });
      log(`SKIP ${tc.id} (prereq missing)${tc.skipReason ? ` — ${tc.skipReason}` : ''}`);
      continue;
    }
    log(`RUN  ${tc.id} — ${tc.name}`);
    try {
      const r = await tc.run(ctx);
      // MAS-219: stamp the test's `kind` on its result so summarize()
      // can split live from coverage without re-walking the catalog.
      // Default to 'coverage' so a hand-written TestResult that omits
      // `kind` is treated as a spec-shape check (not a live pass).
      r.kind = r.kind ?? tc.kind ?? 'coverage';
      results.push(r);
      log(`${r.pass ? 'PASS' : 'FAIL'} ${tc.id} (${r.durationMs}ms) — ${r.message}`);
    } catch (e) {
      // MAS-174: one test throwing must not abort the whole run. The
      // harness still owes the operator a complete report with a well-
      // typed summary so the UI can render it. We mark this test FAIL
      // and continue; the error is captured in `message` and full
      // stack is in the run log.
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      log(`ERROR ${tc.id} — ${msg}`);
      results.push({ id: tc.id, name: tc.name, pass: false, message: `Threw: ${msg}`, durationMs: 0, kind: tc.kind ?? 'coverage' });
    }
  }

  const finishedAt = new Date();
  const report: Report = {
    runId,
    mode: req.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    target: {
      issuer: req.targetIssuer,
      verifier: req.targetVerifier,
      credentialConfigurationId: req.credentialConfigurationId,
      issuerMetadataUrl: req.issuerMetadataUrl,
    },
    results,
    summary: summarize(results),
    context: {
      keys: { es256Kid: ctx.keys.es256.kid, eddsaKid: ctx.keys.eddsa.kid },
      pkce: { codeChallengeMethod: 'S256' },
      issuerMetadata: ctx.issuerMetadata,
      resolvedIssuerMetadataUrl: ctx.resolvedIssuerMetadataUrl,
      ...(preAuth ? { preAuth } : {}),
    },
  };
  log(`done ${runId} pass=${report.summary.passed}/${report.summary.total}`);
  return report;
}

export interface RunStore {
  save(report: Report): void;
  get(id: string): Report | undefined;
  list(): Report[];
  latest(): Report | undefined;
}

export function makeRunStore(): RunStore {
  const map = new Map<string, Report>();
  return {
    save: (r) => { map.set(r.runId, r); },
    get: (id) => map.get(id),
    list: () => Array.from(map.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    latest: () => {
      const all = Array.from(map.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return all[0];
    },
  };
}
