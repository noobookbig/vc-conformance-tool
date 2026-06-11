/**
 * RunRoute — empty-state UX polish for precheck-fail runs.
 *
 * Regression for MAS-275: when a run terminates via precheck failure,
 * no case events have arrived, so `orderedCases` is empty. The previous
 * implementation keyed the empty-state message on the SSE socket status
 * (status === 'open' → "Awaiting…", else → "Connecting…") instead of
 * the run's logical status. Once the precheck-fail run aborted, the SSE
 * was closed and the page rendered "Connecting to event stream…" with
 * 0/0/0/0 counters, contradicting the StopOnErrorBanner above it.
 *
 * The fix: branch the empty-state message on `state.status === 'aborted'`
 * first, so a precheck-fail run shows an "aborted" message regardless of
 * socket lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RunRoute } from '../src/routes/RunRoute';

type Listener = (ev: MessageEvent) => void;
type LifecycleListener = (ev: Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  private listeners: Map<string, Listener[]> = new Map();
  private openListeners: LifecycleListener[] = [];
  private errorListeners: LifecycleListener[] = [];

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: Listener | LifecycleListener): void {
    if (name === 'open') this.openListeners.push(fn as LifecycleListener);
    else if (name === 'error') this.errorListeners.push(fn as LifecycleListener);
    else {
      const arr = this.listeners.get(name) ?? [];
      arr.push(fn as Listener);
      this.listeners.set(name, arr);
    }
  }

  removeEventListener(name: string, fn: Listener | LifecycleListener): void {
    if (name === 'open') this.openListeners = this.openListeners.filter((l) => l !== fn);
    else if (name === 'error') this.errorListeners = this.errorListeners.filter((l) => l !== fn);
    else {
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
}

function latestSource(): FakeEventSource {
  const inst = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!inst) throw new Error('no FakeEventSource created yet');
  return inst;
}

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/runs/:id" element={<RunRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  // RunRoute -> useRunStream resolves EventSource from globalThis so we
  // can install a fake in jsdom without a real network. Same trick
  // referenced in useRunStream.ts:199.
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

describe('RunRoute empty-state for precheck-fail runs (MAS-275)', () => {
  it('renders an "aborted" empty-state when a run aborts before any case event', async () => {
    renderAt('/runs/r-precheck');

    // Open the stream and then immediately abort via precheck failure.
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

    // The precheck-fail run produced zero case events, so the empty-state
    // paragraph is the one in scope for MAS-275.
    const empty = await screen.findByTestId('run-empty');
    await waitFor(() => {
      expect(empty.textContent?.toLowerCase()).toMatch(/abort/);
    });
    // And it must NOT show the contradictory "Connecting…" text.
    expect(empty.textContent).not.toMatch(/connecting/i);
  });

  it('still shows "Awaiting first case event…" while the run is live and no cases have arrived', async () => {
    renderAt('/runs/r-live');

    await act(async () => {
      latestSource().emitOpen();
      latestSource().emitEvent('run.started', { total: 3 });
      // Intentionally do NOT emit any case.passed / case.failed /
      // case.skipped / run.completed / run.aborted events.
    });

    const empty = await screen.findByTestId('run-empty');
    expect(empty.textContent).toMatch(/awaiting/i);
    expect(empty.textContent).not.toMatch(/connecting/i);
    expect(empty.textContent).not.toMatch(/abort/i);
  });
});
