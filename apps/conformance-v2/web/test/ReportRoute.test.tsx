/**
 * ReportRoute — filters and downloads.
 *
 * The download links must point at the same URLs the server exposes
 * (and the CLI writes), so a UI-side filter or render error does not
 * diverge from the canonical report files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ReportRoute } from '../src/routes/ReportRoute';
import type { Report } from '../src/lib/types';

const SAMPLE: Report = {
  runId: 'r-abc',
  startedAt: '2026-06-10T00:00:00.000Z',
  finishedAt: '2026-06-10T00:00:05.000Z',
  durationMs: 5000,
  target: { targetIssuer: 'https://issuer.example' },
  results: [
    {
      id: 'A.1',
      name: 'Auth happy path',
      operation: 'auth',
      passed: true,
      skipped: false,
      responseStatus: 200,
      durationMs: 12,
    },
    {
      id: 'A.2',
      name: 'Auth failure path',
      operation: 'auth',
      passed: false,
      skipped: false,
      message: 'expected 200, got 400',
      responseStatus: 400,
      durationMs: 4,
    },
    {
      id: 'B.1',
      name: 'Presentation flow',
      operation: 'presentation',
      passed: true,
      skipped: false,
      responseStatus: 200,
      durationMs: 7,
    },
    {
      id: 'C.1',
      name: 'Skipped case',
      operation: 'token',
      passed: false,
      skipped: true,
      message: 'requires wallet',
      durationMs: 0,
    },
  ],
  summary: { total: 4, passed: 2, failed: 1, skipped: 1 },
  aborted: false,
  abortedAt: null,
};

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/runs/:id/report" element={<ReportRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/report?format=json')) {
        return new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReportRoute', () => {
  it('loads the report and shows summary chips', async () => {
    renderAt('/runs/r-abc/report');
    await waitFor(() => {
      expect(screen.getByTestId('summary-chips').textContent).toMatch(/2 passed/);
    });
    expect(screen.getByTestId('summary-chips').textContent).toMatch(/1 failed/);
    expect(screen.getByTestId('summary-chips').textContent).toMatch(/1 skipped/);
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    renderAt('/runs/r-abc/report');
    await waitFor(() => screen.getByTestId('case-list'));
    await user.selectOptions(screen.getByTestId('filter-status'), 'failed');
    const rows = screen.getAllByTestId(/^case-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-testid', 'case-row-A.2');
  });

  it('filters by free-text id/operation', async () => {
    const user = userEvent.setup();
    renderAt('/runs/r-abc/report');
    await waitFor(() => screen.getByTestId('case-list'));
    await user.type(screen.getByTestId('filter-q'), 'B.1');
    const rows = screen.getAllByTestId(/^case-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-testid', 'case-row-B.1');
  });

  it('shows an empty state when no cases match', async () => {
    const user = userEvent.setup();
    renderAt('/runs/r-abc/report');
    await waitFor(() => screen.getByTestId('case-list'));
    await user.type(screen.getByTestId('filter-q'), 'nonexistent');
    expect(screen.getByTestId('empty-filter')).toBeInTheDocument();
  });

  it('exposes Download JSON / JUnit / HTML links to the canonical report URLs', async () => {
    renderAt('/runs/r-abc/report');
    await waitFor(() => screen.getByTestId('downloads'));
    const json = screen.getByTestId('download-json') as HTMLAnchorElement;
    const junit = screen.getByTestId('download-junit') as HTMLAnchorElement;
    const html = screen.getByTestId('download-html') as HTMLAnchorElement;
    expect(json.href).toMatch(/\/api\/runs\/r-abc\/report\?format=json$/);
    expect(junit.href).toMatch(/\/api\/runs\/r-abc\/report\?format=junit$/);
    expect(html.href).toMatch(/\/api\/runs\/r-abc\/report\?format=html$/);
  });
});
