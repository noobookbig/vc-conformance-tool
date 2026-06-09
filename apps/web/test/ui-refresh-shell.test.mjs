/**
 * Regression coverage for MAS-189: the approved UI refresh lives in the
 * static SPA shell, so we pin the structural and accessibility affordances
 * that QA relies on without snapshotting the full HTML/CSS.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('MAS-189 UI refresh shell', () => {
  it('ships the five refreshed primary views and cross-mode cards', () => {
    expect(html).toContain('data-view="run"');
    expect(html).toContain('data-view="config"');
    expect(html).toContain('data-view="history"');
    expect(html).toContain('data-view="catalog"');
    expect(html).toContain('data-view="about"');

    expect(html).toContain('data-mode="I->W"');
    expect(html).toContain('data-mode="V->W"');
    expect(html).toContain('data-mode="W->I"');
    expect(html).toContain('data-mode="W->V"');
    expect(html).toContain('Run conformance');
  });

  it('includes the approved typography stack and accessibility hooks', () => {
    expect(html).toContain('IBM+Plex+Sans+Thai');
    expect(html).toContain('JetBrains+Mono');
    expect(html).toContain('Fraunces');
    expect(html).toContain('Skip to main content');
    expect(html).toContain('id="health-pill"');
    expect(html).toContain('aria-live="polite"');
  });

  it('keeps the design-token palette and reduced-motion fallback in CSS', () => {
    expect(css).toContain('--bg: #f3ecdc;');
    expect(css).toContain('--teal: #0a6464;');
    expect(css).toContain('--gold: #a8761e;');
    expect(css).toContain("--sans: 'IBM Plex Sans Thai'");
    expect(css).toContain("--serif: 'Fraunces'");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
