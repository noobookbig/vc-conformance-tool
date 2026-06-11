/**
 * StopOnErrorBanner — first-class banner that surfaces stop-on-error.
 *
 * Renders the moment `run.aborted` fires (or `run.status === 'aborted'`).
 * Shows the failing case id, the failing expectation (message), the
 * response status, and a copyable response body.
 *
 * Accessibility:
 *   - role="status" so screen readers announce it
 *   - aria-live="assertive" so the announcement is prompt (not polite)
 *   - the icon is an exclamation mark + label, not just colour
 *   - keyboard reachable (the copy button is a real <button>)
 *
 * No "false green": the banner is shown for `aborted` and `failed`
 * statuses, never for `completed`.
 */

import { useState } from 'react';
import type { RunState } from '../lib/types';

export interface StopOnErrorBannerProps {
  state: RunState;
  onViewReport?: () => void;
}

export function StopOnErrorBanner({
  state,
  onViewReport,
}: StopOnErrorBannerProps): JSX.Element | null {
  const [copied, setCopied] = useState(false);

  if (state.status !== 'aborted' && state.status !== 'failed') return null;

  const failedCaseId = state.failedCaseId ?? state.abortedAt ?? 'unknown';
  // Prefer the snapshot taken at the moment run.aborted fired; fall
  // back to the live case row, then to the aborted event's own error
  // string. This keeps the banner informative even when case.failed
  // and run.aborted race.
  const failingCase = state.failedCaseSnapshot
    ?? (state.failedCaseId ? state.cases[state.failedCaseId] : undefined);
  const expectation = failingCase?.message ?? state.abortedError ?? 'assertion mismatch';
  const responseStatus = failingCase?.responseStatus;
  const responseBody = failingCase?.responseBody;
  const evidence = failingCase?.evidence;
  const responseBodyText = evidence
    ? `${evidence.request.method} ${evidence.request.url}\n` +
      `HTTP ${evidence.response.status}\n` +
      (evidence.mock === true ? '(in-process mock)\n' : '') +
      JSON.stringify(evidence.response.body, null, 2)
    : responseBody !== undefined
      ? JSON.stringify(responseBody, null, 2)
      : '';

  const onCopy = async (): Promise<void> => {
    try {
      if (responseBodyText) {
        await navigator.clipboard.writeText(responseBodyText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <aside
      className="soe-banner"
      role="status"
      aria-live="assertive"
      aria-label="Run aborted due to stop-on-error"
      data-testid="stop-on-error-banner"
    >
      <span className="icon" aria-hidden="true">
        !
      </span>
      <div>
        <p className="heading" data-testid="soe-heading">
          Run halted — stop-on-error
        </p>
        <p className="body">
          The suite stopped at the first failing case. The remaining cases
          were not run.
        </p>
        <dl className="meta">
          <dt>Failing case</dt>
          <dd data-testid="soe-case-id">{failedCaseId}</dd>
          <dt>Expectation</dt>
          <dd data-testid="soe-expectation">{expectation}</dd>
          {responseStatus !== undefined ? (
            <>
              <dt>Response status</dt>
              <dd data-testid="soe-status">{responseStatus}</dd>
            </>
          ) : null}
          {responseBodyText ? (
            <>
              <dt>Response body</dt>
              <dd>
                <pre data-testid="soe-body">{responseBodyText}</pre>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="actions">
        {responseBodyText ? (
          <button
            type="button"
            className="btn"
            onClick={onCopy}
            aria-label="Copy response body"
            data-testid="soe-copy"
          >
            {copied ? 'Copied' : 'Copy body'}
          </button>
        ) : null}
        {onViewReport ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onViewReport}
            data-testid="soe-view-report"
          >
            Open report
          </button>
        ) : null}
      </div>
    </aside>
  );
}
