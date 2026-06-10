/**
 * RunRoute — the live progress view.
 *
 * Renders:
 *  - StopOnErrorBanner the moment `run.aborted` (or `failed`) fires
 *  - A progress bar (passed + failed + skipped) / total
 *  - One row per case that has resolved, with case.passed → green,
 *    case.failed → red (no false greens), case.skipped → gold
 *  - A live region (aria-live=polite) that announces progress to screen
 *    readers
 *  - When the run is done, a "View report" link to the ReportRoute
 */

import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRunStream } from '../hooks/useRunStream';
import { CaseRow } from '../components/CaseRow';
import { StopOnErrorBanner } from '../components/StopOnErrorBanner';
import type { CaseRow as CaseRowData } from '../lib/types';

export function RunRoute(): JSX.Element {
  const params = useParams();
  const runId = params.id ?? null;
  const { state, status } = useRunStream(runId);

  const orderedCases: CaseRowData[] = useMemo(() => {
    if (!state) return [];
    return Object.values(state.cases).sort((a, b) => a.id.localeCompare(b.id));
  }, [state]);

  const progressPct = state
    ? Math.min(
        100,
        Math.round(
          ((state.passed + state.failed + state.skipped) /
            Math.max(1, state.total)) *
            100,
        ),
      )
    : 0;

  const isTerminal =
    state?.status === 'completed' ||
    state?.status === 'aborted' ||
    state?.status === 'failed';

  return (
    <section aria-labelledby="run-h">
      <header className="view-header">
        <div>
          <span className="eyebrow">Step 02 · Run</span>
          <h2 id="run-h">
            Live run <em>{runId}</em>
          </h2>
          <p>
            Live progress from the v2 engine. The Stop-on-error banner shows
            the moment a real failure halts the suite.
          </p>
        </div>
        <div className="field-row">
          {isTerminal ? (
            <Link
              to={`/runs/${encodeURIComponent(runId ?? '')}/report`}
              className="btn btn-primary"
              data-testid="link-report"
            >
              View report
            </Link>
          ) : null}
        </div>
      </header>

      {state ? (
        <StopOnErrorBanner state={state} />
      ) : null}

      <div className="progress" aria-hidden={status === 'open' ? 'false' : 'true'}>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct}>
          <span style={{ width: `${progressPct}%` }} />
        </div>
        <span className="label">
          {state
            ? `${state.passed} passed · ${state.failed} failed · ${state.skipped} skipped · ${state.total} total`
            : 'Connecting…'}
        </span>
      </div>

      {/* Live region: announces progress to assistive tech. */}
      <div
        className="live-sr"
        aria-live="polite"
        aria-atomic="true"
        data-testid="run-live"
      >
        {state
          ? `Run ${state.id}: ${state.status}. ${state.passed} passed, ${state.failed} failed, ${state.skipped} skipped of ${state.total}.`
          : 'Connecting to run stream.'}
      </div>

      {orderedCases.length === 0 ? (
        <p className="empty" data-testid="run-empty">
          {status === 'open' ? 'Awaiting first case event…' : 'Connecting to event stream…'}
        </p>
      ) : (
        <ul className="case-list" data-testid="case-list">
          {orderedCases.map((c) => (
            <CaseRow key={c.id} case={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
