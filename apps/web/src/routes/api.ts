/**
 * REST API routes for the conformance test webapp.
 *
 *   GET  /api/health                 → liveness
 *   GET  /api/modes                  → list of supported cross-modes + their tests
 *   GET  /api/credentials            → known credential configurations
 *   GET  /api/config                 → current run config
 *   PUT  /api/config                 → update run config
 *   POST /api/runs                   → start a new run
 *   GET  /api/runs                   → list all runs
 *   GET  /api/runs/:id               → fetch a run
 *   GET  /api/runs/:id/report.json   → download JSON
 *   GET  /api/runs/:id/report.html   → download HTML
 *   POST /api/wallet/keys/regenerate → issue a fresh key pair
 *   GET  /api/wallet/keys            → current key metadata (no private material)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOG, listForMode } from '../wallet/catalog.js';
import { runConformance, makeRunStore, type RunRequest, type RunStore, type Report } from '../runners/runner.js';
import { toHtml, toJson } from '../report/serialize.js';
import { generateKeyStore, type KeyStore, type WalletKey } from '../crypto/keys.js';

const ModeSchema = z.enum(['I->W', 'V->W', 'W->I', 'W->V']);

const ConfigSchema = z.object({
  mode: ModeSchema,
  targetIssuer: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  targetVerifier: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  credentialConfigurationId: z.string().min(1).default('ThaiNationalID'),
  dcqlQuery: z.unknown().optional(),
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

  app.get('/api/runs', async () => ({ runs: store.list().map((r) => ({
    runId: r.runId, mode: r.mode, startedAt: r.startedAt, finishedAt: r.finishedAt,
    summary: r.summary, target: r.target,
  })) }));

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
}
