/**
 * Regression coverage for MAS-223: the right-side test results panel
 * (`.run-side`) used to overflow its frame at common viewport widths
 * (~880-1280px) and force a horizontal page scroll. The root cause was
 * a combination of:
 *   1. `.kpis` using a fixed 5-column `1fr` grid where each tile was
 *      narrower than the KPI value/label needed, so the grid items'
 *      default `min-width: auto` blew the column out past its track.
 *   2. The results table (`.results-table`) using `white-space: nowrap`
 *      on the test ID cell, which forced the table wider than its
 *      `.run-side` parent when the test ID was long.
 *   3. No `min-width: 0` on any of the grid children, so the page-level
 *      `.layout` grid had no way to absorb a wide child.
 *   4. The history row and catalog row kept a 6-col / 4-col layout down
 *      to 760px, which was tight enough to push the rows past the
 *      content area in the tablet range.
 *
 * The fix is in `apps/web/public/styles.css` and `apps/web/public/app.js`.
 * This test pins the structural decisions so a future refactor doesn't
 * silently re-introduce the bug.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('MAS-223 responsive right panel', () => {
  it('caps the page itself so it never horizontal-scrolls', () => {
    // Safety net: even if a future grid child forgets `min-width: 0`,
    // the page itself should not horizontal-scroll.
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*clip/);
  });

  it('lets the content / layout grid absorb wide children', () => {
    // The four grid items that own the right panel + form layout must
    // all set `min-width: 0` so the parent grid track can shrink below
    // the child's intrinsic min-size.
    expect(css).toMatch(/\.content\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.run-panel\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.run-form\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.run-side\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.run-form label\s*\{[^}]*min-width:\s*0/);
  });

  it('flows the 5 KPI tiles across 2-5 columns depending on width', () => {
    // The original `repeat(5, 1fr)` was the prime culprit. The fix is
    // an `auto-fit` minmax so tiles can collapse to 2/3/4/5 columns
    // depending on available space, and a phone-only override that
    // caps at 2 columns for readability.
    expect(css).toMatch(/\.kpis\s*\{[^}]*repeat\(auto-fit,\s*minmax\(78px,\s*1fr\)\)/);
    expect(css).toMatch(/@media \(max-width:\s*480px\)\s*\{[\s\S]*\.kpis\s*\{[\s\S]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('wraps test ID and name cells instead of forcing the table wider', () => {
    // The previous `white-space: nowrap` on `.results-table .id`
    // forced the table to be at least as wide as the longest
    // monospaced test ID, which broke the parent grid.
    expect(css).not.toMatch(/\.results-table \.id\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.results-table \.id\s*\{[^}]*(?:word-break|overflow-wrap)/);
    expect(css).toMatch(/\.results-table \.name\s*\{[^}]*overflow-wrap/);
  });

  it('uses a fixed table layout with explicit column widths', () => {
    // `table-layout: fixed` + colgroup with explicit widths is the
    // deterministic way to make the table fit the parent panel
    // regardless of cell content.
    expect(css).toMatch(/\.results-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(css).toMatch(/\.results-table col\.col-id[^}]*width:\s*8\.5rem/);
    expect(css).toMatch(/\.results-table col\.col-status[^}]*width:\s*2\.2rem/);
    expect(css).toMatch(/\.results-table col\.col-dur[^}]*width:\s*4\.5rem/);
  });

  it('wraps the table in an internal-scroll container so the page never grows', () => {
    expect(css).toMatch(/\.results-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(appJs).toMatch(/class="results-table-wrap"/);
    // The colgroup must be present in BOTH render paths.
    expect(appJs).toMatch(/colgroup[\s\S]*col-status[\s\S]*col-id[\s\S]*col-name[\s\S]*col-dur/);
  });

  it('collapses history + catalog rows to fewer columns at tablet widths', () => {
    // The 760px breakpoint was too tight for the 6-col history row in
    // the 760-1100px range. Bumping to 960px keeps the layout
    // readable on tablets.
    expect(css).toMatch(/@media \(max-width:\s*960px\)\s*\{[\s\S]*\.history-row\s*\{[\s\S]*grid-template-columns:\s*1fr\s*1fr/);
    expect(css).toMatch(/@media \(max-width:\s*960px\)\s*\{[\s\S]*\.catalog-row\s*\{[\s\S]*grid-template-columns:\s*0\.5fr\s*1fr\s*0\.4fr/);
  });

  it('lets history/catalog cells truncate instead of pushing the row wider', () => {
    expect(css).toMatch(/\.history-row \.id\s*\{[^}]*(?:text-overflow:\s*ellipsis|min-width:\s*0)/);
    expect(css).toMatch(/\.catalog-row \.id\s*\{[^}]*(?:text-overflow:\s*ellipsis|min-width:\s*0)/);
  });

  it('keeps the kpi tile slim-able via min-width: 0', () => {
    expect(css).toMatch(/\.kpi\s*\{[^}]*min-width:\s*0/);
  });
});
