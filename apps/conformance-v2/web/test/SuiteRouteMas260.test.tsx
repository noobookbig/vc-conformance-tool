/**
 * MAS-260 — precheck-failed pill must stay on a single line on long URLs.
 *
 * The original pill rendered the full reason inline (`Precheck failed:
 * <url> returned HTTP <status>`), which wrapped the rounded pill to a
 * second line on long URLs. The fix:
 *
 *  - the visible label is a fixed short string ("Precheck failed");
 *  - an icon (the `!` glyph) is shown next to the label so the failure
 *    is communicated by icon + colour + label;
 *  - the full reason (URL + status) is exposed via the `title` attribute
 *    on the pill for hover and assistive tech;
 *  - the CSS clamps the pill to a single line with `white-space:
 *    nowrap` and an ellipsis if anything still tries to grow it.
 *
 * These tests live in their own file so the parallel MAS-260/261/262/263
 * work on SuiteRoute.test.tsx does not clobber them in the worktree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('SuiteRoute — MAS-260 precheck-failed pill stays on one line', () => {
  it('renders a short "Precheck failed" label and exposes the full reason in the title attribute (icon + color + label)', async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByTestId('toggle-usemock'));
    await user.type(
      screen.getByTestId('input-issuerMetadataUrl'),
      'https://example.invalid/',
    );
    await user.click(screen.getByTestId('btn-precheck'));

    await waitFor(() => {
      expect(screen.getByTestId('precheck-pill').textContent).toMatch(/Precheck failed/);
    });
    const pill = screen.getByTestId('precheck-pill');
    // The visible label must be short — the full URL must NOT be in
    // the text content (that was the source of the wrap).
    expect(pill.textContent).not.toContain('https://example.invalid');
    // But it must be exposed via the title attribute for hover / AT.
    expect(pill.getAttribute('title')).toContain('https://example.invalid');
    expect(pill.getAttribute('title')).toContain('500');
    // Icon + colour + label — the pill carries the `bad` class for colour.
    expect(pill.className).toContain('bad');
    expect(pill.querySelector('.precheck-icon')).not.toBeNull();
    // Run button disabled while precheck is bad.
    expect((screen.getByTestId('btn-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the pill label short on deliberately long URLs (regression for the original wrap bug)', async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByTestId('toggle-usemock'));
    const longUrl =
      'https://example.invalid/' +
      'a-very-long-path-segment-that-pushes-the-pill-past-the-header-width/' +
      'and-then-some-more-so-the-pill-definitely-wraps/' +
      '?issuerMetadata=1&foo=bar&baz=qux&something=else';
    await user.type(screen.getByTestId('input-issuerMetadataUrl'), longUrl);
    await user.click(screen.getByTestId('btn-precheck'));

    await waitFor(() => {
      expect(screen.getByTestId('precheck-pill').textContent).toMatch(/Precheck failed/);
    });
    const pill = screen.getByTestId('precheck-pill');
    // The visible label is the short fixed string + icon, NOT the URL.
    expect(pill.textContent).not.toContain('https://example.invalid');
    expect(pill.textContent).not.toContain('a-very-long-path-segment');
    // The full reason is in the title attribute for hover / AT.
    expect(pill.getAttribute('title')).toContain(longUrl);
    expect(pill.getAttribute('title')).toContain('500');
  });
});
