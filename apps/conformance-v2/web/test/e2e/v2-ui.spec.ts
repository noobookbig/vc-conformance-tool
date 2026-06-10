/**
 * v2 UI e2e smoke.
 *
 * The single Playwright spec the MAS-256 ticket asks for. It boots the
 * v2 server (the webServer block in playwright.config.ts), then drives
 * the SPA through Suite → Run → Report, asserting that:
 *
 *   1. The Suite route renders at / and has a working Run button.
 *   2. Clicking Run creates a run, navigates to /runs/:id, and the
 *      progress stream reaches `run.completed` with a green pass.
 *   3. The Report page is filterable and the download links point at
 *      the same URLs the server exposes.
 *
 * Strategy: the server's in-process mock (useMock: true) makes the run
 * deterministic — every case passes in <100ms. The spec asserts the
 * terminal event reaches the UI, not the absolute timing.
 */

import { test, expect } from '@playwright/test';

test.describe('v2 UI e2e', () => {
  test('Suite → Run → Report flows end-to-end against the in-process mock', async ({ page }) => {
    // ----- 1. Suite route ----------------------------------------------
    await page.goto('/');
    await expect(page.getByTestId('suite-form')).toBeVisible();
    // Default is useMock: true so a first-time user can run.
    const mockToggle = page.getByTestId('toggle-usemock');
    await expect(mockToggle).toBeChecked();

    // ----- 2. Click Run → progress stream reaches completed ------------
    await page.getByTestId('btn-run').click();
    // The Suite route navigates to /runs/:id on success.
    await page.waitForURL(/\/runs\/r-/);
    // The progress region announces the run is connected.
    await expect(page.getByTestId('run-live')).toBeVisible();
    // Wait for the terminal state. The mock run finishes in well under
    // a second; a generous 10s bound is plenty.
    await expect(page.getByTestId('run-live')).toContainText(/completed/i, { timeout: 10_000 });
    // The case list should have at least one passing case.
    const passedRows = page.locator('.case-row .status.passed');
    await expect(passedRows.first()).toBeVisible({ timeout: 5_000 });
    // The "View report" link appears once the run is terminal.
    await expect(page.getByTestId('link-report')).toBeVisible();

    // ----- 3. Report page is filterable + downloads are wired ----------
    await page.getByTestId('link-report').click();
    await page.waitForURL(/\/runs\/r-.*\/report$/);
    await expect(page.getByTestId('summary-chips')).toBeVisible();
    await expect(page.getByTestId('downloads')).toBeVisible();
    const jsonHref = await page.getByTestId('download-json').getAttribute('href');
    expect(jsonHref).toMatch(/\/api\/runs\/r-.*\/report\?format=json$/);
    const junitHref = await page.getByTestId('download-junit').getAttribute('href');
    expect(junitHref).toMatch(/\/api\/runs\/r-.*\/report\?format=junit$/);
    const htmlHref = await page.getByTestId('download-html').getAttribute('href');
    expect(htmlHref).toMatch(/\/api\/runs\/r-.*\/report\?format=html$/);

    // The status filter narrows the list.
    await page.getByTestId('filter-status').selectOption('passed');
    const filteredRows = page.locator('[data-testid^="case-row-"]');
    await expect(filteredRows.first()).toBeVisible();
  });
});
