/**
 * useRunStream — subscribe to /api/runs/:id/events and accumulate a RunState.
 *
 * The hook owns the EventSource lifecycle and is the single source of
 * truth for run state in the UI. The state model is:
 *
 *   RunState = { id, status, total, cases: Record<id, CaseRow>, ... }
 *
 * SSE frames are SSE-typed: `event: <name>` line, then `data: <json>`.
 * We translate each event into a state patch.
 *
 * The hook:
 *   - opens an EventSource on mount (or when id changes)
 *   - ingests each event, applies it to state
 *   - calls onComplete / onAborted callbacks when those terminal events fire
 *   - closes the EventSource when the run finishes OR the component unmounts
 *   - exposes a `status` field for the parent to know the connection state
 */

import { useEffect, useReducer, useRef } from 'react';
import type {
  CaseFailedData,
  CasePassedData,
  CaseRow,
  RunAbortedData,
  RunCompletedData,
  RunState,
  RunStartedData,
  SseEventData,
} from '../lib/types';
import { api } from '../lib/api';

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseRunStreamOptions {
  /** Called when the run reaches a terminal state (completed or aborted). */
  onTerminal?: (state: RunState) => void;
  /** Called when the run aborts specifically (stop-on-error). */
  onAborted?: (state: RunState, data: RunAbortedData) => void;
  /**
   * Inject a custom event source. Tests use this to feed synthetic SSE
   * streams without a real network.
   */
  sourceFactory?: (url: string) => EventSource;
}

interface InternalState {
  state: RunState | null;
  status: StreamStatus;
}

type Action =
  | { type: 'open' }
  | { type: 'connecting' }
  | { type: 'close' }
  | { type: 'error' }
  | { type: 'event'; event: SseEventData }
  | { type: 'reset'; id: string };

function emptyState(id: string): RunState {
  return {
    id,
    status: 'queued',
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cases: {},
  };
}

function reducer(s: InternalState, action: Action): InternalState {
  switch (action.type) {
    case 'reset':
      return { state: emptyState(action.id), status: 'idle' };
    case 'connecting':
      return { ...s, status: 'connecting' };
    case 'open':
      return { ...s, status: 'open' };
    case 'close':
      return { ...s, status: 'closed' };
    case 'error':
      return { ...s, status: 'error' };
    case 'event': {
      const ev = action.event;
      if (!s.state) return s;
      const next: RunState = { ...s.state, cases: { ...s.state.cases } };
      switch (ev.name) {
        case 'run.started': {
          const data = ev as RunStartedData & { name: 'run.started' };
          next.status = 'running';
          next.total = data.total;
          next.startedAt = new Date().toISOString();
          break;
        }
        case 'case.passed': {
          const data = ev as CasePassedData & { name: 'case.passed' };
          const row: CaseRow = {
            id: data.id,
            outcome: 'passed',
            responseStatus: data.responseStatus,
            durationMs: data.durationMs,
            responseBody: data.responseBody,
          };
          next.cases[data.id] = row;
          next.passed = next.passed + 1;
          break;
        }
        case 'case.failed': {
          const data = ev as CaseFailedData & { name: 'case.failed' };
          const row: CaseRow = {
            id: data.id,
            outcome: 'failed',
            responseStatus: data.responseStatus,
            durationMs: data.durationMs,
            message: data.message,
            responseBody: data.responseBody,
          };
          next.cases[data.id] = row;
          next.failed = next.failed + 1;
          break;
        }
        case 'case.skipped': {
          const data = ev as { id: string; status: 'skipped'; message?: string };
          const row: CaseRow = {
            id: data.id,
            outcome: 'skipped',
            message: data.message,
          };
          next.cases[data.id] = row;
          next.skipped = next.skipped + 1;
          break;
        }
        case 'run.aborted': {
          const data = ev as RunAbortedData & { name: 'run.aborted' };
          next.status = 'aborted';
          next.abortedAt = data.abortedAt;
          next.abortedError = data.error;
          next.failedCaseId = data.failedCaseId;
          next.finishedAt = new Date().toISOString();
          break;
        }
        case 'run.completed': {
          const data = ev as RunCompletedData & { name: 'run.completed' };
          next.status = 'completed';
          next.finishedAt = new Date().toISOString();
          next.passed = data.passed;
          next.failed = data.failed;
          next.skipped = data.skipped;
          break;
        }
      }
      return { state: next, status: s.status };
    }
  }
}

export function useRunStream(
  runId: string | null,
  opts: UseRunStreamOptions = {},
): { state: RunState | null; status: StreamStatus } {
  const [internal, dispatch] = useReducer(reducer, {
    state: runId ? emptyState(runId) : null,
    status: 'idle',
  });
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!runId) return;
    dispatch({ type: 'reset', id: runId });
    dispatch({ type: 'connecting' });
    let es: EventSource | null = null;
    // Use the ref so the effect doesn't depend on a fresh opts object
    // reference on every render. The ref is updated synchronously above.
    const factory = optsRef.current.sourceFactory;
    try {
      if (factory) {
        es = factory(api.eventsUrl(runId));
      } else {
        // Resolve EventSource from globalThis at call time so jsdom tests
        // can install a fake via `globalThis.EventSource = ...`. The
        // direct `new EventSource(...)` form would not honour that
        // substitution under Vite's ESM module graph.
        const Ctor = (globalThis as { EventSource?: new (url: string) => EventSource }).EventSource;
        if (!Ctor) throw new Error('EventSource is not available in this environment');
        es = new Ctor(api.eventsUrl(runId));
      }
    } catch (err) {
      dispatch({ type: 'error' });
      void err;
      return;
    }

    const handlers: Array<[string, (ev: MessageEvent) => void]> = [
      ['run.started', makeHandler('run.started', dispatch)],
      ['case.passed', makeHandler('case.passed', dispatch)],
      ['case.failed', makeHandler('case.failed', dispatch)],
      ['case.skipped', makeHandler('case.skipped', dispatch)],
      ['run.aborted', makeHandler('run.aborted', dispatch)],
      ['run.completed', makeHandler('run.completed', dispatch)],
    ];
    for (const [name, fn] of handlers) es.addEventListener(name, fn);

    const onOpen = (): void => {
      dispatch({ type: 'open' });
    };
    const onError = (): void => {
      dispatch({ type: 'error' });
    };
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);

    return () => {
      for (const [name, fn] of handlers) es?.removeEventListener(name, fn);
      es?.removeEventListener('open', onOpen);
      es?.removeEventListener('error', onError);
      es?.close();
      dispatch({ type: 'close' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const prevStatus = useRef<RunStatus | null>(null);
  useEffect(() => {
    const s = internal.state;
    if (!s) return;
    if (s.status === 'completed' || s.status === 'aborted' || s.status === 'failed') {
      if (prevStatus.current !== s.status) {
        prevStatus.current = s.status;
        optsRef.current.onTerminal?.(s);
        if (s.status === 'aborted' && s.abortedError) {
          optsRef.current.onAborted?.(s, {
            abortedAt: s.abortedAt ?? '',
            error: s.abortedError,
            failedCaseId: s.failedCaseId ?? '',
            status: 'failed',
          });
        }
      }
    } else {
      prevStatus.current = s.status;
    }
  }, [internal.state]);

  return { state: internal.state, status: internal.status };
}

function makeHandler(
  name: string,
  dispatch: React.Dispatch<Action>,
): (ev: MessageEvent) => void {
  return (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data);
      dispatch({ type: 'event', event: { name, ...data } as SseEventData });
    } catch {
      // malformed frame — skip
    }
  };
}

// Import RunStatus type from types for the ref above.
import type { RunStatus } from '../lib/types';
