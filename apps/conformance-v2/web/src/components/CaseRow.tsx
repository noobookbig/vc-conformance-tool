/**
 * CaseRow — a single test case's status row.
 *
 * Renders with status icon + text label (colour-blind safe — never
 * green/red only). When the row is a failure, shows the failing
 * assertion + a copyable response body in a code block.
 *
 * No false-green UX: a `failed` outcome is rendered as red, never as
 * "passed". Pending/running rows are visually distinct (dashed border,
 * muted colour) so an in-progress run cannot be mistaken for a green pass.
 */

import { useState } from 'react';
import type { CaseRow as CaseRowData } from '../lib/types';
import { STATUS_ICON, STATUS_LABEL } from '../lib/types';

export interface CaseRowProps {
  case: CaseRowData;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '–';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusClass(outcome: CaseRowData['outcome']): string {
  return `status ${outcome}`;
}

export function CaseRow({ case: c }: CaseRowProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const ariaLabel = `${STATUS_LABEL[c.outcome]}: ${c.id}`;

  const onCopy = async (): Promise<void> => {
    try {
      const text = c.responseBody !== undefined ? JSON.stringify(c.responseBody, null, 2) : '';
      if (text) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // clipboard unavailable; silently ignore — copy is a nice-to-have
    }
  };

  return (
    <li
      className={`case-row ${c.outcome === 'failed' ? 'is-failed' : ''}`}
      data-testid={`case-row-${c.id}`}
      aria-label={ariaLabel}
    >
      <span className={statusClass(c.outcome)} aria-hidden="true">
        {STATUS_ICON[c.outcome]}
      </span>
      <div>
        <span className="id">{c.id}</span>
        {c.name ? <span className="name"> — {c.name}</span> : null}
        {c.outcome === 'failed' ? (
          <div className="body" data-testid={`case-body-${c.id}`}>
            {c.message ?? 'assertion mismatch'}
            {c.responseStatus !== undefined ? (
              <>
                {'\n'}Response status: {c.responseStatus}
              </>
            ) : null}
            {c.responseBody !== undefined ? (
              <pre data-testid={`case-response-${c.id}`}>
                {JSON.stringify(c.responseBody, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
      {c.outcome === 'failed' ? (
        <div className="meta-row">
          {c.responseStatus !== undefined ? (
            <span>HTTP {c.responseStatus}</span>
          ) : null}
          {c.responseBody !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCopy}
              aria-label={`Copy response body for ${c.id}`}
            >
              {copied ? 'Copied' : 'Copy body'}
            </button>
          ) : null}
        </div>
      ) : (
        <span className="op">{c.operation ?? ''}</span>
      )}
      <span className="duration">{formatDuration(c.durationMs)}</span>
    </li>
  );
}
