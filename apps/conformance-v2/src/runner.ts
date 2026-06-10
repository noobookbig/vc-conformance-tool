/**
 * runConformance — the v2 engine's main loop.
 *
 * Iterates the catalog in id order, calling `runCase(tc)` for each one.
 * Stops on the first real failure (a `passed: false` result that is not
 * `skipped: true`). Skipped cases never trigger stop-on-error.
 *
 * Emits events: `run.started`, `case.passed`, `case.failed`,
 * `case.skipped`, `run.aborted`, `run.completed`. The server (MAS-255)
 * wraps these as SSE; the CLI (this file's caller) prints them to
 * stderr for log-tailing.
 *
 * Returns a `Report` whose `aborted` and `abortedAt` fields are the
 * authoritative answer to "did the suite run to completion?".
 *
 * The runner is intentionally IO-free: the caller passes in a
 * `runCase` function. This keeps the runner unit-testable (see
 * `stop-on-error.test.ts`) and means a real `httpRequest` failure
 * becomes a `passed: false` result rather than a thrown error inside
 * the loop.
 */

import { EventEmitter } from 'node:events';
import type { TestCase } from './catalog/types.js';
import { AbortCoordinator } from './abort.js';

export type RunnerEvent =
  | { type: 'run.started'; total: number; target: RunTarget }
  | { type: 'case.passed'; id: string; durationMs: number; responseStatus?: number }
  | { type: 'case.failed'; id: string; durationMs: number; responseStatus?: number; message?: string }
  | { type: 'case.skipped'; id: string; message?: string }
  | { type: 'run.aborted'; reason: string; failedCaseId: string }
  | { type: 'run.completed'; passed: number; failed: number; skipped: number };

export interface RunTarget {
  targetIssuer?: string;
  targetVerifier?: string;
  wallet?: string;
  issuerMetadataUrl?: string;
  credentialConfigurationId?: string;
}

export interface CaseRunResult {
  passed: boolean;
  /** When true, the case is reported as SKIPPED and does NOT trigger stop-on-error. */
  skipped?: boolean;
  message?: string;
  responseStatus?: number;
  responseBody?: unknown;
}

export interface RunOptions {
  catalog: TestCase[];
  runCase: (tc: TestCase) => Promise<CaseRunResult>;
  target?: RunTarget;
  /** Optional event sink. When omitted, events go to an internal EventEmitter
   *  (useful for tests that subscribe to it via the returned emitter). */
  emit?: (e: RunnerEvent) => void;
  /** Optional abort coordinator. When omitted, a fresh one is created. */
  abort?: AbortCoordinator;
  /** Optional pre-set aborted state; the runner will not start when truthy. */
  precheckFailed?: boolean;
}

export interface Report {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: RunTarget;
  results: Array<{
    id: string;
    name: string;
    operation: string;
    passed: boolean;
    skipped: boolean;
    message?: string;
    responseStatus?: number;
    responseBody?: unknown;
    durationMs: number;
  }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  aborted: boolean;
  abortedAt: string | null;
  error?: string;
}

function newRunId(): string {
  // Short, sortable, non-secret run id. No uuid dep needed.
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runConformance(opts: RunOptions): Promise<Report> {
  const abort = opts.abort ?? new AbortCoordinator();
  const internalEmitter = new EventEmitter();
  const emit = (e: RunnerEvent): void => {
    if (opts.emit) opts.emit(e);
    internalEmitter.emit('event', e);
  };

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results: Report['results'] = [];
  const target: RunTarget = opts.target ?? {};
  const total = opts.catalog.length;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = false;
  let abortedAt: string | null = null;

  if (opts.precheckFailed) {
    // Precheck failed upstream: emit aborted with no case and exit.
    abort.fire('precheck failed', 'precheck');
    aborted = true;
    abortedAt = 'precheck';
    emit({ type: 'run.aborted', reason: 'precheck failed', failedCaseId: 'precheck' });
  } else {
    emit({ type: 'run.started', total, target });

    for (const tc of opts.catalog) {
      if (abort.aborted) break;
      const tCase = Date.now();
      let res: CaseRunResult;
      try {
        res = await opts.runCase(tc);
      } catch (err) {
        // An exception inside the case body counts as a real failure
        // (network errors, throws from a fixture, etc.).
        res = {
          passed: false,
          message: `runner exception: ${(err as Error).message}`,
        };
      }
      const caseDuration = Date.now() - tCase;

      if (res.skipped) {
        skipped++;
        results.push({
          id: tc.id,
          name: tc.name,
          operation: tc.operation,
          passed: false,
          skipped: true,
          message: res.message,
          durationMs: caseDuration,
        });
        emit({ type: 'case.skipped', id: tc.id, message: res.message });
        continue;
      }

      if (res.passed) {
        passed++;
        results.push({
          id: tc.id,
          name: tc.name,
          operation: tc.operation,
          passed: true,
          skipped: false,
          message: res.message,
          responseStatus: res.responseStatus,
          durationMs: caseDuration,
        });
        emit({
          type: 'case.passed',
          id: tc.id,
          durationMs: caseDuration,
          responseStatus: res.responseStatus,
        });
        continue;
      }

      // Real failure: stop the suite, latch the abort.
      failed++;
      results.push({
        id: tc.id,
        name: tc.name,
        operation: tc.operation,
        passed: false,
        skipped: false,
        message: res.message,
        responseStatus: res.responseStatus,
        responseBody: res.responseBody,
        durationMs: caseDuration,
      });
      emit({
        type: 'case.failed',
        id: tc.id,
        durationMs: caseDuration,
        responseStatus: res.responseStatus,
        message: res.message,
      });
      abort.fire(res.message ?? 'assertion mismatch', tc.id);
      aborted = true;
      abortedAt = tc.id;
      emit({ type: 'run.aborted', reason: res.message ?? 'assertion mismatch', failedCaseId: tc.id });
    }
  }

  if (!aborted) {
    emit({ type: 'run.completed', passed, failed, skipped });
  }

  const finishedAt = new Date().toISOString();
  const report: Report = {
    runId: newRunId(),
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    target,
    results,
    summary: { total: results.length, passed, failed, skipped },
    aborted,
    abortedAt,
  };
  if (opts.precheckFailed) report.error = 'precheck failed';
  return report;
}
