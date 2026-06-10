import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StopOnErrorBanner } from '../src/components/StopOnErrorBanner';
import type { RunState } from '../src/lib/types';

function abortedState(over: Partial<RunState> = {}): RunState {
  return {
    id: 'r-1',
    status: 'aborted',
    total: 3,
    passed: 0,
    failed: 1,
    skipped: 0,
    cases: {
      'X.1': {
        id: 'X.1',
        outcome: 'failed',
        message: 'expected 200, got 500',
        responseStatus: 500,
        responseBody: { error: 'server_error' },
      },
    },
    abortedAt: 'X.1',
    abortedError: 'stop-on-error',
    failedCaseId: 'X.1',
    ...over,
  };
}

describe('StopOnErrorBanner', () => {
  it('renders nothing for a completed run', () => {
    const state: RunState = {
      id: 'r-1',
      status: 'completed',
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      cases: {},
    };
    const { container } = render(<StopOnErrorBanner state={state} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the failing case id, the failing expectation, status, and body when the run aborted', () => {
    render(<StopOnErrorBanner state={abortedState()} />);
    const banner = screen.getByTestId('stop-on-error-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByTestId('soe-case-id').textContent).toBe('X.1');
    expect(screen.getByTestId('soe-expectation').textContent).toMatch(/expected 200, got 500/);
    expect(screen.getByTestId('soe-status').textContent).toBe('500');
    const body = screen.getByTestId('soe-body').textContent ?? '';
    expect(body).toContain('"error"');
    expect(body).toContain('"server_error"');
  });

  it('shows a copy-body button so the operator can paste the failure into a bug report', () => {
    render(<StopOnErrorBanner state={abortedState()} />);
    const copyBtn = screen.getByTestId('soe-copy');
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).toHaveAttribute('aria-label', 'Copy response body');
  });

  it('renders a precheck-aborted run with the precheck error', () => {
    const state = abortedState({
      abortedAt: 'precheck',
      failedCaseId: 'precheck',
      abortedError: 'target unreachable: issuer.example returned HTTP 503',
      cases: {},
    });
    render(<StopOnErrorBanner state={state} />);
    expect(screen.getByTestId('soe-case-id').textContent).toBe('precheck');
    expect(screen.getByTestId('soe-expectation').textContent).toMatch(/target unreachable/);
  });

  it('shows status and body from failedCaseSnapshot when cases[id] is missing (case.failed raced ahead of run.aborted)', () => {
    // The engine can emit case.failed and run.aborted in the same tick.
    // The reducer snapshots the failing case at the moment run.aborted
    // fires; the banner must read from that snapshot, not from
    // state.cases[id], which may not have landed yet.
    const state: RunState = {
      id: 'r-2',
      status: 'aborted',
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      cases: {}, // empty — case.failed hasn't landed in state yet
      failedCaseId: 'X.1',
      abortedError: 'stop-on-error',
      failedCaseSnapshot: {
        id: 'X.1',
        outcome: 'failed',
        message: 'expected 200, got 500',
        responseStatus: 500,
        responseBody: { error: 'server_error' },
      },
    };
    render(<StopOnErrorBanner state={state} />);
    expect(screen.getByTestId('soe-case-id').textContent).toBe('X.1');
    expect(screen.getByTestId('soe-expectation').textContent).toMatch(/expected 200, got 500/);
    expect(screen.getByTestId('soe-status').textContent).toBe('500');
    const body = screen.getByTestId('soe-body').textContent ?? '';
    expect(body).toContain('"error"');
    expect(body).toContain('"server_error"');
  });

  it('falls back to the synthetic snapshot (from aborted event) when neither cases[id] nor an earlier case.failed is available', () => {
    // Pathological case: run.aborted arrives without a prior case.failed.
    // The reducer builds a synthetic snapshot from the event data so the
    // banner is still meaningful.
    const state: RunState = {
      id: 'r-3',
      status: 'aborted',
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      cases: {},
      failedCaseId: 'precheck',
      abortedError: 'target unreachable: issuer.example returned HTTP 503',
      failedCaseSnapshot: {
        id: 'precheck',
        outcome: 'failed',
        message: 'target unreachable: issuer.example returned HTTP 503',
      },
    };
    render(<StopOnErrorBanner state={state} />);
    expect(screen.getByTestId('soe-case-id').textContent).toBe('precheck');
    expect(screen.getByTestId('soe-expectation').textContent).toMatch(/target unreachable/);
  });
});
