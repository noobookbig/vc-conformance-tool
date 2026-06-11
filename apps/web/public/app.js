/**
 * SPA logic. No framework, no build step.
 * Communicates with the Fastify API at /api/*.
 */

import { readDiffFromSearch, buildHref } from './diff-url.js';
import { readLocalConfig, writeLocalConfig } from './local-config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Diff URL state (MAS-143). Module-scope so it survives view switches.
// `currentDiffReportId` powers the "back to report" affordance when the
// user lands on a diff deep-link that was originally opened from a report.
let currentDiffSelection = null; // { left, right, report } | null
let currentDiffReportId = null;

// ---------- API helpers ----------

const api = {
  async health() { return (await fetch('/api/health')).json(); },
  async modes() { return (await fetch('/api/modes')).json(); },
  async credentials() { return (await fetch('/api/credentials')).json(); },
  async config() { return (await fetch('/api/config')).json(); },
  async saveConfig(c) { return (await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })).json(); },
  async keys() { return (await fetch('/api/wallet/keys')).json(); },
  async regenKeys() { return (await fetch('/api/wallet/keys/regenerate', { method: 'POST' })).json(); },
  async startRun(body) { return (await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); },
  async runs() { return (await fetch('/api/runs')).json(); },
  async run(id) { return (await fetch(`/api/runs/${id}`)).json(); },
  async diff(rightId, leftId) {
    const r = await fetch(`/api/runs/${encodeURIComponent(rightId)}/diff?left=${encodeURIComponent(leftId)}`);
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch { /* non-json error body */ }
      const err = new Error(body?.message || `diff_failed_${r.status}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return r.json();
  },
  async catalog() { return (await fetch('/api/catalog')).json(); },
  // MAS-312.B: VP-via-QR submission. The endpoint reshapes the runner's
  // structured QrVpResult into its own JSON contract; we mirror the
  // shapes here so the UI can render both 2xx and 4xx/5xx outcomes
  // uniformly (the HTTP-level error envelope is { statusCode, error,
  // message } and the body-level success/failure is { ok, ... }).
  async validateQr(payload) {
    const r = await fetch('/api/qr/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'send-vp-request', payload }),
    });
    let body = null;
    try { body = await r.json(); } catch { /* non-json */ }
    return { ok: r.ok, status: r.status, body };
  },
  async sendQrVp(body) {
    const r = await fetch('/api/qr/send-vp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let resp = null;
    try { resp = await r.json(); } catch { /* non-json */ }
    return { ok: r.ok, status: r.status, body: resp };
  },
};

// ---------- View switching ----------

function showView(name) {
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') renderHistory();
  if (name === 'catalog') renderCatalog();
  if (name === 'config') renderConfig();
  if (name === 'qrvp') {
    // MAS-312.B: the QR panel has no async boot work but the camera
    // stream needs to be stopped when the user navigates away. We do
    // that here so a view switch cleans up getUserMedia handles even
    // if the user clicks a different nav button.
    stopQrCamera();
  }
}

// ---------- Toast ----------

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- Health ----------

async function checkHealth() {
  const pill = $('#health-pill');
  const text = $('#health-text');
  try {
    const h = await api.health();
    pill.classList.add('ok'); pill.classList.remove('bad');
    text.textContent = `online · v${h.version}`;
  } catch {
    pill.classList.add('bad'); pill.classList.remove('ok');
    text.textContent = 'offline';
  }
}

// ---------- Run view ----------

let currentMode = 'W->I';
let inFlight = false;

async function loadModes() {
  const { modes } = await api.modes();
  modes.forEach((m) => {
    const el = document.querySelector(`.card.mode[data-mode="${m.id}"]`);
    if (el) {
      const badge = el.querySelector('[data-test-count]');
      if (badge) badge.textContent = `${m.tests} tests`;
    }
  });
  $$('.card.mode').forEach((card) => {
    card.addEventListener('click', () => {
      $$('.card.mode').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      currentMode = card.dataset.mode;
      $('#run-mode').value = currentMode;
    });
  });
  document.querySelector(`.card.mode[data-mode="${currentMode}"]`)?.classList.add('selected');
}

async function loadCredentials() {
  const { configurations } = await api.credentials();
  const sel = $('#run-credential');
  sel.innerHTML = '';
  for (const c of configurations) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = `${c.id} — ${c.label}`;
    sel.appendChild(o);
  }
}

async function loadConfigIntoForm() {
  const c = await api.config();
  $('#run-mode').value = c.mode;
  $('#run-credential').value = c.credentialConfigurationId;
  $('#run-issuer').value = c.targetIssuer ?? '';
  $('#run-verifier').value = c.targetVerifier ?? '';
  currentMode = c.mode;
  $$('.card.mode').forEach((card) => card.classList.toggle('selected', card.dataset.mode === c.mode));
  // Per MAS-145: a local override (browser localStorage) wins over the
  // server config for the QA-typed target URLs. The server is still the
  // source of truth for cross-restart durability; local is a convenience.
  applyLocalConfigToRunForm();
}

function applyLocalConfigToRunForm() {
  const local = readLocalConfig();
  if (!local) return;
  if (typeof local.targetIssuer === 'string') $('#run-issuer').value = local.targetIssuer;
  if (typeof local.targetVerifier === 'string') $('#run-verifier').value = local.targetVerifier;
}

function renderReportInto(panel, report) {
  // MAS-174: a report without a `summary` (e.g. partial persisted shape,
  // a future code path that builds a report shell, etc.) must still
  // render. The server is the source of truth for shape — by the time
  // the SPA sees a report over the wire the /api/runs endpoint already
  // backfills a missing summary — but we defend in depth because the
  // report can also be deep-linked from a saved JSON.
  const summary = report.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
  const passPct = (summary.passRate * 100).toFixed(1);
  const runIdEsc = escapeHtml(report.runId);
  const modeEsc = escapeHtml(report.mode);
  const total = summary.total;
  const stepMs = prefersReducedMotion ? 0 : Math.min(28, 600 / Math.max(total, 1));
  panel.innerHTML = `
    <div class="report-head">
      <h3>${runIdEsc} <span class="dim">· ${modeEsc}</span></h3>
      <div class="report-actions">
        <a class="ghost" href="/api/runs/${encodeURIComponent(report.runId)}/report.json" download>
          <svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2v8M3 7l4 4 4-4M2 12h10"/></svg>
          JSON
        </a>
        <a class="ghost" href="/api/runs/${encodeURIComponent(report.runId)}/report.html" download>
          <svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2v8M3 7l4 4 4-4M2 12h10"/></svg>
          HTML
        </a>
        <a class="ghost" href="/api/runs/${encodeURIComponent(report.runId)}/report.csv" download>
          <svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2v8M3 7l4 4 4-4M2 12h10"/></svg>
          CSV
        </a>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${total}</div><div class="l">Tests</div></div>
      <div class="kpi passed"><div class="v">${summary.passed}</div><div class="l">Passed</div></div>
      <div class="kpi failed"><div class="v">${summary.failed}</div><div class="l">Failed</div></div>
      <div class="kpi"><div class="v">${escapeHtml(passPct)}%</div><div class="l">Pass rate</div></div>
    </div>
    <table class="results-table" aria-label="Per-test results">
      <thead><tr><th></th><th>Test ID</th><th>Name</th><th>Result</th><th class="dur">Dur</th></tr></thead>
      <tbody>
        ${report.results.map((r, i) => {
          const cls = r.message.startsWith('SKIPPED') ? 'skip' : (r.pass ? 'pass' : 'fail');
          const icon = cls === 'skip'
            ? '<svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="3,3 5,3 5,9 3,9"/><polygon points="9,3 11,3 11,9 9,9"/></svg>'
            : cls === 'pass'
              ? '<svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>'
              : '<svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>';
          const ev = r.evidence
            ? `<details><summary>evidence</summary><pre>${escapeHtml(JSON.stringify(r.evidence, null, 2))}</pre></details>`
            : '';
          return `<tr class="${cls}" style="--rd:${(i * stepMs).toFixed(1)}ms">
            <td class="status">${icon}</td>
            <td class="id">${escapeHtml(r.id)}</td>
            <td class="name">${escapeHtml(r.name)}<div class="dim" style="font-weight:300;margin-top:0.2rem;font-size:0.78rem">${escapeHtml(r.message)}${ev}</div></td>
            <td class="dur">${r.durationMs} ms</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function startRun() {
  if (inFlight) return;
  inFlight = true;
  const btn = $('#btn-run');
  const btnLabel = btn.querySelector('.btn-label');
  btn.disabled = true;
  btn.classList.add('running');
  if (btnLabel) btnLabel.textContent = 'Running…';

  const body = {
    mode: $('#run-mode').value,
    credentialConfigurationId: $('#run-credential').value,
    targetIssuer: $('#run-issuer').value || undefined,
    targetVerifier: $('#run-verifier').value || undefined,
  };

  // MAS-145: persist the QA-typed targets in this browser so a refresh
  // (or "Load saved config" click) prefills them over the server value.
  try {
    writeLocalConfig(window.localStorage, {
      targetIssuer: $('#run-issuer').value,
      targetVerifier: $('#run-verifier').value,
    });
  } catch { /* non-fatal: storage may be disabled */ }

  const side = $('#run-side');
  const meta = $('#run-meta');
  if (meta) meta.textContent = `Running · ${body.mode}`;
  side.innerHTML = `
    <div class="report-head">
      <h3><span class="dim">Dispatching catalog…</span></h3>
    </div>
    <div class="skeleton" aria-hidden="true">
      <div class="sk s1"></div>
      <div class="sk s2"></div>
      <div class="sk s3"></div>
      <div class="sk tall"></div>
    </div>
  `;
  side.setAttribute('aria-busy', 'true');

  try {
    const report = await api.startRun(body);
    // MAS-174 follow-up: the server returns a Fastify error envelope
    // ({statusCode, code, error, message}) on 4xx/5xx instead of a
    // typed Report. That envelope has no `summary` / `runId` / `results`,
    // so renderReportInto() would render a blank panel and the user
    // would see "0/0 passed" with no explanation. Detect the envelope
    // shape and surface a friendly message + targeted hint based on
    // the failure mode.
    if (report && typeof report === 'object' && !report.runId && report.statusCode && report.message) {
      const hint = hintForStartRunError(report, body);
      side.removeAttribute('aria-busy');
      side.innerHTML = `<div class="empty">Run failed: ${escapeHtml(report.message)}</div>${hint}`;
      if (meta) meta.textContent = `Failed · ${body.mode}`;
      toast(`Run failed: ${report.message}`, 'bad');
      return;
    }
    renderReportInto(side, report);
    side.removeAttribute('aria-busy');
    const summary = report.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
    if (meta) meta.textContent = `Done · ${body.mode}`;
    toast(`Run complete · ${summary.passed}/${summary.total} passed`, summary.failed === 0 ? 'ok' : 'bad');
  } catch (e) {
    side.removeAttribute('aria-busy');
    side.innerHTML = `<div class="empty">Run failed: ${escapeHtml(e.message)}</div>`;
    if (meta) meta.textContent = `Failed · ${body.mode}`;
    toast(`Run failed: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.classList.remove('running');
    if (btnLabel) btnLabel.textContent = 'Run conformance';
    inFlight = false;
  }
}

/**
 * Render a one-line hint tailored to the failure mode so the user
 * doesn't have to grep the server log. The most common
 * "summary is not defined"-shaped complaint (MAS-174 follow-up) was
 * caused by `targetIssuer` pointing at a non-OID4VCI URL — the runner
 * failed to fetch `/.well-known/openid-credential-issuer`, the suite
 * ran with no metadata, every prereq-gated test SKIPped, and the old
 * frontend mishandled the empty render. Now we point the user at the
 * README's "Quick start with the in-process mock issuer" section so
 * they have a known-good config to start from.
 */
function hintForStartRunError(err, body) {
  const code = String(err.code || '');
  const msg = String(err.message || '');
  // 1) EACCES on the persistent store — the server itself can't write.
  if (code === 'EACCES' || /permission denied/.test(msg)) {
    return `<div class="empty" style="font-size:12px;margin-top:6px">
      The server could not write its persistent run store. See the README "Docker" section.
    </div>`;
  }
  // 2) Invalid config — the user typed a malformed targetIssuer URL.
  if (code === 'FST_ERR_VALIDATION' || /invalid_request/.test(msg) || /invalid URL/.test(msg)) {
    return `<div class="empty" style="font-size:12px;margin-top:6px">
      Check the Configuration form: <code>targetIssuer</code> must be a valid URL that serves an
      OID4VCI metadata document at <code>&lt;base&gt;/.well-known/openid-credential-issuer</code>.
    </div>`;
  }
  // 3) Generic 5xx — point at the in-process mock as the easy path.
  if (body && body.targetIssuer) {
    return `<div class="empty" style="font-size:12px;margin-top:6px">
      Tip: clear the <code>targetIssuer</code> field and run again — the in-process mock issuer
      is preconfigured and always reachable. See the README "Quick start" section.
    </div>`;
  }
  return '';
}

// ---------- VP-via-QR view (MAS-312.B) ----------

// Camera state. Module-scoped so a view switch can stop an in-flight
// stream and a successful scan can replace the textarea without
// re-binding. The stream is deliberately closed on every stop: leaving
// the camera LED on after a successful scan is a fast way to lose
// tester trust.
let qrCameraStream = null;
let qrCameraDetector = null;
let qrCameraTimer = null;
let qrCameraSupported = null;

async function isBarcodeDetectorSupported() {
  if (qrCameraSupported !== null) return qrCameraSupported;
  // `BarcodeDetector` is a Chrome/Edge surface. Firefox / Safari ship
  // without it. We feature-detect the constructor and a known
  // format so the camera button can be hidden or replaced with a
  // paste-only hint on unsupported browsers.
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
    qrCameraSupported = false;
    return qrCameraSupported;
  }
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    qrCameraSupported = Array.isArray(fmts) && fmts.includes('qr_code');
  } catch {
    qrCameraSupported = false;
  }
  return qrCameraSupported;
}

/**
 * Render the parsed QR fields into a small preview card so the tester
 * can see what the verifier is asking for BEFORE they submit. We call
 * `/api/qr/validate` (the same endpoint the catalog run uses) so the
 * preview is consistent with what the runner will see on submit. A
 * failed parse is rendered as an inline error inside the same card.
 */
async function renderQrPreview() {
  const side = $('#qr-side');
  const payload = $('#qr-payload').value.trim();
  if (!payload) {
    side.innerHTML = '';
    side.appendChild(qrEmptyCard());
    return;
  }
  side.setAttribute('aria-busy', 'true');
  const prev = side.innerHTML;
  side.innerHTML = `
    <div class="report-head"><h3><span class="dim">Parsing QR…</span></h3></div>
    <div class="skeleton" aria-hidden="true">
      <div class="sk s1"></div><div class="sk s2"></div><div class="sk s3"></div>
    </div>`;
  try {
    const r = await api.validateQr(payload);
    side.removeAttribute('aria-busy');
    if (!r.body || r.body.ok !== true) {
      const errMsg = r.body?.error || `validate_failed_${r.status}`;
      side.innerHTML = qrPreviewError(errMsg, r.body);
      return;
    }
    side.innerHTML = qrPreviewCard(r.body);
  } catch (e) {
    side.removeAttribute('aria-busy');
    side.innerHTML = qrPreviewError(e.message, null);
  }
}

function qrEmptyCard() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.id = 'qr-empty';
  d.innerHTML = `
    <svg class="icon" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="0.8"/><rect x="13" y="3" width="6" height="6" rx="0.8"/><rect x="3" y="13" width="6" height="6" rx="0.8"/><path d="M13 13h2M13 17h2M17 13v2M17 17v2"/></svg>
    <div>No submission yet. Paste a QR URL above (or scan with the camera) and hit <strong>Submit VP</strong>.</div>
  `;
  return d;
}

function qrPreviewCard(body) {
  const d = body.details || {};
  // Render the verifier-asked-for fields in a stable order. The
  // request_uri / dcql_query / presentation_definition are mutually
  // exclusive in OID4VP 1.0 (well, two-of-three common; the spec lets
  // you mix), so we just emit whichever keys are present.
  const dcql = d.dcql_query
    ? `<details open><summary>DCQL query</summary><pre>${escapeHtml(JSON.stringify(d.dcql_query, null, 2))}</pre></details>`
    : '';
  const pd = d.presentation_definition
    ? `<details open><summary>Presentation definition</summary><pre>${escapeHtml(JSON.stringify(d.presentation_definition, null, 2))}</pre></details>`
    : '';
  const ru = d.request_uri
    ? `<div class="qr-row"><span class="k">request_uri</span><span class="v mono">${escapeHtml(d.request_uri)}</span></div>`
    : '';
  const respUri = d.response_uri
    ? `<div class="qr-row"><span class="k">response_uri</span><span class="v mono">${escapeHtml(d.response_uri)}</span></div>`
    : '';
  return `
    <div class="report-head">
      <h3>Parsed QR <span class="dim">· ${escapeHtml(body.flow)}</span></h3>
    </div>
    <div class="qr-card">
      <div class="qr-row"><span class="k">scheme</span><span class="v mono">${escapeHtml(body.normalizedUrl.split(':')[0])}</span></div>
      <div class="qr-row"><span class="k">client_id</span><span class="v mono">${escapeHtml(d.client_id || '—')}</span></div>
      <div class="qr-row"><span class="k">response_type</span><span class="v mono">${escapeHtml(d.response_type || '—')}</span></div>
      ${respUri}
      ${ru}
      ${dcql}${pd}
    </div>
  `;
}

function qrPreviewError(message, body) {
  return `
    <div class="report-head"><h3><span class="dim">Parse error</span></h3></div>
    <div class="qr-card qr-card-error">
      <div class="qr-row"><span class="k">error</span><span class="v">${escapeHtml(message)}</span></div>
      ${body && body.details
        ? `<details><summary>raw details</summary><pre>${escapeHtml(JSON.stringify(body.details, null, 2))}</pre></details>`
        : ''}
    </div>
  `;
}

async function startQrCamera() {
  const region = $('#qr-camera-region');
  const video = $('#qr-camera-video');
  const status = $('#qr-camera-status');
  const btn = $('#btn-qr-scan');
  const supported = await isBarcodeDetectorSupported();
  if (!supported) {
    status.textContent = 'Camera scanning not supported in this browser — paste the URL instead.';
    status.classList.add('bad');
    return;
  }
  if (qrCameraStream) {
    // Already running — treat as a stop toggle.
    stopQrCamera();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'No camera API available in this browser.';
    status.classList.add('bad');
    return;
  }
  try {
    qrCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    video.srcObject = qrCameraStream;
    region.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    status.textContent = 'Point the camera at the QR code…';
    status.classList.remove('bad');
    await video.play();
    qrCameraDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
    qrCameraTimer = setInterval(scanQrFrame, 350);
  } catch (e) {
    status.textContent = `Camera unavailable: ${e.message}`;
    status.classList.add('bad');
    stopQrCamera();
  }
}

function stopQrCamera() {
  if (qrCameraTimer) { clearInterval(qrCameraTimer); qrCameraTimer = null; }
  qrCameraDetector = null;
  if (qrCameraStream) {
    qrCameraStream.getTracks().forEach((t) => t.stop());
    qrCameraStream = null;
  }
  const region = $('#qr-camera-region');
  const video = $('#qr-camera-video');
  const btn = $('#btn-qr-scan');
  if (region) region.hidden = true;
  if (video) video.srcObject = null;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const status = $('#qr-camera-status');
  if (status) { status.textContent = ''; status.classList.remove('bad'); }
}

async function scanQrFrame() {
  if (!qrCameraDetector || !qrCameraStream) return;
  const video = $('#qr-camera-video');
  if (!video || video.readyState < 2) return;
  try {
    const codes = await qrCameraDetector.detect(video);
    if (codes && codes.length) {
      const value = codes[0].rawValue || codes[0].value || '';
      if (value) {
        $('#qr-payload').value = value;
        stopQrCamera();
        toast('QR scanned — review fields, then Submit.', 'ok');
        // Auto-refresh the preview so the tester sees the parsed
        // fields immediately, before they commit to a submit.
        renderQrPreview();
      }
    }
  } catch {
    // Detection can throw transiently when the camera is still
    // warming up; swallow and try again on the next tick.
  }
}

async function submitQrVp() {
  const btn = $('#btn-qr-submit');
  const btnLabel = btn.querySelector('.btn-label');
  if (btn.disabled) return;
  const payload = $('#qr-payload').value.trim();
  if (!payload) {
    toast('Paste an openid4vp:// URL (or scan one) before submitting.', 'bad');
    return;
  }
  const target = $('#qr-target').value.trim();
  const body = {
    qrPayload: payload,
    targetVerifier: target || '',
  };
  btn.disabled = true;
  btn.classList.add('running');
  if (btnLabel) btnLabel.textContent = 'Submitting…';
  const side = $('#qr-side');
  const meta = $('#qrvp-meta');
  if (meta) meta.textContent = 'Submitting VP…';
  side.setAttribute('aria-busy', 'true');
  side.innerHTML = `
    <div class="report-head"><h3><span class="dim">Submitting VP to verifier…</span></h3></div>
    <div class="skeleton" aria-hidden="true">
      <div class="sk s1"></div><div class="sk s2"></div><div class="sk s3"></div><div class="sk tall"></div>
    </div>`;
  try {
    const r = await api.sendQrVp(body);
    side.removeAttribute('aria-busy');
    if (r.body && r.body.ok === true) {
      // Happy path: verifier accepted. The endpoint returns
      // { ok, status, response, vpToken, sentTo, evidence } and we
      // render a small confirmation card. We deliberately do NOT
      // render a full report for the one-shot — the user asked for
      // a single VP submission, not the catalog. The evidence
      // block (request + response) is rendered so QA can copy it.
      side.innerHTML = renderQrSuccess(r.body);
      if (meta) meta.textContent = `Done · ${r.status}`;
      toast(`Verifier accepted (HTTP ${r.status})`, 'ok');
      // Append to run history so the user can replay it from the
      // History view. The run is a synthetic one-row "report" with
      // summary fields the existing /api/runs history picker can
      // render. We POST to /api/runs so the file store picks it up
      // exactly like a catalog run.
      await appendQrRunToHistory({ ok: true, status: r.status, body: r.body });
    } else {
      // Either the endpoint returned a typed error envelope
      // (verifier_rejected, invalid_qr, …) or the network
      // surfaced a Fastify 4xx. Render the same error card shape
      // and the targeted hint so the tester knows what went wrong.
      const errMsg = r.body?.error || `send_failed_${r.status}`;
      const detailStatus = r.body?.status ?? r.status;
      side.innerHTML = renderQrFailure(errMsg, detailStatus, r.body);
      if (meta) meta.textContent = `Failed · ${detailStatus}`;
      toast(`Submission failed: ${errMsg}`, 'bad');
      await appendQrRunToHistory({ ok: false, status: detailStatus, body: r.body, error: errMsg });
    }
  } catch (e) {
    side.removeAttribute('aria-busy');
    side.innerHTML = renderQrFailure(e.message, null, null);
    if (meta) meta.textContent = 'Failed';
    toast(`Submission failed: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.classList.remove('running');
    if (btnLabel) btnLabel.textContent = 'Submit VP';
  }
}

function renderQrSuccess(body) {
  const evidence = body.evidence || {};
  const qr = evidence.qr || {};
  const req = evidence.request || {};
  const resp = evidence.response || {};
  return `
    <div class="report-head">
      <h3>Verifier accepted <span class="dim">· HTTP ${body.status}</span></h3>
      <div class="report-actions">
        <span class="tag ok">pass</span>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi passed"><div class="v">${body.status}</div><div class="l">HTTP status</div></div>
      <div class="kpi"><div class="v mono" style="font-size:0.9rem">${escapeHtml(qr.client_id || '—')}</div><div class="l">client_id</div></div>
      <div class="kpi"><div class="v mono" style="font-size:0.86rem">${escapeHtml(truncate(body.sentTo || '', 40))}</div><div class="l">sent to</div></div>
    </div>
    <div class="qr-card">
      <div class="qr-row"><span class="k">request</span><span class="v mono">${escapeHtml(req.method || 'POST')} ${escapeHtml(req.url || body.sentTo || '—')}</span></div>
      <div class="qr-row"><span class="k">response</span><span class="v mono">HTTP ${resp.status ?? '—'}</span></div>
      <details><summary>vp_token (KB-JWT)</summary><pre>${escapeHtml(body.vpToken || '')}</pre></details>
      <details><summary>request body</summary><pre>${escapeHtml(JSON.stringify(req.body || {}, null, 2))}</pre></details>
      <details><summary>response body</summary><pre>${escapeHtml(JSON.stringify(resp.body ?? {}, null, 2))}</pre></details>
    </div>
  `;
}

function renderQrFailure(message, status, body) {
  const safe = (v) => (v == null ? '—' : String(v));
  const hint = hintForQrError(message, status, body);
  return `
    <div class="report-head">
      <h3>Submission failed <span class="dim">· HTTP ${safe(status)}</span></h3>
      <div class="report-actions"><span class="tag bad">fail</span></div>
    </div>
    <div class="qr-card qr-card-error">
      <div class="qr-row"><span class="k">error</span><span class="v">${escapeHtml(message)}</span></div>
      <div class="qr-row"><span class="k">verifier status</span><span class="v mono">${safe(status)}</span></div>
      ${body && body.details
        ? `<details><summary>raw details</summary><pre>${escapeHtml(JSON.stringify(body.details, null, 2))}</pre></details>`
        : ''}
      ${hint ? `<div class="qr-hint">${hint}</div>` : ''}
    </div>
  `;
}

function hintForQrError(message, status, body) {
  const m = String(message || '');
  if (/client_id/.test(m)) {
    return 'The QR is missing the <code>client_id</code> parameter — verifiers must include it per OID4VP 1.0 §5.1.';
  }
  if (/request_uri|dcql_query|presentation_definition/.test(m)) {
    return 'The QR is missing all of <code>request_uri</code>, <code>dcql_query</code>, and <code>presentation_definition</code>. The verifier must advertise at least one.';
  }
  if (m === 'verifier_rejected' || status === 502) {
    return 'The verifier accepted the request and rejected the VP itself. Check the verifier logs for the exact reason (typically an audience mismatch on the KB-JWT).';
  }
  if (m === 'target_verifier_required') {
    return 'Provide a <strong>Target verifier URL</strong> above — the runner needs a base URL to resolve a relative <code>response_uri</code> and to set the KB-JWT <code>aud</code> claim.';
  }
  if (m === 'verifier_unreachable') {
    return 'The runner could not reach the verifier at the <code>response_uri</code>. Check the network path and the verifier health pill at the top of the page.';
  }
  return '';
}

async function appendQrRunToHistory({ ok, status, body, error }) {
  // MAS-312.B: a VP-via-QR submission is a one-shot, but QA still
  // wants to be able to replay it. We synthesize a single-result
  // "report" with the same shape as a catalog run
  // ({ runId, mode, summary, results, target, startedAt, durationMs,
  // evidence }) and POST it to /api/runs. The endpoint persists it
  // like any other run, so the History view shows it with a pass /
  // fail row. The `mode` is `Q->V` (a synthetic token that
  // distinguishes one-shot QRs from catalog runs) and the
  // `target.credentialConfigurationId` is the dcql_query id when
  // there is one.
  try {
    const dcql = body?.evidence?.qr?.dcql_query;
    const cid = Array.isArray(dcql?.credentials) && dcql.credentials.length
      ? dcql.credentials.map((c) => c?.id).filter(Boolean).join('+') || 'qr'
      : 'qr';
    const start = Date.now();
    const report = {
      mode: 'Q->V',
      target: {
        mode: 'Q->V',
        targetVerifier: body?.sentTo ?? '',
        credentialConfigurationId: cid,
      },
      summary: { total: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0, passRate: ok ? 1 : 0 },
      results: [{
        id: 'IT.PV.AU.H.V.VB.QRP.001',
        name: 'VP-via-QR submission',
        pass: ok,
        message: ok
          ? `Verifier accepted HTTP ${status}`
          : `Submission failed: ${error || `HTTP ${status}`}`,
        durationMs: Date.now() - start,
        evidence: {
          ...(body?.evidence || {}),
          ...(ok ? {} : { error, status }),
        },
      }],
      startedAt: new Date(start).toISOString(),
      durationMs: 1,
    };
    // POST the synthesized report so /api/runs persists it. We
    // don't await UI feedback — fire-and-forget so a save failure
    // doesn't take down the success toast.
    void api.startRun(report).catch(() => { /* non-fatal */ });
  } catch {
    /* non-fatal: history is best-effort */
  }
}

function clearQrForm() {
  $('#qr-payload').value = '';
  $('#qr-target').value = '';
  stopQrCamera();
  const side = $('#qr-side');
  side.innerHTML = '';
  side.appendChild(qrEmptyCard());
  const meta = $('#qrvp-meta');
  if (meta) meta.textContent = 'No submission yet';
  $('#qr-payload').focus();
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------- Config view ----------

async function renderConfig() {
  const c = await api.config();
  const f = $('#config-form');
  f.mode.value = c.mode;
  f.credentialConfigurationId.value = c.credentialConfigurationId;
  f.targetIssuer.value = c.targetIssuer ?? '';
  f.targetVerifier.value = c.targetVerifier ?? '';
  // MAS-145: prefill the Configuration form from the browser-local store
  // when the QA has typed a value in this session/tab but not yet saved.
  const local = readLocalConfig();
  if (local) {
    if (typeof local.targetIssuer === 'string') f.targetIssuer.value = local.targetIssuer;
    if (typeof local.targetVerifier === 'string') f.targetVerifier.value = local.targetVerifier;
  }
  await renderKeys();
}

async function renderKeys() {
  const k = await api.keys();
  const el = $('#keys-display');
  el.innerHTML = `
    <strong>ES256</strong> (P-256) <code>${escapeHtml(k.es256.kid)}</code><br>
    thumbprint <code>${escapeHtml(k.es256.thumbprint)}</code><br>
    <strong>EdDSA</strong> (Ed25519) <code>${escapeHtml(k.eddsa.kid)}</code><br>
    thumbprint <code>${escapeHtml(k.eddsa.thumbprint)}</code>
  `;
}

async function saveConfig(ev) {
  ev.preventDefault();
  const f = ev.target;
  await api.saveConfig({
    mode: f.mode.value,
    credentialConfigurationId: f.credentialConfigurationId.value,
    targetIssuer: f.targetIssuer.value || undefined,
    targetVerifier: f.targetVerifier.value || undefined,
  });
  // MAS-145: mirror the saved values into the browser-local store so
  // a refresh prefills them without depending on the server round-trip.
  try {
    writeLocalConfig(window.localStorage, {
      targetIssuer: f.targetIssuer.value,
      targetVerifier: f.targetVerifier.value,
    });
  } catch { /* non-fatal */ }
  toast('Config saved', 'ok');
}

async function regenKeys() {
  await api.regenKeys();
  await renderKeys();
  toast('New wallet keys generated', 'ok');
}

// ---------- History view ----------

// Pinned-left run for diff. Lives in module scope so it survives history
// re-renders and view switches. Cleared by `clearPin()`.
let pinnedLeftId = null;

// Sync the URL to reflect the current diff selection. Uses replaceState
// so each pin/diff/clear updates the bar without filling the back stack
// (the back stack is reserved for actual navigation). Per MAS-143, the
// URL is the source of truth on refresh.
function syncDiffUrl() {
  if (!history?.replaceState) return;
  history.replaceState(null, '', buildHref(window.location, currentDiffSelection));
}

function setPin(runId) {
  pinnedLeftId = runId;
  // Partial diff: only the left side is pinned. The URL keeps a `diff=`
  // entry with an empty right, so a refresh restores the pin (and the
  // user can pick a right side to actually diff). report is preserved
  // through the round-trip so a shared link returns to its origin.
  currentDiffSelection = { left: runId, right: null, report: currentDiffReportId };
  syncDiffUrl();
  renderHistory();
}

function clearPin() {
  pinnedLeftId = null;
  currentDiffSelection = null;
  currentDiffReportId = null;
  syncDiffUrl();
  renderHistory();
}

async function loadAndShowDiff(rightId) {
  if (!pinnedLeftId) return;
  if (pinnedLeftId === rightId) {
    toast('Pin a different run as the left side (shift-click another row).', 'bad');
    return;
  }
  showView('run');
  const side = $('#run-side');
  side.setAttribute('aria-busy', 'true');
  side.innerHTML = `
    <div class="report-head">
      <h3><span class="dim">Diffing…</span></h3>
    </div>
    <div class="skeleton" aria-hidden="true">
      <div class="sk s1"></div>
      <div class="sk s2"></div>
      <div class="sk s3"></div>
    </div>
  `;
  const meta = $('#run-meta');
  if (meta) meta.textContent = `Diff · ${rightId}`;
  try {
    const d = await api.diff(rightId, pinnedLeftId);
    renderDiffInto(side, d, pinnedLeftId, rightId);
    side.removeAttribute('aria-busy');
    if (meta) meta.textContent = `Diff · ${pinnedLeftId} ↔ ${rightId}`;
    currentDiffSelection = { left: pinnedLeftId, right: rightId, report: currentDiffReportId };
    syncDiffUrl();
  } catch (e) {
    side.removeAttribute('aria-busy');
    side.innerHTML = `<div class="empty">Diff failed: ${escapeHtml(e.message)}</div>`;
    if (meta) meta.textContent = `Diff failed · ${e.status ?? ''}`.trim();
    toast(`Diff failed: ${e.message}`, 'bad');
  }
}

async function renderHistory() {
  const list = $('#history-list');
  const { runs } = await api.runs();
  if (!runs.length) {
    list.innerHTML = `<div class="empty" style="color:var(--ink-3);font-style:italic;padding:var(--s-3) 0">No runs yet.</div>`;
    return;
  }
  const stepMs = prefersReducedMotion ? 0 : Math.min(40, 400 / Math.max(runs.length, 1));
  // Pin toolbar: visible only when a left run is pinned. Shows which run
  // is pinned, a Diff hint, and a "clear" button.
  const toolbar = pinnedLeftId
    ? `<div class="pin-toolbar" role="status" aria-live="polite">
        <span class="pin-tag">
          <svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2l3 3-6 6H3v-3z"/></svg>
          Pinned left: <code>${escapeHtml(pinnedLeftId)}</code>
        </span>
        <span class="dim">Shift-click another row to diff against it.</span>
        <button class="ghost btn-clear-pin" type="button">Clear pin</button>
      </div>`
    : '';
  list.innerHTML = toolbar + runs.map((r, i) => {
    // MAS-174: defend against runs whose summary is somehow missing on the
    // wire (the /api/runs endpoint backfills, but the SPA also accepts
    // reports via deep-links and saved JSON files).
    const s = r.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
    const p = s.passed, f = s.failed;
    const isPinned = r.runId === pinnedLeftId;
    return `<button class="history-row${isPinned ? ' pinned' : ''}" data-id="${escapeHtml(r.runId)}" type="button" style="--rd:${(i * stepMs).toFixed(1)}ms">
      <div class="id">${escapeHtml(r.runId)}${isPinned ? ' <span class="pin-mark" aria-label="pinned as left side">L</span>' : ''}</div>
      <div class="mode">${escapeHtml(r.mode)}</div>
      <div class="ts">${escapeHtml(new Date(r.startedAt).toLocaleString())}</div>
      <div class="stats"><span class="ok">${p}✓</span><span class="bad">${f}✗</span></div>
      <div class="dur">${r.durationMs} ms</div>
      <div class="target">${escapeHtml(r.target.credentialConfigurationId)}</div>
    </button>`;
  }).join('');
  $$('.history-row').forEach((row) => {
    row.addEventListener('click', async (ev) => {
      const id = row.dataset.id;
      if (ev.shiftKey) {
        // Shift-click always (re-)pins this run as the left side.
        setPin(id);
        toast(`Pinned ${id} as left side. Click another row to diff.`, 'ok');
        return;
      }
      if (pinnedLeftId && pinnedLeftId !== id) {
        // Plain click on a different row when something is pinned → diff.
        await loadAndShowDiff(id);
        return;
      }
      const report = await api.run(id);
      showView('run');
      const side = $('#run-side');
      side.innerHTML = '';
      renderReportInto(side, report);
      const meta = $('#run-meta');
      if (meta) meta.textContent = `Loaded · ${report.mode}`;
    });
  });
  const clearBtn = list.querySelector('.btn-clear-pin');
  if (clearBtn) clearBtn.addEventListener('click', clearPin);
}

// Diff render: mirrors the report panel layout so the UX feels consistent.
function renderDiffInto(panel, diff, leftId, rightId, options = {}) {
  const s = diff.summary;
  // "back to report" affordance: when this diff is loaded over a report
  // URL (e.g. /?report=<runId>&diff=...), surface a link that returns
  // the user to the originating report view. Hidden otherwise.
  const backHref = options.backToReportId
    ? `${window.location.pathname}?report=${encodeURIComponent(options.backToReportId)}`
    : null;
  const back = backHref
    ? `<a class="ghost" id="btn-back-to-report" href="${backHref}" title="Return to the report this diff was opened from">
         <svg class="icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11L5 7l4-4"/></svg>
         Back to report
       </a>`
    : '';
  const summary = `
    <div class="report-head">
      <h3>Diff <span class="dim">· ${escapeHtml(leftId)} ↔ ${escapeHtml(rightId)}</span></h3>
      <div class="report-actions">
        ${back}
        <button class="ghost" id="btn-clear-pin-2" type="button">Clear pin</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi failed"><div class="v">${s.passToFail}</div><div class="l">Pass→Fail</div></div>
      <div class="kpi passed"><div class="v">${s.failToPass}</div><div class="l">Fail→Pass</div></div>
      <div class="kpi failed"><div class="v">${s.newFail}</div><div class="l">New fail</div></div>
      <div class="kpi passed"><div class="v">${s.newPass}</div><div class="l">New pass</div></div>
      <div class="kpi"><div class="v">${s.removed}</div><div class="l">Removed</div></div>
      <div class="kpi"><div class="v">${s.unchanged}</div><div class="l">Unchanged</div></div>
    </div>
  `;
  const rows = (diff.rows || []).map((r, i) => {
    const cls = r.flip === 'pass-to-fail' || r.flip === 'new-fail'
      ? 'fail'
      : r.flip === 'fail-to-pass' || r.flip === 'new-pass'
        ? 'pass'
        : r.flip === 'removed'
          ? 'skip'
          : '';
    const lMark = r.left ? (r.left.pass ? '✓' : (r.left.message && r.left.message.startsWith('SKIPPED') ? '⏭' : '✗')) : '–';
    const rMark = r.right ? (r.right.pass ? '✓' : (r.right.message && r.right.message.startsWith('SKIPPED') ? '⏭' : '✗')) : '–';
    return `<tr class="${cls}">
      <td class="flip"><span class="tag ${cls}">${escapeHtml(r.flip)}</span></td>
      <td class="id">${escapeHtml(r.id)}</td>
      <td class="name">${escapeHtml(r.name)}</td>
      <td class="lr"><span class="dim">L</span> ${lMark} <span class="dim">R</span> ${rMark}</td>
    </tr>`;
  }).join('');
  panel.innerHTML = summary + `
    <table class="results-table" aria-label="Per-test diff">
      <thead><tr><th>Flip</th><th>Test ID</th><th>Name</th><th>L / R</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">No tests to diff.</td></tr>`}</tbody>
    </table>
  `;
  const btn = panel.querySelector('#btn-clear-pin-2');
  if (btn) btn.addEventListener('click', () => { clearPin(); showView('history'); });
}

/**
 * Restore a diff deep-link from the URL. Called at boot. Returns true
 * when a diff was applied. A partial `diff=L` (pin-only) is reflected
 * in the pin toolbar but does not trigger a fetch.
 */
async function restoreDiffFromUrl() {
  const sel = readDiffFromSearch(window.location.search);
  if (!sel.left) return false;
  pinnedLeftId = sel.left;
  currentDiffSelection = sel.left && sel.right ? sel : { left: sel.left, right: null, report: sel.report };
  currentDiffReportId = sel.report || null;
  if (!sel.right) {
    // Partial state: surface the pin in the history view so the user
    // can pick a right side to diff.
    showView('history');
    return false;
  }
  showView('run');
  const side = $('#run-side');
  const meta = $('#run-meta');
  side.setAttribute('aria-busy', 'true');
  side.innerHTML = `
    <div class="report-head">
      <h3><span class="dim">Diffing…</span></h3>
    </div>
    <div class="skeleton" aria-hidden="true">
      <div class="sk s1"></div>
      <div class="sk s2"></div>
      <div class="sk s3"></div>
    </div>
  `;
  if (meta) meta.textContent = `Diff · ${sel.right}`;
  try {
    const d = await api.diff(sel.right, sel.left);
    renderDiffInto(side, d, sel.left, sel.right, { backToReportId: sel.report });
    side.removeAttribute('aria-busy');
    if (meta) meta.textContent = `Diff · ${sel.left} ↔ ${sel.right}`;
  } catch (e) {
    side.removeAttribute('aria-busy');
    side.innerHTML = `<div class="empty">Diff failed: ${escapeHtml(e.message)}</div>`;
    if (meta) meta.textContent = `Diff failed · ${e.status ?? ''}`.trim();
    toast(`Diff failed: ${e.message}`, 'bad');
  }
  return true;
}

// ---------- Catalog view ----------

let catalogData = null;
let catalogFilter = { q: '', mode: '', behavior: '' };

async function renderCatalog() {
  if (!catalogData) catalogData = await api.catalog();
  const f = catalogFilter;
  const rows = catalogData.tests.filter((t) => {
    if (f.mode && !t.modes.includes(f.mode)) return false;
    if (f.behavior && t.behavior !== f.behavior) return false;
    if (f.q && !(`${t.id} ${t.name} ${t.specRef} ${t.operation}`.toLowerCase().includes(f.q.toLowerCase()))) return false;
    return true;
  });
  const stepMs = prefersReducedMotion ? 0 : Math.min(20, 500 / Math.max(rows.length, 1));
  $('#catalog-table').innerHTML = `
    <div class="catalog-filter">
      <input placeholder="Filter by id / name / spec…" id="cat-q" value="${escapeHtml(f.q)}">
      <select id="cat-mode">
        <option value="">All modes</option>
        <option ${f.mode === 'I->W' ? 'selected' : ''} value="I->W">I→W</option>
        <option ${f.mode === 'V->W' ? 'selected' : ''} value="V->W">V→W</option>
        <option ${f.mode === 'W->I' ? 'selected' : ''} value="W->I">W→I</option>
        <option ${f.mode === 'W->V' ? 'selected' : ''} value="W->V">W→V</option>
      </select>
      <select id="cat-beh">
        <option value="">All behavior</option>
        <option ${f.behavior === 'VB' ? 'selected' : ''} value="VB">Valid (VB)</option>
        <option ${f.behavior === 'IB' ? 'selected' : ''} value="IB">Invalid (IB)</option>
      </select>
      <span class="count">${rows.length} / ${catalogData.tests.length}</span>
    </div>
    <div class="catalog-list" id="catalog-list">
      ${rows.map((t, i) => `<div class="catalog-row" style="--rd:${(i * stepMs).toFixed(1)}ms">
        <div class="id">${escapeHtml(t.id)}</div>
        <div><div class="name">${escapeHtml(t.name)}</div><div class="op">${escapeHtml(t.operation)}</div></div>
        <div class="spec">${escapeHtml(t.specRef)}</div>
        <div class="beh ${escapeHtml(t.behavior)}">${escapeHtml(t.behavior)}</div>
      </div>`).join('')}
    </div>
  `;
  $('#cat-q').addEventListener('input', (e) => { catalogFilter.q = e.target.value; renderCatalog(); });
  $('#cat-mode').addEventListener('change', (e) => { catalogFilter.mode = e.target.value; renderCatalog(); });
  $('#cat-beh').addEventListener('change', (e) => { catalogFilter.behavior = e.target.value; renderCatalog(); });
}

// ---------- Utilities ----------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Boot ----------

window.addEventListener('DOMContentLoaded', async () => {
  // ?view=foo jumps to a specific view on load (used by deep links / QA handoff).
  // Read this FIRST so the view switch happens before any async work.
  const params = new URLSearchParams(location.search);
  const viewParam = params.get('view');
  if (viewParam && document.getElementById('view-' + viewParam)) {
    showView(viewParam);
  }

  $$('.nav').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));
  $('#btn-run').addEventListener('click', startRun);
  $('#btn-load-cfg').addEventListener('click', loadConfigIntoForm);
  $('#config-form').addEventListener('submit', saveConfig);
  $('#btn-regen').addEventListener('click', regenKeys);

  // MAS-312.B: VP-via-QR panel wiring. We bind the form, camera
  // toggle, clear button, and the textarea blur (for preview-on-paste)
  // in the boot block so the panel works the first time the user
  // navigates to it. A short ⌘/Ctrl+↵ shortcut submits the VP when
  // the QR view is active.
  $('#btn-qr-submit')?.addEventListener('click', submitQrVp);
  $('#btn-qr-clear')?.addEventListener('click', clearQrForm);
  $('#btn-qr-scan')?.addEventListener('click', startQrCamera);
  $('#qr-payload')?.addEventListener('blur', () => { renderQrPreview(); });

  // ⌘/Ctrl + ↵ from the Run view triggers the run
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const runView = $('#view-run');
      if (runView && runView.classList.contains('active')) {
        e.preventDefault();
        startRun();
        return;
      }
      const qrView = $('#view-qrvp');
      if (qrView && qrView.classList.contains('active')) {
        e.preventDefault();
        submitQrVp();
      }
    }
  });

  await Promise.all([checkHealth(), loadModes(), loadCredentials(), loadConfigIntoForm()]);

  // Deep-link handling (MAS-143). A ?diff= query takes precedence over
  // ?report=; a ?report= query without diff still loads the report
  // directly into the run panel.
  const diffHandled = await restoreDiffFromUrl();
  if (!diffHandled) {
    const params = new URLSearchParams(window.location.search);
    const reportId = params.get('report');
    if (reportId) {
      try {
        const report = await api.run(reportId);
        const side = $('#run-side');
        side.innerHTML = '';
        renderReportInto(side, report);
        const meta = $('#run-meta');
        if (meta) meta.textContent = `Loaded · ${report.mode}`;
      } catch (e) {
        toast(`Could not open report ${reportId}: ${e.message}`, 'bad');
      }
    }
  }

  // light periodic health check
  setInterval(checkHealth, 20_000);
});
