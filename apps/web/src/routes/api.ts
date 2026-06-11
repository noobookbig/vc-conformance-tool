/**
 * REST API routes for the conformance test webapp.
 *
 *   GET  /api/health                 → liveness
 *   GET  /api/modes                  → list of supported cross-modes + their tests
 *   GET  /api/credentials            → known credential configurations
 *   GET  /api/config                 → current run config
 *   PUT  /api/config                 → update run config
 *   POST /api/runs                   → start a new run
 *   GET  /api/runs                   → list all runs (newest first)
 *   GET  /api/runs/:id               → fetch a run
 *   GET  /api/runs/:id/report.json   → download JSON
 *   GET  /api/runs/:id/report.html   → download HTML
 *   GET  /api/runs/:id/report.csv    → download CSV
 *   GET  /api/runs/:id/curl          → curl commands for failing tests
 *   GET  /api/runs/:id/diff?left=…   → diff two runs
 *   GET  /api/runs/:id/logo.svg      → logo used inside reports
 *   GET  /api/report/logo.svg        → same logo, no run id
 *   POST /api/wallet/keys/regenerate → issue a fresh key pair
 *   GET  /api/wallet/keys            → current key metadata (no private material)
 *   POST /api/qr/validate            → parse a QR payload (any of the 3 flows)
 *   POST /api/qr/send-vp             → parse + sign + POST a VP from a QR (MAS-312.A)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOG, listForMode } from '../wallet/catalog.js';
import { runConformance, runConformanceQrVp, summarize, type RunRequest, type RunStore, type Report } from '../runners/runner.js';
import { toHtml, toJson } from '../report/serialize.js';
import { toCsv } from '../report/csv.js';
import { diffReports } from '../report/diff.js';
import { generateKeyStore, type KeyStore, type WalletKey } from '../crypto/keys.js';
import { validateQrPayload } from '../qr/validate.js';

const ModeSchema = z.enum(['I->W', 'V->W', 'W->I', 'W->V']);

const ConfigSchema = z.object({
  mode: ModeSchema,
  targetIssuer: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  targetVerifier: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /**
   * Optional absolute override for the OID4VCI issuer metadata URL. When
   * set, the runner fetches metadata from this URL instead of the default
   * `${targetIssuer}/.well-known/openid-credential-issuer`. Use this for
   * OID4VCI 1.0 Final issuers that serve the well-known at a parameterised
   * path (e.g. Procivis One Core).
   */
  issuerMetadataUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  credentialConfigurationId: z.string().min(1).default('ThaiNationalID'),
  dcqlQuery: z.unknown().optional(),
});

const QrValidationSchema = z.object({
  flow: z.enum(['receive-vc-offer', 'receive-vp-request', 'send-vp-request']),
  payload: z.string().min(1),
});

/**
 * MAS-312.A: VP-via-QR submission. Body shape mirrors the runner entry
 * point so the UI (MAS-312.B) and the QA fixture (MAS-312.C) can call
 * either the HTTP endpoint or the runner function with the same
 * payload. Only `qrPayload` + `targetVerifier` are required; the rest
 * override the QR-internal values when the tester wants to drive a
 * specific credential configuration or DCQL query.
 */
const QrSendVpSchema = z.object({
  qrPayload: z.string().min(1),
  targetVerifier: z.string().url().or(z.literal('').transform(() => undefined)),
  credentialConfigurationId: z.string().min(1).optional(),
  dcqlQuery: z.unknown().optional(),
  state: z.string().min(1).optional(),
});

interface ServerDeps {
  store: RunStore;
  getKeys: () => Promise<KeyStore>;
  regenerateKeys: () => Promise<KeyStore>;
  getConfig: () => Config;
  setConfig: (c: Config) => void;
}

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return { mode: 'W->I', credentialConfigurationId: 'ThaiNationalID' };
}

export async function registerApiRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { store, getKeys, regenerateKeys, getConfig, setConfig } = deps;

  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/api/modes', async () => {
    const modes: Array<{ id: string; description: string; tests: number; suite: typeof CATALOG }> = [
      { id: 'I->W', description: 'Drive a target Issuer with our wallet simulator.', tests: listForMode('I->W').length, suite: listForMode('I->W') },
      { id: 'V->W', description: 'Drive a target Verifier with our wallet simulator.', tests: listForMode('V->W').length, suite: listForMode('V->W') },
      { id: 'W->I', description: 'Drive our wallet simulator with a target Issuer.', tests: listForMode('W->I').length, suite: listForMode('W->I') },
      { id: 'W->V', description: 'Drive our wallet simulator with a target Verifier.', tests: listForMode('W->V').length, suite: listForMode('W->V') },
    ];
    return { modes, totalTests: CATALOG.length };
  });

  app.get('/api/catalog', async () => ({ tests: CATALOG.map((t) => ({
    id: t.id, name: t.name, eut: t.eut, specRef: t.specRef, operation: t.operation,
    behavior: t.behavior, modes: t.modes,
  })) }));

  app.get('/api/credentials', async () => ({
    configurations: [
      { id: 'ThaiNationalID', label: 'Thai National ID (mock)', format: 'jwt_vc_json' },
      { id: 'ThaiUniversityDegree', label: 'Thai University Degree (mock)', format: 'jwt_vc_json' },
    ],
  }));

  app.get('/api/config', async () => getConfig());

  app.put('/api/config', async (req, reply) => {
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_config', details: parsed.error.issues });
    setConfig(parsed.data);
    return parsed.data;
  });

  app.get('/api/wallet/keys', async () => {
    const k = await getKeys();
    return {
      es256: { kid: k.es256.kid, thumbprint: k.es256.thumbprint, alg: k.es256.alg, publicJwk: k.es256.publicJwk },
      eddsa: { kid: k.eddsa.kid, thumbprint: k.eddsa.thumbprint, alg: k.eddsa.alg, publicJwk: k.eddsa.publicJwk },
    };
  });

  app.post('/api/wallet/keys/regenerate', async () => {
    const k = await regenerateKeys();
    return {
      es256: { kid: k.es256.kid, thumbprint: k.es256.thumbprint, alg: k.es256.alg },
      eddsa: { kid: k.eddsa.kid, thumbprint: k.eddsa.thumbprint, alg: k.eddsa.alg },
    };
  });

  app.post('/api/runs', async (req, reply) => {
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    const cfg = parsed.data;
    const rr: RunRequest = {
      mode: cfg.mode,
      targetIssuer: cfg.targetIssuer,
      targetVerifier: cfg.targetVerifier,
      issuerMetadataUrl: cfg.issuerMetadataUrl,
      credentialConfigurationId: cfg.credentialConfigurationId,
      dcqlQuery: cfg.dcqlQuery,
    };
    // Run synchronously and return. For very long runs we could switch to
    // a job queue; for a self-contained test tool this is enough.
    const report = await runConformance(rr, { log: (m) => app.log.info(m) });
    store.save(report);
    setConfig(cfg);
    return report;
  });

  app.post('/api/qr/validate', async (req, reply) => {
    const parsed = QrValidationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    const result = validateQrPayload(parsed.data.flow, parsed.data.payload);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  // MAS-312.A: parse a "send-vp-request" QR, build a VP, and POST it
  // to the verifier. Returns the verifier's HTTP status + body on a
  // happy path, and a structured failure envelope on any pre-flight
  // or verifier-side error. The 502 status on a verifier 4xx mirrors
  // the way a real wallet would surface the issue: the wire is fine,
  // but the counter-party rejected the submission.
  app.post('/api/qr/send-vp', async (req, reply) => {
    const parsed = QrSendVpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'invalid_request', details: parsed.error.issues });
    }
    const { qrPayload, targetVerifier, dcqlQuery, state } = parsed.data;
    if (!targetVerifier) {
      return reply.code(400).send({ ok: false, error: 'target_verifier_required' });
    }
    const result = await runConformanceQrVp({ qrPayload, targetVerifier, dcqlQuery, state });
    if (!result.ok) {
      // `verifier_rejected` means the wire call happened but the
      // verifier returned 4xx/5xx. Surface that as 502 so callers can
      // distinguish "we never sent anything" (400) from "we sent it
      // and it was rejected" (502). The structured body keeps the
      // verifier's response so the UI can show it.
      const httpStatus = result.error === 'verifier_rejected' ? 502 : 400;
      return reply.code(httpStatus).send({
        ok: false,
        error: result.error,
        status: (result.details as { status?: number } | undefined)?.status,
        details: result.details,
      });
    }
    return reply.send({
      ok: true,
      status: result.status,
      response: result.response,
      vpToken: result.vpToken,
      sentTo: result.sentTo,
      evidence: result.evidence,
    });
  });

  app.get('/api/runs', async () => {
    // MAS-174: backfill `summary` on read if a persisted run somehow
    // landed without one (corrupt on-disk shape, partial migration, etc.).
    // The frontend `renderHistory` and `renderReportInto` both read
    // `r.summary.passed` / `r.summary.failed`; a missing summary crashes
    // them. We rebuild from `results` (which is the source of truth)
    // and the new `summarize()` helper is null-safe.
    return {
      runs: store.list().map((r) => ({
        runId: r.runId,
        mode: r.mode,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        summary: r.summary ?? summarize(r.results),
        target: r.target,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const r = store.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return r;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/report.json', async (req, reply) => {
    const r = store.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${r.runId}.json"`);
    return toJson(r);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/report.html', async (req, reply) => {
    const r = store.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${r.runId}.html"`);
    return toHtml(r);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/report.csv', async (req, reply) => {
    const r = store.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${r.runId}.csv"`);
    return toCsv(r);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/curl', async (req, reply) => {
    const r = store.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const items = r.results
      .filter((t) => !t.pass)
      .map((t) => ({ id: t.id, name: t.name, message: t.message, evidence: t.evidence ?? {} }));
    return { runId: r.runId, items };
  });

  app.get<{ Params: { id: string }; Querystring: { left?: string; right?: string } }>('/api/runs/:id/diff', async (req, reply) => {
    const rightId = req.params.id;
    const leftId = req.query.left;
    if (!leftId) return reply.code(400).send({ error: 'missing_left', message: 'Pass ?left=<runId> to diff against.' });
    const left = store.get(leftId);
    const right = store.get(rightId);
    if (!left) return reply.code(404).send({ error: 'left_not_found', runId: leftId });
    if (!right) return reply.code(404).send({ error: 'right_not_found', runId: rightId });
    return diffReports(left, right);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/logo.svg', async (req, reply) => {
    reply.header('content-type', 'image/svg+xml; charset=utf-8');
    return LOGO_SVG;
  });

  app.get('/api/report/logo.svg', async (_req, reply) => {
    reply.header('content-type', 'image/svg+xml; charset=utf-8');
    return LOGO_SVG;
  });
}

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d6e6e"/>
      <stop offset="1" stop-color="#d2a23c"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="url(#g)"/>
  <path d="M16 20h12a8 8 0 0 1 0 16h-4v8h-8z" fill="#fff" opacity="0.95"/>
  <circle cx="44" cy="44" r="6.4" fill="#fff" opacity="0.95"/>
  <path d="M22 22h6a4 4 0 0 1 0 8h-6z" fill="#0d6e6e"/>
</svg>`;
