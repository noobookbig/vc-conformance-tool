/**
 * Fastify server entrypoint.
 *
 *  - mounts the REST API (config, runs, reports, catalog, health)
 *  - mounts the in-process mock issuer + verifier fixtures
 *  - serves the static SPA from apps/web/public
 *
 * Run with `npm start` (or `npm run dev` for watch mode).
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { generateKeyStore, type KeyStore } from './crypto/keys.js';
import { registerApiRoutes, defaultConfig, type Config } from './routes/api.js';
import { makeRunStore, type RunStore } from './runners/runner.js';
import { mountMockFixtures } from './fixtures/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '../public');

export interface ServerOptions {
  logger?: boolean;
  port?: number;
  host?: string;
  keys?: KeyStore;
  config?: Config;
}

export async function buildApp(opts: { keys?: KeyStore; config?: Config; logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          transport: process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/', index: ['index.html'] });

  // Per-server mutable state
  let keys: KeyStore = opts.keys ?? await generateKeyStore();
  let config: Config = opts.config ?? defaultConfig();
  const store: RunStore = makeRunStore();

  await app.register(async (instance) => {
    await registerApiRoutes(instance, {
      store,
      getKeys: async () => keys,
      regenerateKeys: async () => { keys = await generateKeyStore(); return keys; },
      getConfig: () => config,
      setConfig: (c) => { config = c; },
    });
  });

  // Mock fixtures (so the tool is self-contained)
  await app.register(async (instance) => {
    await mountMockFixtures(instance);
  });

  // SPA fallback: any non-API GET → index.html so the SPA can do its routing
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/.mock/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (req.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return { app, store, getKeys: () => keys, getConfig: () => config };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const { app } = await buildApp({});
  await app.listen({ port, host });
  app.log.info(`VC Conformance Test Webapp listening on http://${host}:${port}`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
