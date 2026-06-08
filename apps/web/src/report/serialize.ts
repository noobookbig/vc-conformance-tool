/**
 * Report serializers: JSON (machine-readable) + HTML (human-readable).
 *
 * The HTML is intentionally framework-free — pure HTML + a tiny bit of inline
 * CSS so the user can save the report and view it offline.
 */

import type { Report } from '../runners/runner.js';

export function toJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

export const renderJsonReport = toJson;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toHtml(report: Report): string {
  const rows = report.results
    .map((r) => `
    <tr class="${r.pass ? 'pass' : 'fail'}">
      <td class="id">${esc(r.id)}</td>
      <td>${esc(r.name)}</td>
      <td class="status">${r.pass ? 'PASS' : 'FAIL'}</td>
      <td class="dur">${r.durationMs} ms</td>
      <td class="msg">${esc(r.message)}</td>
    </tr>`)
    .join('');

  const summary = report.summary;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Conformance report ${esc(report.runId)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #fafafa; color: #111; }
  header { background: #0f172a; color: #fff; padding: 24px 32px; }
  header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 12px; opacity: 0.7; }
  main { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .card.pass .value { color: #047857; }
  .card.fail .value { color: #b91c1c; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  th { background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; font-weight: 600; }
  tr.pass td.status { color: #047857; font-weight: 600; }
  tr.fail td.status { color: #b91c1c; font-weight: 600; }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.msg { font-size: 12px; color: #475569; }
  td.dur { font-variant-numeric: tabular-nums; color: #6b7280; font-size: 12px; }
  .bar { height: 4px; background: linear-gradient(90deg, #10b981 var(--p, 0%), #e5e7eb var(--p, 0%)); border-radius: 2px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>Conformance report — ${esc(report.mode)}</h1>
  <div class="meta">
    <div>Run ID: <code>${esc(report.runId)}</code></div>
    <div>Target issuer: <code>${esc(report.target.issuer ?? '(mock)')}</code></div>
    <div>Target verifier: <code>${esc(report.target.verifier ?? '(mock)')}</code></div>
    <div>Credential config: <code>${esc(report.target.credentialConfigurationId)}</code></div>
    <div>Started: ${esc(report.startedAt)} · Finished: ${esc(report.finishedAt)} · Duration: ${report.durationMs} ms</div>
  </div>
</header>
<main>
  <section class="summary">
    <div class="card"><div class="label">Total</div><div class="value">${summary.total}</div></div>
    <div class="card pass"><div class="label">Passed</div><div class="value">${summary.passed}</div></div>
    <div class="card fail"><div class="label">Failed</div><div class="value">${summary.failed}</div></div>
    <div class="card"><div class="label">Pass rate</div><div class="value">${(summary.passRate * 100).toFixed(1)}%</div><div class="bar" style="--p: ${(summary.passRate * 100).toFixed(1)}%"></div></div>
    <div class="card"><div class="label">Mode</div><div class="value">${esc(report.mode)}</div></div>
  </section>
  <table>
    <thead>
      <tr><th>Test ID</th><th>Name</th><th>Status</th><th>Duration</th><th>Message</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</main>
</body>
</html>`;
}

export const renderHtmlReport = toHtml;
