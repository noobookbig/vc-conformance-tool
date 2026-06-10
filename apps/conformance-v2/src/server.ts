/**
 * v2 HTTP server: API + SSE wrapping the v2 engine.
 *
 * Contract (the load-bearing promise the UI workstream MAS-256 depends on):
 *
 *   POST /api/runs                 → { id, status: 'queued' }
 *   GET  /api/runs                 → list (newest first)
 *   GET  /api/runs/:id             → JSON snapshot of run state
 *   GET  /api/runs/:id/events      → SSE stream: run.started, case.passed,
 *                                     case.failed, case.skipped, run.aborted,
 *                                     run.completed
 *   GET  /api/runs/:id/report?format=json|junit|html → same files the CLI writes
 *   GET  /api/health               → liveness probe
 *   GET  /                         → the built SPA (when webDist exists)
 *                                     or 503 with a "UI not yet built" message
 *                                     (placeholder until MAS-256 ships)
 *
 * The server is intentionally IO-free at construction time: `buildApp()`
 * returns a configured Fastify app that the caller can `.listen()` or
 * `.inject()` (the tests use inject; the production entrypoint listens).
 *
 * Run-state lives in an in-memory `RunStore`. That is correct for the
 * self-contained test tool; durability is intentionally NOT a v2 server
 * concern (the CLI writes the report files; the server's job is to
 * expose the run to a browser).
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { runConformance, type Report, type RunnerEvent, type CaseRunResult, type RunTarget } from './runner.js';
import { precheck } from './precheck.js';
import { loadCatalog, CatalogLoadError } from './catalog/loader.js';
import { parseRunConfig, type RunConfig } from './config.js';
import { httpRequest, HttpError } from './http.js';
import { toReportJson, toJunitXml, toReportHtml } from './report/writer.js';
import type { TestCase } from './catalog/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ServerOptions — the only thing the entrypoint + tests need to vary. */
export interface ServerOptions {
  /** Directory of YAML test cases. Required. */
  catalogDir: string;
  /** Pino logger enabled? Default: false in tests, true in production. */
  logger?: boolean;
  /** Optional host binding (default: 0.0.0.0). */
  host?: string;
  /** Optional port (default: 8080). */
  port?: number;
  /**
   * Path to the built SPA's `dist/` directory. When the directory
   * exists, the v2 server mounts it as static assets and serves
   * `index.html` for `GET /`. When absent, the server keeps the
   * historical 503 placeholder so a curious operator gets a clear
   * message instead of a confusing 404.
   *
   * Resolution: if omitted, the server looks for
   * `../web/dist/` relative to its own source file. That covers the
   * standard "v2 engine + v2 web SPA in the same monorepo" layout.
   */
  webDist?: string;
}

/** Run status surfaced over the API. */
export type RunStatus = 'queued' | 'running' | 'completed' | 'aborted' | 'failed';

/** A single SSE-shaped event. The engine emits RunnerEvent; the server
 *  reshapes to this stable wire shape so the UI doesn't need to follow
 *  the runner's internal naming.
 */
export interface SseEvent {
  name:
    | 'run.started'
    | 'case.passed'
    | 'case.failed'
    | 'case.skipped'
    | 'run.aborted'
    | 'run.completed';
  data: Record<string, unknown>;
}

/** In-memory per-run state. */
export interface RunRecord {
  id: string;
  status: RunStatus;
  config: RunConfig;
  events: SseEvent[];
  report: Report | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Listeners (SSE clients) waiting for new events. */
  listeners: Array<(e: SseEvent) => void>;
}

/** A tiny pub-sub keyed by run id. Not thread-safe (Node is single-threaded)
 *  and not persistent (intentional: the server is the engine's UI surface,
 *  not a long-term store). The CLI is the durable record.
 */
export class RunStore {
  private runs = new Map<string, RunRecord>();

  create(cfg: RunConfig): RunRecord {
    const id = newRunId();
    const rec: RunRecord = {
      id,
      status: 'queued',
      config: cfg,
      events: [],
      report: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      listeners: [],
    };
    this.runs.set(id, rec);
    return rec;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Append an SSE-shaped event and notify any listening clients. */
  append(rec: RunRecord, ev: SseEvent): void {
    rec.events.push(ev);
    for (const l of rec.listeners) {
      try {
        l(ev);
      } catch {
        // a misbehaving listener must not poison the runner
      }
    }
  }

  subscribe(rec: RunRecord, fn: (e: SseEvent) => void): () => void {
    rec.listeners.push(fn);
    return () => {
      rec.listeners = rec.listeners.filter((l) => l !== fn);
    };
  }
}

function newRunId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve the SPA dist directory. Returns null when nothing usable is
 *  present so the caller can fall back to the 503 placeholder.
 *
 *  Order:
 *    1. explicit `opts.webDist` (used by tests + custom deployments).
 *       An explicit non-empty value means "the caller has decided", so
 *       we do not fall back to other candidates — this lets a test
 *       force the 503 branch by passing a non-existent path.
 *    2. `../web/dist/` relative to the compiled server file (the
 *       standard monorepo layout for `apps/conformance-v2/`)
 *    3. `WEB_DIST` env override
 *    4. otherwise null
 */
function resolveWebDist(explicit: string | undefined): string | null {
  if (explicit) {
    // Resolve to an absolute path so downstream consumers (e.g.
    // @fastify/static) can rely on a stable invariant — they refuse
    // relative roots. The caller may pass a relative path on the CLI;
    // the resolved absolute is what we return.
    const abs = resolve(explicit);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      if (existsSync(resolve(abs, 'index.html'))) return abs;
    }
    return null;
  }
  const candidates: Array<string | undefined> = [
    resolve(__dirname, '..', 'web', 'dist'),
    process.env.WEB_DIST,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const abs = resolve(c);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      if (existsSync(resolve(abs, 'index.html'))) return abs;
    }
  }
  return null;
}

/** Reshape a runner event to the stable SSE payload the UI depends on.
 *  The optional `bodyFor` map is keyed by case id and lets the server
 *  carry the `responseBody` through (the engine's RunnerEvent does not
 *  include the body — the server captures it in the runCase wrapper and
 *  looks it up at reshape time).
 */
function reshapeEvent(e: RunnerEvent, bodyFor?: Map<string, unknown>): SseEvent {
  switch (e.type) {
    case 'run.started':
      return { name: 'run.started', data: { total: e.total, target: e.target } };
    case 'case.passed':
      return {
        name: 'case.passed',
        data: {
          id: e.id,
          mode: 'live',
          status: 'passed',
          responseStatus: e.responseStatus,
          responseBody: bodyFor?.get(e.id),
          durationMs: e.durationMs,
        },
      };
    case 'case.failed':
      return {
        name: 'case.failed',
        data: {
          id: e.id,
          mode: 'live',
          status: 'failed',
          responseStatus: e.responseStatus,
          responseBody: bodyFor?.get(e.id),
          message: e.message,
          durationMs: e.durationMs,
        },
      };
    case 'case.skipped':
      return {
        name: 'case.skipped',
        data: { id: e.id, status: 'skipped', message: e.message },
      };
    case 'run.aborted':
      return {
        name: 'run.aborted',
        data: {
          abortedAt: e.failedCaseId,
          error: e.reason,
          failedCaseId: e.failedCaseId,
          status: 'failed',
        },
      };
    case 'run.completed':
      return {
        name: 'run.completed',
        data: { status: 'completed', passed: e.passed, failed: e.failed, skipped: e.skipped },
      };
  }
}

/** Build a runCase function for the server. Mirrors the CLI's behavior:
 *  when useMock is true (or no real target is configured), the in-process
 *  mock returns passed=true. Otherwise it hits the target.
 */
function makeServerRunCase(target: RunTarget, useMock: boolean): (tc: TestCase) => Promise<CaseRunResult> {
  if (useMock) {
    return async (tc) => ({
      passed: true,
      responseStatus: 200,
      responseBody: { mock: true, id: tc.id },
      message: 'in-process mock',
    });
  }
  return async (tc) => {
    const baseUrl = target.issuerMetadataUrl ?? target.targetIssuer ?? target.targetVerifier;
    if (!baseUrl) {
      return { passed: false, message: 'no target configured and useMock is false', responseStatus: 0 };
    }
    try {
      const res = await httpRequest(`${baseUrl.replace(/\/$/, '')}/case/${encodeURIComponent(tc.id)}`, {
        method: 'GET',
        timeoutMs: 5000,
      });
      return {
        passed: res.status >= 200 && res.status < 300,
        responseStatus: res.status,
        responseBody: res.body,
        message: res.status >= 200 && res.status < 300 ? 'ok' : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        passed: false,
        message: err instanceof HttpError ? `${err.kind}: ${err.message}` : (err as Error).message,
        responseStatus: 0,
      };
    }
  };
}

/** Build the Fastify app. Returns the app + the run store so tests can
 *  inspect state without going through HTTP.
 */
export async function buildApp(opts: ServerOptions): Promise<{ app: FastifyInstance; store: RunStore }> {
  if (!existsSync(opts.catalogDir) || !statSync(opts.catalogDir).isDirectory()) {
    throw new Error(`catalogDir not found or not a directory: ${opts.catalogDir}`);
  }

  const app = Fastify({
    logger: opts.logger === false
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          transport: process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
    bodyLimit: 1 * 1024 * 1024,
  });

  const store = new RunStore();

  // ----- Liveness + SPA placeholder ----------------------------------
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'conformance-v2',
    version: '2.0.0',
  }));

  // Resolve the SPA dist directory. When present we register the static
  // plugin so the built index.html + assets are served from `/` and the
  // v2 server is the single entrypoint for both API and UI. When absent
  // we keep the 503 placeholder so a confused operator gets a clear
  // message instead of a confusing 404.
  const webDist = resolveWebDist(opts.webDist);
  const webBuilt = webDist !== null;

  if (webBuilt && webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      // SPA fallback: any GET that doesn't match an asset or an API
      // route should serve index.html so React Router can take over.
      // We achieve this with a setNotFoundHandler below.
    });
    // SPA fallback for client-side routes (e.g. /runs/abc/report).
    app.setNotFoundHandler((req, reply) => {
      const accept = req.headers.accept ?? '';
      // Only fall back to index.html for navigations (HTML), not for
      // arbitrary asset misses (those 404 cleanly).
      if (req.method === 'GET' && accept.includes('text/html') && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    // The web UI (MAS-256) will own GET /. Until it ships, surface a
    // 503 with a clear human message so a confused operator gets a
    // hint, not a confusing 404.
    app.get('/', async (_req, reply) => {
      return reply.code(503).send({
        error: 'ui_not_built',
        message: 'UI not yet built — see MAS-256. Use the CLI or the API for now.',
        api: {
          health: 'GET /api/health',
          createRun: 'POST /api/runs',
          snapshot: 'GET /api/runs/:id',
          events: 'GET /api/runs/:id/events (SSE)',
          report: 'GET /api/runs/:id/report?format=json|junit|html',
        },
      });
    });
  }

  // ----- Run creation + listing --------------------------------------
  const CreateRunBody = z.object({
    /** YAML config string (same shape as the CLI's --config file). */
    config: z.string().min(1),
  });

  app.post('/api/runs', async (req, reply) => {
    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    }
    let cfg: RunConfig;
    try {
      cfg = parseRunConfig(parsed.data.config);
    } catch (err) {
      return reply.code(400).send({
        error: 'invalid_config',
        message: (err as Error).message,
      });
    }

    const rec = store.create(cfg);
    // Fire and forget — the runner is the work; the response is the queue
    // receipt. Clients follow up with GET /api/runs/:id and the SSE stream.
    void runOne(rec, opts.catalogDir, store).catch((err) => {
      rec.status = 'failed';
      rec.error = (err as Error).message;
      rec.finishedAt = new Date().toISOString();
    });
    return reply.code(200).send({ id: rec.id, status: rec.status });
  });

  app.get('/api/runs', async () => {
    return {
      runs: store.list().map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        summary: r.report?.summary ?? null,
      })),
    };
  });

  // ----- Run snapshot ------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const rec = store.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    return {
      id: rec.id,
      status: rec.status,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      config: rec.config,
      error: rec.error,
      report: rec.report,
    };
  });

  // ----- SSE event stream -------------------------------------------
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req, reply) => {
    const rec = store.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not_found' });

    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.raw.flushHeaders?.();

    const writeFrame = (ev: SseEvent): void => {
      reply.raw.write(`event: ${ev.name}\n`);
      reply.raw.write(`data: ${JSON.stringify(ev.data)}\n\n`);
    };

    // Replay everything we have so a late subscriber still gets the full
    // history (the UI subscribes immediately, but a curl that opens SSE
    // after `run.started` has already fired still needs to see it).
    for (const ev of rec.events) writeFrame(ev);

    // If the run is already done, close immediately — there will be no
    // more events.
    if (rec.status === 'completed' || rec.status === 'aborted' || rec.status === 'failed') {
      reply.raw.end();
      return reply;
    }

    // Otherwise subscribe and stream live events until the run finishes.
    const unsubscribe = store.subscribe(rec, writeFrame);
    const onFinish = (): void => {
      unsubscribe();
      reply.raw.end();
    };
    const checkFinish = setInterval(() => {
      if (rec.status === 'completed' || rec.status === 'aborted' || rec.status === 'failed') {
        clearInterval(checkFinish);
        onFinish();
      }
    }, 50);

    // Clean up on client disconnect.
    req.raw.on('close', () => {
      clearInterval(checkFinish);
      unsubscribe();
    });

    // Tell Fastify we're handling the response ourselves.
    return reply;
  });

  // ----- Report download --------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/runs/:id/report',
    async (req, reply) => {
      const rec = store.get(req.params.id);
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      if (!rec.report) {
        return reply.code(409).send({ error: 'not_ready', message: 'run has not produced a report yet' });
      }
      const format = (req.query.format ?? 'json').toLowerCase();
      if (format === 'json') {
        reply.header('content-type', 'application/json; charset=utf-8');
        return toReportJson(rec.report);
      }
      if (format === 'junit') {
        reply.header('content-type', 'application/xml; charset=utf-8');
        return toJunitXml(rec.report);
      }
      if (format === 'html') {
        reply.header('content-type', 'text/html; charset=utf-8');
        return toReportHtml(rec.report);
      }
      return reply.code(400).send({
        error: 'invalid_format',
        message: 'format must be one of: json, junit, html',
      });
    }
  );

  return { app, store };
}

/** Drive one run end-to-end: precheck → runner → store final report. */
async function runOne(rec: RunRecord, catalogDir: string, store: RunStore): Promise<void> {
  // The handler synchronously returns { id, status: 'queued' } to the
  // client and then awaits this function. Flipping status to 'running'
  // must happen AFTER that first yield so the queued-state is visible
  // in the response payload.
  await Promise.resolve();
  rec.status = 'running';
  let cases: TestCase[];
  try {
    cases = loadCatalog(catalogDir);
  } catch (err) {
    rec.status = 'failed';
    rec.error = err instanceof CatalogLoadError ? err.message : (err as Error).message;
    rec.finishedAt = new Date().toISOString();
    return;
  }

  // Precheck first. A precheck failure is distinct from a per-case abort:
  // the suite never started. Surface it as a run.aborted event so the UI
  // gets a terminal event either way.
  const pre = await precheck(rec.config.target);
  if (!pre.ok) {
    rec.error = pre.error ?? 'precheck failed';
    const ev: SseEvent = {
      name: 'run.aborted',
      data: {
        abortedAt: 'precheck',
        error: pre.reason ?? pre.error ?? 'precheck failed',
        failedCaseId: 'precheck',
        status: 'failed',
      },
    };
    store.append(rec, ev);
    rec.status = 'aborted';
    rec.finishedAt = new Date().toISOString();
    return;
  }

  const useMock =
    rec.config.useMock === true ||
    (rec.config.target.targetIssuer === undefined && rec.config.target.targetVerifier === undefined);

  // The engine's RunnerEvent does not carry responseBody. We capture it
  // here so the SSE payload (and the report) can include it.
  const bodyFor = new Map<string, unknown>();
  const baseRunCase = makeServerRunCase(rec.config.target, useMock);
  const runCase = async (tc: TestCase): Promise<CaseRunResult> => {
    const res = await baseRunCase(tc);
    if (res.responseBody !== undefined) bodyFor.set(tc.id, res.responseBody);
    return res;
  };

  const report = await runConformance({
    catalog: cases,
    runCase,
    target: rec.config.target,
    emit: (e) => store.append(rec, reshapeEvent(e, bodyFor)),
  });

  rec.report = report;
  rec.status = report.aborted ? 'aborted' : 'completed';
  rec.finishedAt = new Date().toISOString();
}

// ----- Entry point --------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getOpt = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const port = Number(getOpt('--port') ?? process.env.PORT ?? '8080');
  const host = getOpt('--host') ?? process.env.HOST ?? '0.0.0.0';
  const catalogDir = getOpt('--catalog') ?? process.env.CATALOG_DIR ?? 'references/testcases';
  const webDist = getOpt('--web-dist') ?? process.env.WEB_DIST;

  const { app } = await buildApp({ catalogDir, logger: true, host, port, webDist });
  await app.listen({ port, host });
  app.log.info(`conformance-v2 server listening on http://${host}:${port}`);
  app.log.info(`catalog: ${resolve(catalogDir)}`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
