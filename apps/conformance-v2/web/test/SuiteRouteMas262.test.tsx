/**
 * MAS-262 — stronger visual cue when "Use in-process mock" is the
 * default-on toggle.
 *
 * The mock toggle is the one materially meaningful choice in the
 * SuiteRoute form. A first-time user must not miss the fact that the
 * default run is against a mock. The two disabled v2-invariants
 * (Stop on error, Continue on error) should visually recede.
 *
 * These tests live in their own file so the parallel MAS-260/261/263
 * work on SuiteRoute.test.tsx doesn't clobber them in the worktree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('SuiteRoute — MAS-262 visual cue for the default-on mock toggle', () => {
  it('shows a mock badge next to the useMock label and a callout under the toggle row when useMock is on', () => {
    renderAt();
    const badge = screen.getByTestId('mock-badge');
    expect(badge.textContent).toMatch(/mock/);
    const callout = screen.getByTestId('mock-callout');
    expect(callout.textContent).toMatch(/Demo data only/);
    expect(callout.textContent).toMatch(/uncheck for a real target run/);
  });

  it('hides the mock badge and callout when the user unchecks useMock', async () => {
    const user = userEvent.setup();
    renderAt();
    expect(screen.getByTestId('mock-badge')).toBeInTheDocument();
    await user.click(screen.getByTestId('toggle-usemock'));
    expect(screen.queryByTestId('mock-badge')).toBeNull();
    expect(screen.queryByTestId('mock-callout')).toBeNull();
  });

  it('marks the useMock toggle as the primary choice and the v2-invariant toggles as visually inactive', () => {
    renderAt();
    const stopLabel = screen.getByTestId('toggle-stopOnError').closest('label');
    const contLabel = screen.getByTestId('toggle-continueOnError').closest('label');
    expect(stopLabel?.className).toMatch(/toggle-inactive/);
    expect(contLabel?.className).toMatch(/toggle-inactive/);
    const mockLabel = screen.getByTestId('toggle-usemock').closest('label');
    expect(mockLabel?.className).toMatch(/toggle-primary/);
  });
});
