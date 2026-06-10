/**
 * SuiteRoute — config form validates required fields; Run button disabled
 * when precheck fails (or no target set and mock is off).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SuiteRoute } from '../src/routes/SuiteRoute';

function renderAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SuiteRoute />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Stub the health probe so the test doesn't depend on the server.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', service: 'conformance-v2', version: '2.0.0' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SuiteRoute', () => {
  it('renders the form and defaults to useMock=true so a first-time user can run', async () => {
    renderAt();
    expect(screen.getByTestId('suite-form')).toBeInTheDocument();
    const mockToggle = screen.getByTestId('toggle-usemock') as HTMLInputElement;
    expect(mockToggle.checked).toBe(true);
  });

  it('disables the Run button when useMock is off and no target is set', async () => {
    const user = userEvent.setup();
    renderAt();
    const mockToggle = screen.getByTestId('toggle-usemock') as HTMLInputElement;
    await user.click(mockToggle); // turn mock off
    const runBtn = screen.getByTestId('btn-run') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
  });

  it('enables the Run button when useMock is on (the default)', () => {
    renderAt();
    const runBtn = screen.getByTestId('btn-run') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
  });

  it('runs the precheck and shows a precheck-failed pill on a bad URL', async () => {
    const user = userEvent.setup();
    // Override the stub: probe returns 500.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('example.invalid')) {
          return new Response('boom', { status: 500 });
        }
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    renderAt();
    // Turn off the in-process mock so the precheck actually probes the URL.
    await user.click(screen.getByTestId('toggle-usemock'));
    const urlInput = screen.getByTestId('input-issuerMetadataUrl');
    await user.type(urlInput, 'https://example.invalid/');
    await user.click(screen.getByTestId('btn-precheck'));

    await waitFor(() => {
      expect(screen.getByTestId('precheck-pill').textContent).toMatch(/Precheck failed/);
    });
    const runBtn = screen.getByTestId('btn-run') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
  });

  it('does not navigate when the run submit fails server-side', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.endsWith('/api/runs') && init?.method === 'POST') {
          return new Response(JSON.stringify({ error: 'invalid_config' }), { status: 400 });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    renderAt();
    await user.click(screen.getByTestId('btn-run'));
    // Should remain on the Suite route (no navigation away).
    await waitFor(() => {
      expect(screen.getByTestId('suite-error').textContent).toMatch(/400/);
    });
  });
});
