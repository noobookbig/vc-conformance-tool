import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseRow } from '../src/components/CaseRow';
import type { CaseRow as CaseRowData } from '../src/lib/types';

function mk(over: Partial<CaseRowData>): CaseRowData {
  return {
    id: 'A.1',
    outcome: 'passed',
    ...over,
  };
}

describe('CaseRow', () => {
  it('shows the case id and a status label (not colour alone)', () => {
    render(<CaseRow case={mk({ id: 'A.1', outcome: 'passed' })} />);
    const row = screen.getByTestId('case-row-A.1');
    expect(row).toHaveAttribute('aria-label', 'Passed: A.1');
    // The visible status is a text + icon; do not assert colour, just the
    // semantic role.
    expect(row.textContent).toMatch(/A\.1/);
  });

  it('renders the failing case with the failing message, status, and a copyable response body', () => {
    render(
      <CaseRow
        case={mk({
          id: 'B.2',
          outcome: 'failed',
          message: 'expected 200, got 404',
          responseStatus: 404,
          responseBody: { error: 'not_found' },
        })}
        runId="r-test"
      />,
    );
    const row = screen.getByTestId('case-row-B.2');
    expect(row).toHaveAttribute('aria-label', 'Failed: B.2');
    expect(screen.getByTestId('case-log-B.2')).toBeInTheDocument();
    expect(screen.getByTestId('case-log-message-B.2').textContent).toMatch(/expected 200, got 404/);
    expect(screen.getByTestId('case-log-summary-B.2').textContent).toMatch(/404/);
    const body = screen.getByTestId('case-log-response-B.2');
    expect(body.textContent).toContain('"error"');
    expect(body.textContent).toContain('"not_found"');
  });

  it('does not render a green "passed" indicator for failed cases', () => {
    render(
      <CaseRow
        case={mk({
          id: 'C.3',
          outcome: 'failed',
          responseStatus: 500,
        })}
      />,
    );
    const row = screen.getByTestId('case-row-C.3');
    // The status span's class must include "failed" and not "passed".
    const statusSpan = row.querySelector('.status');
    expect(statusSpan?.className).toContain('failed');
    expect(statusSpan?.className).not.toContain('passed');
  });

  it('renders a pending row distinctly from a passed row', () => {
    const { rerender } = render(<CaseRow case={mk({ id: 'D.4', outcome: 'pending' })} />);
    const pending = screen.getByTestId('case-row-D.4').querySelector('.status');
    expect(pending?.className).toContain('pending');
    rerender(<CaseRow case={mk({ id: 'D.4', outcome: 'passed' })} />);
    const passed = screen.getByTestId('case-row-D.4').querySelector('.status');
    expect(passed?.className).toContain('passed');
  });

  it('shows a per-case log on a passing case (MAS-302) and an evidence link when runId is set', () => {
    render(
      <CaseRow
        case={mk({
          id: 'E.5',
          outcome: 'passed',
          responseStatus: 200,
          responseBody: { ok: true },
        })}
        runId="r-1"
      />,
    );
    expect(screen.getByTestId('case-log-E.5')).toBeInTheDocument();
    expect(screen.getByTestId('case-log-summary-E.5').textContent).toMatch(/200/);
    const link = screen.getByTestId('case-evidence-E.5') as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toContain('/api/runs/r-1/evidence/E.5');
    expect(link.getAttribute('download')).toBe('evidence-r-1-E.5.log');
  });

  it('hides the evidence link when runId is omitted', () => {
    render(
      <CaseRow
        case={mk({ id: 'F.6', outcome: 'passed', responseStatus: 200 })}
      />,
    );
    expect(screen.queryByTestId('case-evidence-F.6')).toBeNull();
  });

  it('does not show a log block on a pending case', () => {
    render(<CaseRow case={mk({ id: 'G.7', outcome: 'pending' })} />);
    expect(screen.queryByTestId('case-log-G.7')).toBeNull();
  });

  // MAS-306 follow-up: when a case row carries a structured `evidence`
  // object (request + response), the inline "Run log" renders the
  // request line above the response body. This is the user-visible
  // fix for MAS-303 ("Evidence show the test case id not the result
  // of testing"): the operator can now see the actual HTTP
  // transaction the engine executed, instead of the
  // `{"mock": true, "id": "..."}` placeholder.
  it('renders the request line and response body from structured evidence (MAS-306 follow-up)', () => {
    render(
      <CaseRow
        case={mk({
          id: 'H.8',
          outcome: 'passed',
          responseStatus: 200,
          responseBody: { mock: true, id: 'H.8' },
          evidence: {
            request: { method: 'GET', url: 'https://issuer.example/case/H.8' },
            response: { status: 200, body: { ok: true } },
          },
        })}
      />,
    );
    expect(screen.getByTestId('case-log-H.8')).toBeInTheDocument();
    const request = screen.getByTestId('case-log-request-H.8');
    expect(request.textContent).toMatch(/GET/);
    expect(request.textContent).toMatch(/https:\/\/issuer\.example\/case\/H\.8/);
    const response = screen.getByTestId('case-log-response-H.8');
    expect(response.textContent).toContain('"ok"');
    expect(response.textContent).toContain('true');
  });

  it('shows an "in-process mock" badge on the request line when evidence.mock is true (MAS-306 follow-up)', () => {
    render(
      <CaseRow
        case={mk({
          id: 'I.9',
          outcome: 'passed',
          responseStatus: 200,
          responseBody: { mock: true, id: 'I.9' },
          evidence: {
            request: { method: 'GET', url: '<in-process-mock> /case/I.9' },
            response: { status: 200, body: { mock: true, id: 'I.9' } },
            mock: true,
          },
        })}
      />,
    );
    const badge = screen.getByTestId('case-log-mock-I.9');
    expect(badge.textContent).toMatch(/in-process mock/);
    const request = screen.getByTestId('case-log-request-I.9');
    expect(request.textContent).toMatch(/GET/);
    expect(request.textContent).toMatch(/<in-process-mock> \/case\/I\.9/);
  });
});
