/**
 * Persistent run store. Keeps the latest 100 runs in `apps/web/data/runs.json`
 * so the History view survives a server restart. The in-memory map stays the
 * source of truth at runtime; the file is the durable mirror.
 *
 * Seed mode: when `RUN_HISTORY_SEED=1` is set and the file is empty,
 * `seedRuns()` materializes three mock past runs that QA can use to exercise
 * the History and Diff views before any real runs exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomNonce } from '../crypto/keys.js';
import type { Report } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(__dirname, '../../data');
const DEFAULT_DATA_FILE = resolve(DEFAULT_DATA_DIR, 'runs.json');

export const PERSISTED_RUN_LIMIT = 100;

export interface PersistentRunStoreOptions {
  dataDir?: string;
  dataFile?: string;
  limit?: number;
}

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAll(file: string): Report[] {
  if (!existsSync(file)) return [];
  try {
    const txt = readFileSync(file, 'utf8');
    if (!txt.trim()) return [];
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) return [];
    return parsed as Report[];
  } catch {
    return [];
  }
}

function writeAll(file: string, runs: Report[]): void {
  ensureDir(file);
  writeFileSync(file, JSON.stringify(runs, null, 2));
}

/** Build a deterministic mock run for seeding. */
function buildMockRun(opts: { runId: string; mode: Report['mode']; startedAt: string; durationMs: number; passed: number; failed: number; credentialConfigurationId: string; targetIssuer?: string; targetVerifier?: string; }): Report {
  const ids = [
    'FT.IC.AU.I.H.VB.001', 'FT.IC.AU.I.H.VB.002', 'FT.IC.TO.I.H.VB.001',
    'FT.IC.CI.I.H.VB.001', 'FT.IC.CI.I.H.VB.002', 'FT.IC.DF.I.H.VB.001',
    'FT.PR.AU.V.H.VB.001', 'FT.PR.AU.V.H.IB.001', 'FT.WL.PR.W.V.VB.001',
  ];
  const total = opts.passed + opts.failed;
  const results: Report['results'] = ids.slice(0, total).map((id, i) => {
    const pass = i < opts.passed;
    return {
      id,
      name: `Seeded test ${id}`,
      pass,
      message: pass ? 'PASS (mock seed)' : `FAIL (mock seed): expected 200, got 500`,
      evidence: pass
        ? { method: 'POST', url: 'https://mock.issuer/.well-known/openid-credential-issuer', status: 200 }
        : { method: 'POST', url: 'https://mock.issuer/token', status: 500, body: { error: 'invalid_request' } },
      durationMs: 12 + (i % 5) * 4,
    };
  });
  return {
    runId: opts.runId,
    mode: opts.mode,
    startedAt: opts.startedAt,
    finishedAt: new Date(new Date(opts.startedAt).getTime() + opts.durationMs).toISOString(),
    durationMs: opts.durationMs,
    target: {
      issuer: opts.targetIssuer,
      verifier: opts.targetVerifier,
      credentialConfigurationId: opts.credentialConfigurationId,
    },
    results,
    summary: { total, passed: opts.passed, failed: opts.failed, skipped: 0, coverage: 0, passRate: total ? opts.passed / total : 0 },
    context: { keys: { es256Kid: 'seed-es256', eddsaKid: 'seed-eddsa' }, pkce: { codeChallengeMethod: 'S256' } },
  };
}

export function seedRuns(): Report[] {
  const t0 = Date.now();
  return [
    buildMockRun({
      runId: `seed-run-aaa-${randomNonce(4)}`,
      mode: 'W->I',
      startedAt: new Date(t0 - 1000 * 60 * 60 * 26).toISOString(),
      durationMs: 1820,
      passed: 7,
      failed: 0,
      credentialConfigurationId: 'ThaiNationalID',
    }),
    buildMockRun({
      runId: `seed-run-bbb-${randomNonce(4)}`,
      mode: 'W->I',
      startedAt: new Date(t0 - 1000 * 60 * 60 * 4).toISOString(),
      durationMs: 2310,
      passed: 5,
      failed: 2,
      credentialConfigurationId: 'ThaiNationalID',
    }),
    buildMockRun({
      runId: `seed-run-ccc-${randomNonce(4)}`,
      mode: 'V->W',
      startedAt: new Date(t0 - 1000 * 60 * 30).toISOString(),
      durationMs: 1450,
      passed: 8,
      failed: 1,
      credentialConfigurationId: 'ThaiUniversityDegree',
    }),
  ];
}

export function makePersistentRunStore(opts: PersistentRunStoreOptions = {}) {
  const dataFile = opts.dataFile ?? process.env.RUN_HISTORY_FILE ?? DEFAULT_DATA_FILE;
  const limit = opts.limit ?? PERSISTED_RUN_LIMIT;
  const seeded = process.env.RUN_HISTORY_SEED === '1';

  const mem = new Map<string, Report>();
  for (const r of readAll(dataFile)) mem.set(r.runId, r);

  if (seeded && mem.size === 0) {
    for (const r of seedRuns()) mem.set(r.runId, r);
    writeAll(dataFile, Array.from(mem.values()));
  }

  function flush(): void {
    const all = Array.from(mem.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const trimmed = all.slice(0, limit);
    writeAll(dataFile, trimmed);
    if (trimmed.length < all.length) {
      const removed = new Set(all.slice(limit).map((r) => r.runId));
      for (const id of removed) mem.delete(id);
    }
  }

  return {
    save(report: Report): void {
      mem.set(report.runId, report);
      flush();
    },
    get(id: string): Report | undefined {
      return mem.get(id);
    },
    list(): Report[] {
      return Array.from(mem.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    latest(): Report | undefined {
      const all = Array.from(mem.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return all[0];
    },
    dataFile,
  };
}

export type PersistentRunStore = ReturnType<typeof makePersistentRunStore>;
