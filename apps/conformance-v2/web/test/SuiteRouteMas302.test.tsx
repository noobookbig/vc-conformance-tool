/**
 * SuiteRoute — entity-driven endpoint form (MAS-302 v2.1).
 *
 * The v2.1 form has a single "Entity under test" radio group that
 * drives the endpoint field's label/placeholder/data-testid. The
 * standalone "verifier" textbox is gone — when the entity is
 * Verifier, the same field reads "Verifier endpoint" instead of a
 * separate labelled input. The wallet URL is shown for the cross-modes
 * ("Issuer with wallet", "Verifier with wallet") and is hidden when the
 * entity itself is Wallet (the entity URL is the wallet URL).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SuiteRoute } from '../src/routes/SuiteRoute';

function renderAt(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SuiteRoute />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', service: 'conformance-v2', version: '2.1.0' }),
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

describe('SuiteRoute — entity-driven endpoint form (MAS-302)', () => {
  it('defaults the entity to "issuer" and shows the issuer endpoint field', () => {
    renderAt();
    const issuer = screen.getByTestId('entity-radio-issuer') as HTMLLabelElement;
    expect(issuer.className).toContain('is-active');
    const label = screen.getByTestId('entity-endpoint-label');
    expect(label.textContent).toMatch(/Issuer endpoint/);
    const input = screen.getByTestId('input-entityUrl') as HTMLInputElement;
    expect(input.placeholder).toBe('https://issuer.example');
  });

  it('relabels the endpoint field to "Verifier endpoint" when the entity flips to verifier', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByTestId('entity-radio-input-verifier'));
    const label = screen.getByTestId('entity-endpoint-label');
    expect(label.textContent).toMatch(/Verifier endpoint/);
    const input = screen.getByTestId('input-entityUrl') as HTMLInputElement;
    expect(input.placeholder).toBe('https://verifier.example');
  });

  it('relabels the endpoint field to "Wallet endpoint" when the entity is wallet', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByTestId('entity-radio-input-wallet'));
    const label = screen.getByTestId('entity-endpoint-label');
    expect(label.textContent).toMatch(/Wallet endpoint/);
  });

  it('hides the standalone wallet URL field when the entity is wallet', async () => {
    const user = userEvent.setup();
    renderAt();
    // Issuer (default): wallet URL field is shown (cross-mode).
    expect(screen.getByTestId('input-wallet')).toBeInTheDocument();
    await user.click(screen.getByTestId('entity-radio-input-wallet'));
    // Wallet: wallet URL is the entity URL itself; no duplicate.
    expect(screen.queryByTestId('input-wallet')).toBeNull();
  });

  it('keeps the wallet URL field when the entity is issuer or verifier', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByTestId('entity-radio-input-issuer'));
    expect(screen.getByTestId('input-wallet')).toBeInTheDocument();
    await user.click(screen.getByTestId('entity-radio-input-verifier'));
    expect(screen.getByTestId('input-wallet')).toBeInTheDocument();
  });

  it('does not render a standalone "Target verifier base URL" field anywhere (MAS-302: no verifier textbox)', () => {
    renderAt();
    expect(screen.queryByLabelText(/Target verifier base URL/)).toBeNull();
    expect(screen.queryByLabelText(/Target issuer base URL/)).toBeNull();
  });

  it('shows the entity mode caption ("Issuer with wallet" / "Verifier with wallet" / "Wallet alone")', async () => {
    const user = userEvent.setup();
    renderAt();
    const caption = screen.getByTestId('entity-mode-label');
    expect(caption.textContent).toMatch(/Issuer/);
    await user.type(screen.getByTestId('input-wallet'), 'https://w.example');
    expect(screen.getByTestId('entity-mode-label').textContent).toMatch(/with wallet/);
    await user.click(screen.getByTestId('entity-radio-input-wallet'));
    expect(screen.getByTestId('entity-mode-label').textContent).toMatch(/Wallet alone/);
  });

  it('still shows the server status panel with the v2.1 version from /api/health', async () => {
    renderAt();
    // Wait for the health effect to resolve (useEffect → api.health()).
    expect(await screen.findByText(/conformance-v2/)).toBeInTheDocument();
    expect(screen.getByText(/v2\.1\.0/)).toBeInTheDocument();
  });
});
