import { describe, it, expect, beforeEach } from 'vitest';
import { AbortCoordinator, EXIT_CODES } from '../src/abort.js';

describe('AbortCoordinator', () => {
  let abort: AbortCoordinator;

  beforeEach(() => {
    abort = new AbortCoordinator();
  });

  it('starts not aborted', () => {
    expect(abort.aborted).toBe(false);
    expect(abort.abortedAt).toBeNull();
    expect(abort.reason).toBeNull();
  });

  it('fire() latches abortedAt to the failing case id', () => {
    abort.fire('assertion mismatch', 'FT.IC.AU.I.H.VB.001');
    expect(abort.aborted).toBe(true);
    expect(abort.abortedAt).toBe('FT.IC.AU.I.H.VB.001');
    expect(abort.reason).toBe('assertion mismatch');
  });

  it('fire() is idempotent: first failing case wins', () => {
    abort.fire('first', 'CASE-1');
    abort.fire('second', 'CASE-2');
    expect(abort.abortedAt).toBe('CASE-1');
    expect(abort.reason).toBe('first');
  });

  it('emits run.aborted exactly once with the failing payload', () => {
    const events: Array<{ reason: string; failedCaseId: string }> = [];
    abort.on('run.aborted', (p) => events.push(p));
    abort.fire('r1', 'C-1');
    abort.fire('r2', 'C-2');
    expect(events).toEqual([{ reason: 'r1', failedCaseId: 'C-1' }]);
  });

  it('reset() clears the latch so the coordinator can be reused', () => {
    abort.fire('r', 'C');
    abort.reset();
    expect(abort.aborted).toBe(false);
    expect(abort.abortedAt).toBeNull();
  });

  it('exposes the exit-code contract the CLI honours', () => {
    expect(EXIT_CODES.PASS).toBe(0);
    expect(EXIT_CODES.SKIPPED_ONLY).toBe(2);
    expect(EXIT_CODES.ABORTED).toBe(3);
    expect(EXIT_CODES.PRECHECK_FAILED).toBe(4);
  });
});
