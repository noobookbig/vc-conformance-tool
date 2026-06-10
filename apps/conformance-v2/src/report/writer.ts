/**
 * report writers — emit `report.json`, `report.junit.xml`, `report.html`
 * for a v2 engine `Report`. Pure functions: no IO, no side effects.
 * The CLI is responsible for `mkdir -p` and `fs.writeFile`.
 *
 * Formats are intentionally simple:
 *   - JSON: full report object, machine-readable, what `report.json` is.
 *   - JUnit XML: standard CI format. One `<testsuite>` with `<testcase>`
 *     rows. Failures become `<failure>` elements with the message +
 *     response body. CI tools (Jenkins, GitHub Actions, GitLab) pick
 *     this up with no extra config.
 *   - HTML: a self-contained single-file report with no JS deps.
 *     The runner writes it as `report.html` so an operator can open
 *     it locally after a run.
 */

import type { Report } from '../runner.js';

export function toReportJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated, ${s.length - max} more chars)`;
}

export function toJunitXml(report: Report): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  const abortSuffix = report.aborted ? ` (halted at ${report.abortedAt})` : '';
  lines.push(
    `<testsuite name="conformance-v2" tests="${report.summary.passed + report.summary.failed + report.summary.skipped}" ` +
      `failures="${report.summary.failed}" skipped="${report.summary.skipped}" ` +
      `time="${(report.durationMs / 1000).toFixed(3)}" ` +
      `timestamp="${escapeXml(report.startedAt)}">`
  );
  for (const r of report.results) {
    const classname = `conformance-v2.${r.operation.replace(/[^A-Za-z0-9]+/g, '.')}`;
    const name = `${r.id} ${r.name}`;
    const time = (r.durationMs / 1000).toFixed(3);
    lines.push(`  <testcase classname="${escapeXml(classname)}" name="${escapeXml(name)}" time="${time}">`);
    if (r.passed) {
      // no inner element on pass
    } else if (r.skipped) {
      lines.push(`    <skipped message="${escapeXml(r.message ?? 'skipped')}"/>`);
    } else {
      const body = r.responseBody !== undefined ? JSON.stringify(r.responseBody, null, 2) : '';
      const msg = r.message ?? 'assertion mismatch';
      const bodySection = body ? `\nResponse body:\n${truncate(body, 2000)}` : '';
      const statusSection = r.responseStatus !== undefined ? `\nResponse status: ${r.responseStatus}` : '';
      lines.push(
        `    <failure message="${escapeXml(msg)}" type="assertion">${escapeXml(msg + statusSection + bodySection)}</failure>`
      );
    }
    lines.push('  </testcase>');
  }
  if (report.aborted) {
    lines.push(
      `  <error message="run aborted at ${escapeXml(report.abortedAt ?? '?')}"/>` +
        abortSuffix
    );
  }
  lines.push('</testsuite>');
  return lines.join('\n');
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(passed: boolean, skipped: boolean): string {
  if (skipped) return '<span class="badge skipped">SKIPPED</span>';
  if (passed) return '<span class="badge pass">PASS</span>';
  return '<span class="badge fail">FAIL</span>';
}

export function toReportHtml(report: Report): string {
  const css = `
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b0f14; color: #e6e6e6; }
    h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
    .sub { color: #9aa4ad; font-size: .9rem; margin-bottom: 1.5rem; }
    .kpis { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .kpi { background: #131a22; border: 1px solid #1f2731; border-radius: 6px; padding: .75rem 1rem; min-width: 100px; }
    .kpi .n { font-size: 1.6rem; font-weight: 600; line-height: 1; }
    .kpi .l { color: #9aa4ad; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
    .aborted { background: #2a0e10; border: 1px solid #5a1a1f; color: #ffb3b3; padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #1f2731; vertical-align: top; }
    th { color: #9aa4ad; font-weight: 500; text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; }
    tr.fail td { background: rgba(255, 80, 80, 0.06); }
    tr.pass td { background: rgba(0, 212, 200, 0.03); }
    tr.skipped td { background: rgba(154, 164, 173, 0.05); }
    .id { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; font-size: .85rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .7rem; font-weight: 600; letter-spacing: .04em; }
    .badge.pass { background: #00d4c8; color: #0b0f14; }
    .badge.fail { background: #ff5a5f; color: #fff; }
    .badge.skipped { background: #4a5562; color: #e6e6e6; }
    details { margin-top: .25rem; }
    pre { background: #060a0e; padding: .75rem; border-radius: 4px; overflow: auto; max-height: 300px; font-size: .8rem; }
  `.trim();
  const abortBanner = report.aborted
    ? `<div class="aborted"><strong>Run halted at:</strong> <span class="id">${escHtml(report.abortedAt ?? '?')}</span>${report.error ? ` — ${escHtml(report.error)}` : ''}</div>`
    : '';
  const rows = report.results
    .map((r: Report['results'][number]) => {
      const cls = r.passed ? 'pass' : r.skipped ? 'skipped' : 'fail';
      const detail = !r.passed && !r.skipped
        ? `<details><summary>failure detail</summary><pre>${escHtml(
            (r.message ?? '') +
              (r.responseStatus !== undefined ? `\nstatus: ${r.responseStatus}` : '') +
              (r.responseBody !== undefined ? `\nbody: ${JSON.stringify(r.responseBody, null, 2)}` : '')
          )}</pre></details>`
        : '';
      return `<tr class="${cls}"><td>${statusBadge(r.passed, r.skipped)}</td><td class="id">${escHtml(r.id)}</td><td>${escHtml(r.name)}</td><td>${escHtml(r.operation)}</td><td>${r.durationMs}ms</td><td>${detail}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Conformance v2 Report — ${escHtml(report.runId)}</title>
  <style>${css}</style>
</head>
<body>
  <h1>Conformance v2 Report</h1>
  <div class="sub">run <span class="id">${escHtml(report.runId)}</span> · ${escHtml(report.startedAt)} → ${escHtml(report.finishedAt)} · ${report.durationMs}ms</div>
  <div class="kpis">
    <div class="kpi"><div class="n">${report.summary.total}</div><div class="l">total</div></div>
    <div class="kpi"><div class="n">${report.summary.passed}</div><div class="l">passed</div></div>
    <div class="kpi"><div class="n">${report.summary.failed}</div><div class="l">failed</div></div>
    <div class="kpi"><div class="n">${report.summary.skipped}</div><div class="l">skipped</div></div>
  </div>
  ${abortBanner}
  <table>
    <thead><tr><th>Status</th><th>ID</th><th>Name</th><th>Operation</th><th>Duration</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
