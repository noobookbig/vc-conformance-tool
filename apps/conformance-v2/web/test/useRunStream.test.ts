/**
 * useRunStream tests — exercises the SSE state machine end-to-end.
 *
 * Strategy: install a fake EventSource on `globalThis` that captures
 * listeners and exposes an emitter. The hook sees a "real" EventSource
 * but we control the wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRunStream } from '../src/hooks/useRunStream';

type Listener = (ev: MessageEvent) => void;
type ErrorListener = (ev: Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  private listeners: Map<string, Listener[]> = new Map();
  private errorListeners: ErrorListener[] = [];
  private openListeners: ErrorListener[] = [];

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: Listener | ErrorListener): void {
    if (name === 'open') {
      this.openListeners.push(fn as ErrorListener);
    } else if (name === 'error') {
      this.errorListeners.push(fn as ErrorListener);
    } else {
      const arr = this.listeners.get(name) ?? [];
      arr.push(fn as Listener);
      this.listeners.set(name, arr);
    }
  }

  removeEventListener(name: string, fn: Listener | ErrorListener): void {
    if (name === 'open') {
      this.openListeners = this.openListeners.filter((l) => l !== fn);
    } else if (name === 'error') {
      this.errorListeners = this.errorListeners.filter((l) => l !== fn);
    } else {
      const arr = this.listeners.get(name) ?? [];
      this.listeners.set(
        name,
        arr.filter((l) => l !== fn),
      );
    }
  }

  close(): void {
    this.readyState = 2;
  }

  // ----- test helpers --------------------------------------------------
  emitOpen(): void {
    this.readyState = 1;
    for (const l of this.openListeners) l(new Event('open'));
  }
  emitEvent(name: string, data: unknown): void {
    const arr = this.listeners.get(name) ?? [];
    for (const l of arr) l({ data: JSON.stringify(data) } as MessageEvent);
  }
  emitError(): void {
    for (const l of this.errorListeners) l(new Event('error'));
  }
  get lastListeners(): Map<string, Listener[]> {
    return this.listeners;
  }
}

function latestSource(): FakeEventSource {
  const inst = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!inst) throw new Error('no FakeEventSource created yet');
  return inst;
}

const sourceFactory = (url: string): EventSource => new FakeEventSource(url) as unknown as EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
});

describe('useRunStream', () => {
  it('opens an EventSource for the run id and ingests run.started', async () => {
    const { result } = renderHook(() => useRunStream('r-1', { sourceFactory }));

    // After mount, the hook has dispatched 'connecting' and constructed
    // the source. React 18 batches effect state updates; flushing
    // effects surfaces them.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('connecting');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toMatch(/\/runs\/r-1\/events$/);

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 3, target: {} });
    });

    expect(result.current.status).toBe('open');
    expect(result.current.state?.status).toBe('running');
    expect(result.current.state?.total).toBe(3);
  });

  it('accumulates case.passed and case.failed rows', async () => {
    const { result } = renderHook(() => useRunStream('r-2', { sourceFactory }));

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 2 });
      latestSource().emitEvent('case.passed', {
        id: 'A',
        mode: 'live',
        status: 'passed',
        responseStatus: 200,
        durationMs: 12,
      });
      latestSource().emitEvent('case.failed', {
        id: 'B',
        mode: 'live',
        status: 'failed',
        responseStatus: 500,
        message: 'assertion mismatch',
        durationMs: 7,
      });
    });

    expect(result.current.state?.cases['A']?.outcome).toBe('passed');
    expect(result.current.state?.cases['A']?.responseStatus).toBe(200);
    expect(result.current.state?.cases['B']?.outcome).toBe('failed');
    expect(result.current.state?.cases['B']?.message).toBe('assertion mismatch');
    expect(result.current.state?.passed).toBe(1);
    expect(result.current.state?.failed).toBe(1);
  });

  it('fires onAborted and flips to aborted state when run.aborted arrives', async () => {
    const onAborted = vi.fn();
    const onTerminal = vi.fn();
    const { result } = renderHook(() =>
      useRunStream('r-3', { onAborted, onTerminal, sourceFactory }),
    );

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 1 });
      latestSource().emitEvent('case.failed', {
        id: 'X',
        mode: 'live',
        status: 'failed',
        responseStatus: 400,
        message: 'expected 200, got 400',
        durationMs: 4,
      });
      latestSource().emitEvent('run.aborted', {
        abortedAt: 'X',
        error: 'stop-on-error',
        failedCaseId: 'X',
        status: 'failed',
      });
    });

    expect(result.current.state?.status).toBe('aborted');
    expect(result.current.state?.abortedError).toBe('stop-on-error');
    expect(result.current.state?.failedCaseId).toBe('X');
    expect(onAborted).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('snapshots the failing case into state on run.aborted even when case.failed raced ahead', async () => {
    // Regression: the engine emits case.failed and run.aborted in the
    // same tick on stop-on-error. The reducer previously read
    // state.cases[id] at render time, so the banner would render with
    // an empty response status/body if the case reducer hadn't
    // committed yet. The fix: snapshot at the run.aborted reducer
    // boundary.
    const { result } = renderHook(() => useRunStream('r-race', { sourceFactory }));

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 1 });
      // Emulate the race: case.failed and run.aborted in the same tick.
      latestSource().emitEvent('case.failed', {
        id: 'Y',
        mode: 'live',
        status: 'failed',
        responseStatus: 502,
        message: 'bad gateway',
        durationMs: 9,
        responseBody: { reason: 'upstream down' },
      });
      latestSource().emitEvent('run.aborted', {
        abortedAt: 'Y',
        error: 'stop-on-error',
        failedCaseId: 'Y',
        status: 'failed',
      });
    });

    // Snapshot is populated from the cases[id] row that the engine
    // emitted in the same tick.
    const snap = result.current.state?.failedCaseSnapshot;
    expect(snap).toBeDefined();
    expect(snap?.id).toBe('Y');
    expect(snap?.responseStatus).toBe(502);
    expect(snap?.responseBody).toEqual({ reason: 'upstream down' });
    expect(snap?.message).toBe('bad gateway');
  });

  it('snapshots a synthetic row when run.aborted arrives without a prior case.failed', async () => {
    // The precheck path aborts the run before any case runs. The
    // synthetic snapshot is built from the aborted event itself so
    // the banner still has an id and a message.
    const { result } = renderHook(() => useRunStream('r-pre', { sourceFactory }));

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 1 });
      latestSource().emitEvent('run.aborted', {
        abortedAt: 'precheck',
        error: 'target unreachable: issuer.example returned HTTP 503',
        failedCaseId: 'precheck',
        status: 'failed',
      });
    });

    const snap = result.current.state?.failedCaseSnapshot;
    expect(snap).toBeDefined();
    expect(snap?.id).toBe('precheck');
    expect(snap?.outcome).toBe('failed');
    expect(snap?.message).toMatch(/target unreachable/);
  });

  it('marks run.completed as the terminal state', async () => {
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useRunStream('r-4', { onTerminal, sourceFactory }));

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 1 });
      latestSource().emitEvent('case.passed', {
        id: 'A',
        mode: 'live',
        status: 'passed',
        responseStatus: 200,
        durationMs: 1,
      });
      latestSource().emitEvent('run.completed', {
        status: 'completed',
        passed: 1,
        failed: 0,
        skipped: 0,
      });
    });

    expect(result.current.state?.status).toBe('completed');
    expect(result.current.state?.passed).toBe(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useRunStream('r-5', { sourceFactory }));
    const src = latestSource();
    await act(async () => {
      src.emitOpen();
    });
    expect(src.readyState).toBe(1);
    unmount();
    expect(src.readyState).toBe(2);
  });
});
