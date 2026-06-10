/**
 * AbortCoordinator — the stop-on-error signal for the v2 runner.
 *
 * The runner registers its callbacks, runs test cases, and calls
 * `fire(reason, failedCaseId)` the moment a real failure is observed.
 * After fire(), the coordinator is latched: it ignores further fire()
 * calls and the `abortedAt` field is frozen to the failing case id.
 *
 * This is intentionally tiny. It owns one EventEmitter and one latch
 * field. The CLI process exits with code 3 when aborted.
 */

import { EventEmitter } from 'node:events';

export interface AbortEvents {
  'run.aborted': (payload: { reason: string; failedCaseId: string }) => void;
}

export declare interface AbortCoordinator {
  on<E extends keyof AbortEvents>(event: E, listener: AbortEvents[E]): this;
  off<E extends keyof AbortEvents>(event: E, listener: AbortEvents[E]): this;
  emit<E extends keyof AbortEvents>(
    event: E,
    ...args: Parameters<AbortEvents[E]>
  ): boolean;
}

export class AbortCoordinator extends EventEmitter {
  private _abortedAt: string | null = null;
  private _reason: string | null = null;

  get abortedAt(): string | null {
    return this._abortedAt;
  }

  get reason(): string | null {
    return this._reason;
  }

  get aborted(): boolean {
    return this._abortedAt !== null;
  }

  /**
   * Latch the abort. Idempotent: subsequent calls are no-ops so a
   * concurrent failure during teardown cannot overwrite the first
   * failing case id.
   */
  fire(reason: string, failedCaseId: string): void {
    if (this._abortedAt !== null) return;
    this._reason = reason;
    this._abortedAt = failedCaseId;
    this.emit('run.aborted', { reason, failedCaseId });
  }

  reset(): void {
    this._abortedAt = null;
    this._reason = null;
    this.removeAllListeners();
  }
}

export const EXIT_CODES = {
  PASS: 0,
  SKIPPED_ONLY: 2,
  ABORTED: 3,
  PRECHECK_FAILED: 4,
} as const;
