/**
 * Report serializers: JSON (machine-readable) + HTML (human-readable).
 *
 * The HTML is intentionally framework-free — pure HTML + a tiny bit of inline
 * CSS so the user can save the report and view it offline. The CSS is
 * theme-able via custom properties on `:root[data-theme]`; defaults to light,
 * with a dark variant toggled by the in-document button.
 */

import type { Report } from '../runners/runner.js';
import { summarize } from '../runners/runner.js';
import { evidenceToCurl } from './curl.js';

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

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d6e6e"/>
      <stop offset="1" stop-color="#d2a23c"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="url(#g)"/>
  <path d="M16 20h12a8 8 0 0 1 0 16h-4v8h-8z" fill="#fff" opacity="0.95"/>
  <circle cx="44" cy="44" r="6.4" fill="#fff" opacity="0.95"/>
  <path d="M22 22h6a4 4 0 0 1 0 8h-6z" fill="#0d6e6e"/>
</svg>`;

function rowFor(r: Report['results'][number]): string {
  const status = r.message.startsWith('SKIPPED') ? 'SKIP' : (r.pass ? 'PASS' : 'FAIL');
  const curl = !r.pass ? evidenceToCurl(r.evidence as Record<string, unknown> | undefined) : null;
  const copyBtn = curl
    ? `<button class="copy-curl" data-curl="${esc(curl)}" type="button" title="Copy curl for this test">⧉ copy curl</button>`
    : '';
  const ev = r.evidence ? `<details class="evidence"><summary>evidence</summary><pre>${esc(JSON.stringify(r.evidence, null, 2))}</pre></details>` : '';
  // MAS-219: surface the kind in the row so a reviewer can distinguish
  // "harness built a spec-shaped request" (COV) from "target accepted
  // the request" (LIVE). A small badge next to the test name is enough;
  // we keep the existing PASS/FAIL/SKIP status column for the verdict.
  const kindBadge = r.kind === 'live'
    ? '<span class="kind live" title="Live test: made a real HTTP call to the target">LIVE</span>'
    : '<span class="kind cov" title="Coverage test: client-side shape validator, did not contact the target">COV</span>';
  return `
    <tr class="${r.pass ? 'pass' : 'fail'}">
      <td class="id">${esc(r.id)}</td>
      <td>${esc(r.name)} ${kindBadge}<div class="msg">${esc(r.message)}${ev}</div></td>
      <td class="status">${status}${copyBtn}</td>
      <td class="dur">${r.durationMs} ms</td>
    </tr>`;
}

const SCRIPT = `
<script>
(function() {
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    return Promise.resolve();
  }
  document.querySelectorAll('button.copy-curl').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var t = btn.getAttribute('data-curl') || '';
      copyText(t).then(function() {
        var orig = btn.textContent;
        btn.textContent = '✓ copied';
        setTimeout(function() { btn.textContent = orig; }, 1500);
      });
    });
  });
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function() {
      var cur = document.documentElement.getAttribute('data-theme') || 'light';
      var next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      themeBtn.textContent = next === 'light' ? '☾ dark' : '☀ light';
    });
  }
})();
</script>`;

export function toHtml(report: Report): string {
  const rows = report.results.map(rowFor).join('');
  // MAS-174: a persisted or freshly-built report with no `summary` (e.g.
  // a partial on-disk shape from before summarize() was hardened) must
  // still produce a valid HTML report. We rebuild from `results` here
  // so the report is self-contained and the operator gets the full
  // picture. See `summarize()` in apps/web/src/runners/runner.ts for
  // the canonical implementation.
  const summary = report.summary ?? summarize(report.results);
  const passPct = ((summary.passRate ?? 0) * 100).toFixed(1);
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conformance report — ${esc(report.runId)}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #faf7ee;
    --bg-2: #f0ead8;
    --surface: #ffffff;
    --ink: #181715;
    --ink-2: #4a453e;
    --ink-3: #8b8478;
    --line: #e3dcc6;
    --line-2: #c9bea7;
    --teal: #0d6e6e;
    --teal-2: #0a5959;
    --gold: #b8872c;
    --green: #047857;
    --rose: #b91c1c;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #16140f;
    --bg-2: #1d1a14;
    --surface: #211d16;
    --ink: #f3ecda;
    --ink-2: #b9b0a0;
    --ink-3: #807868;
    --line: #2c2820;
    --line-2: #3a3528;
    --teal: #2bbab9;
    --teal-2: #1d8a89;
    --gold: #e2b955;
    --green: #6dba79;
    --rose: #e07a7a;
  }
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
  header { background: var(--surface); border-bottom: 1px solid var(--line); padding: 18px 28px; display: flex; align-items: center; gap: 18px; }
  header .logo { width: 44px; height: 44px; border-radius: 10px; box-shadow: 0 0 0 1px var(--line-2); overflow: hidden; }
  header h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  header .meta { font-size: 12px; color: var(--ink-2); margin-top: 2px; font-family: var(--mono); }
  header .actions { margin-left: auto; display: flex; gap: 8px; }
  header button, .copy-curl { font: inherit; font-size: 12px; background: transparent; color: var(--ink-2); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
  header button:hover, .copy-curl:hover { color: var(--ink); border-color: var(--teal); }
  main { padding: 20px 28px 40px; max-width: 1200px; margin: 0 auto; }
  .summary { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 18px; }
  @media (max-width: 720px) { .summary { grid-template-columns: repeat(2, 1fr); } }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); font-weight: 600; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; font-family: var(--mono); }
  .card.pass .value { color: var(--green); }
  .card.fail .value { color: var(--rose); }
  .card.cov .value { color: var(--teal); }
  /* MAS-219: per-test kind badge. Distinct enough that a reviewer
     scanning a row can tell at a glance which tests probed the
     network (LIVE) and which were spec-shape validators (COV). */
  .kind { display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; margin-left: 4px; vertical-align: 1px; }
  .kind.live { background: color-mix(in srgb, var(--green) 14%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 28%, transparent); }
  .kind.cov { background: color-mix(in srgb, var(--teal) 12%, transparent); color: var(--teal); border: 1px solid color-mix(in srgb, var(--teal) 24%, transparent); }
  .bar { height: 4px; background: linear-gradient(90deg, var(--green) var(--p, 0%), var(--line) var(--p, 0%)); border-radius: 2px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background: var(--bg-2); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-2); font-weight: 600; }
  tr.pass td.status { color: var(--green); font-weight: 600; }
  tr.fail td.status { color: var(--rose); font-weight: 600; }
  td.id { font-family: var(--mono); font-size: 12px; color: var(--teal); white-space: nowrap; }
  td .msg { font-size: 12px; color: var(--ink-2); margin-top: 4px; }
  td.dur { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; white-space: nowrap; }
  td.status { font-size: 12px; }
  .copy-curl { display: inline-block; margin-left: 8px; font-size: 11px; }
  details.evidence { margin-top: 6px; }
  details.evidence summary { cursor: pointer; color: var(--ink-3); font-size: 11px; }
  details.evidence pre { background: var(--bg); padding: 8px 10px; border-radius: 6px; margin: 4px 0 0; font-size: 11px; max-height: 12rem; overflow: auto; }
  footer { color: var(--ink-3); font-size: 11px; text-align: center; margin-top: 24px; }
</style>
</head>
<body>
  <header>
    <div class="logo">${LOGO_SVG}</div>
    <div>
      <h1>Conformance report — ${esc(report.mode)}</h1>
      <div class="meta">run <code>${esc(report.runId)}</code> · ${esc(report.startedAt)} · ${report.durationMs} ms</div>
    </div>
    <div class="actions">
      <button id="theme-toggle" type="button" title="Toggle theme">☾ dark</button>
    </div>
  </header>
  <main>
    <section class="summary">
      <div class="card"><div class="label">Total</div><div class="value">${summary.total}</div></div>
      <div class="card pass"><div class="label">Passed</div><div class="value">${summary.passed}</div></div>
      <div class="card fail"><div class="label">Failed</div><div class="value">${summary.failed}</div></div>
      <div class="card"><div class="label">Pass rate</div><div class="value">${passPct}%</div><div class="bar" style="--p: ${passPct}%"></div></div>
      <div class="card cov"><div class="label">Coverage</div><div class="value">${summary.coverage}</div></div>
      <div class="card"><div class="label">Mode</div><div class="value">${esc(report.mode)}</div></div>
    </section>
    <section class="meta-card" style="background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 12px; color: var(--ink-2);">
      <strong style="color: var(--ink)">Targets</strong> ·
      issuer <code>${esc(report.target.issuer ?? '(mock)')}</code> ·
      verifier <code>${esc(report.target.verifier ?? '(mock)')}</code> ·
      credential config <code>${esc(report.target.credentialConfigurationId)}</code>
    </section>${report.error ? `
    <section class="error-card" role="alert" style="background: color-mix(in srgb, var(--rose) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--rose) 30%, var(--line)); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; color: var(--rose);">
      <strong>Run aborted</strong>: ${esc(report.error)}
    </section>` : ''}
    <table>
      <thead>
        <tr><th>Test ID</th><th>Name</th><th>Status</th><th>Duration</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <footer>VC Conformance Test Webapp · ${esc(report.finishedAt)}</footer>
  </main>
  ${SCRIPT}
</body>
</html>`;
}

export const renderHtmlReport = toHtml;
