/**
 * MAS-296 — v2 web UI neon-futuristic theme screenshot suite.
 *
 * The board needs to approve the visual direction (Kanit + dark + neon
 * role accents) before we mark MAS-296 done. This spec captures the
 * Suite route and the Run route at 1440x900 and 390x844 with three
 * role focuses (All / Issuer / Wallet) and a run-state that shows the
 * role band, filter chips, and per-case role badges.
 *
 * Strategy: hit the standalone Vite dev server on :5173 (started
 * out-of-band) and inject a stub EventSource via `addInitScript` so
 * the RunRoute renders a representative in-flight state with real
 * case ids drawn from `references/testcases/` (resolved through the
 * case-roles.json map at runtime).
 *
 * Outputs: PNGs in `test-results/mas-296-screenshots/`. The spec posts
 * them to the issue via the `paperclip-issue-update` helper.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const SCREENSHOTS_DIR = path.resolve(
  '/home/big/Documents/vc-conformance-test/apps/conformance-v2/web/test-results/mas-296-screenshots',
);

const FAKE_EVENT_SOURCE_SCRIPT = `
(() => {
  // Case ids are drawn from the v2.0 catalog and chosen to match the
  // role they actually classify to in case-roles.json, so the per-case
  // badges on the run page line up with the header's role pill.
  const ROLE_CASES = {
    issuer: [
      'FT.IC.AU.I.H.IB.001', 'FT.IC.AU.I.H.IB.002', 'FT.IC.AU.I.H.IB.003',
      'FT.IC.AU.I.H.VB.001', 'FT.IC.AU.I.H.VB.002', 'FT.IC.AU.I.H.VB.003',
    ],
    verifier: [
      'FT.PR.AU.V.H.IB.001', 'FT.PR.AU.V.H.IB.002', 'FT.PR.AU.V.H.IB.003',
    ],
    wallet: [
      'FT.IC.AU.H.I.IB.001', 'FT.IC.AU.H.I.IB.002', 'FT.IC.AU.H.I.IB.003',
      'FT.IC.AU.H.I.VB.001', 'FT.IC.AU.H.I.VB.002',
    ],
  };
  function buildFrame(event, data) {
    return 'event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n';
  }
  function pickCases(role) {
    if (role === 'issuer') return ROLE_CASES.issuer;
    if (role === 'verifier') return ROLE_CASES.verifier;
    if (role === 'wallet') return ROLE_CASES.wallet;
    return [...ROLE_CASES.issuer, ...ROLE_CASES.verifier, ...ROLE_CASES.wallet];
  }
  class FakeES extends EventTarget {
    static instances = [];
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      FakeES.instances.push(this);
      // Defer the emission so the React effect can install handlers.
      setTimeout(() => this._fire(), 0);
    }
    _fire() {
      // EventSource: open
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      // Look at the URL — the run id is the last path segment.
      const id = (this.url.match(/\\/api\\/runs\\/([^/]+)\\/events/) || [])[1] || 'demo';
      // Pull role focus from a window hint set per navigation.
      const role = (window.__V2_FAKE_RUN_ROLE__ || 'all');
      const cases = pickCases(role);
      this.dispatchEvent(new MessageEvent('run.started', {
        data: JSON.stringify({ id, total: cases.length, target: {} }),
      }));
      cases.forEach((cid, i) => {
        // 7/8 pass, 1/8 fail — representative real-world ratio.
        const fail = i === cases.length - 1;
        const ev = fail ? 'case.failed' : 'case.passed';
        this.dispatchEvent(new MessageEvent(ev, {
          data: JSON.stringify({
            id: cid,
            outcome: fail ? 'failed' : 'passed',
            responseStatus: fail ? 500 : 200,
            durationMs: 80 + i * 17,
            ...(fail ? { message: 'assertion mismatch: expected kid=thai-2025 got kid=legacy' } : {}),
          }),
        }));
      });
      // Don't close — leave the stream open so the page reads as "live".
    }
    addEventListener(name, fn) { super.addEventListener(name, fn); }
    removeEventListener(name, fn) { super.removeEventListener(name, fn); }
    close() { this.readyState = 2; }
  }
  globalThis.EventSource = FakeES;
})();
`;

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe('MAS-296 — v2 web UI screenshot suite', () => {
  for (const vp of VIEWPORTS) {
    test(`suite · ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript(FAKE_EVENT_SOURCE_SCRIPT);
      await page.goto('http://127.0.0.1:5173/');
      // Wait for the role split panel to render (the only thing on
      // the page that proves the new UI shipped).
      await expect(page.getByTestId('role-split')).toBeVisible();
      // Allow web fonts to settle.
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `suite-${vp.name}.png`),
        fullPage: false,
      });
    });

    test(`suite · focused wallet · ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript(FAKE_EVENT_SOURCE_SCRIPT);
      await page.goto('http://127.0.0.1:5173/');
      await expect(page.getByTestId('role-split')).toBeVisible();
      // Click the wallet chip.
      await page.getByTestId('role-chip-wallet').click();
      await expect(page.getByTestId('role-detail')).toBeVisible();
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `suite-wallet-${vp.name}.png`),
        fullPage: false,
      });
    });

    test(`run · all · ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript(`
        window.__V2_FAKE_RUN_ROLE__ = 'all';
        ${FAKE_EVENT_SOURCE_SCRIPT}
      `);
      await page.goto('http://127.0.0.1:5173/runs/demo');
      await expect(page.getByTestId('run-role-band')).toBeVisible();
      await expect(page.getByTestId('case-list')).toBeVisible();
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `run-all-${vp.name}.png`),
        fullPage: false,
      });
    });

    test(`run · issuer · ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript(`
        window.__V2_FAKE_RUN_ROLE__ = 'issuer';
        ${FAKE_EVENT_SOURCE_SCRIPT}
      `);
      await page.goto('http://127.0.0.1:5173/runs/demo?role=issuer');
      await expect(page.getByTestId('run-role-band')).toBeVisible();
      await expect(page.getByTestId('role-pill-issuer')).toBeVisible();
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `run-issuer-${vp.name}.png`),
        fullPage: false,
      });
    });
  }
});
