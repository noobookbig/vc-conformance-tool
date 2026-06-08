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
import { generateCodeVerifier, codeChallengeS256, randomNonce, generateWalletKey, type WalletKey } from '../crypto/keys.js';

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
  target: { issuer?: string; verifier?: string; credentialConfigurationId: string };
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
  };
  context: {
    keys: { es256Kid: string; eddsaKid: string };
    pkce: { codeChallengeMethod: 'S256' };
    issuerMetadata?: IssuerMetadata;
  };
}

interface RunOptions {
  log?: (msg: string) => void;
}

function summarize(results: TestResult[]) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const skipped = 0;
  return { total, passed, failed, skipped, passRate: total ? passed / total : 0 };
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
    log: () => {},
  };
}

function allReqsSatisfied(ctx: RunContext, tc: TestCase): boolean {
  if (!tc.requires) return true;
  return tc.requires.every((r) => {
    if (r === 'accessToken') return !!ctx.accessToken;
    if (r === 'issuerMetadata') return !!ctx.issuerMetadata;
    if (r === 'credential') return !!ctx.credential;
    return (ctx as any)[r] !== undefined;
  });
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
    const issuer = req.targetIssuer ?? '/.mock/issuer';
    // Resolve relative URLs to the in-process server origin
    const baseUrl = process.env.CONFORMANCE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
    const absoluteIssuer = issuer.startsWith('http') ? issuer : `${baseUrl.replace(/\/$/, '')}${issuer}`;
    const base = absoluteIssuer.replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/.well-known/openid-credential-issuer`);
      if (r.ok) {
        ctx.issuerMetadata = await r.json() as IssuerMetadata;
        log(`fetched issuer metadata: ${Object.keys(ctx.issuerMetadata.credential_configurations_supported).length} configs`);
      } else {
        log(`issuer metadata fetch returned ${r.status}`);
      }
    } catch (e) {
      log(`issuer metadata fetch failed: ${(e as Error).message}`);
    }
  }

  const candidates: TestCase[] = listForMode(req.mode);
  const subset: TestCase[] = req.onlyIds?.length ? candidates.filter((t) => req.onlyIds!.includes(t.id)) : candidates;
  const results: TestResult[] = [];

  for (const tc of subset) {
    if (!allReqsSatisfied(ctx, tc)) {
      results.push({ id: tc.id, name: tc.name, pass: true, message: 'SKIPPED (prerequisite not met)', durationMs: 0 });
      log(`SKIP ${tc.id} (prereq missing)`);
      continue;
    }
    log(`RUN  ${tc.id} — ${tc.name}`);
    const r = await tc.run(ctx);
    results.push(r);
    log(`${r.pass ? 'PASS' : 'FAIL'} ${tc.id} (${r.durationMs}ms) — ${r.message}`);
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
    },
    results,
    summary: summarize(results),
    context: {
      keys: { es256Kid: ctx.keys.es256.kid, eddsaKid: ctx.keys.eddsa.kid },
      pkce: { codeChallengeMethod: 'S256' },
      issuerMetadata: ctx.issuerMetadata,
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
