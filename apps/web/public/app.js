/**
 * SPA logic. No framework, no build step.
 * Communicates with the Fastify API at /api/*.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
  async catalog() { return (await fetch('/api/catalog')).json(); },
};

// ---------- View switching ----------

function showView(name) {
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') renderHistory();
  if (name === 'catalog') renderCatalog();
  if (name === 'config') renderConfig();
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
  const { modes, totalTests } = await api.modes();
  $('#catalog-count', document) ?? null;  // noop
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
}

function renderReportInto(panel, report) {
  const passPct = (report.summary.passRate * 100).toFixed(1);
  panel.innerHTML = `
    <div class="report-head">
      <h3>${escapeHtml(report.runId)} <span class="dim mono" style="font-size:0.85rem">· ${escapeHtml(report.mode)}</span></h3>
      <div class="report-actions">
        <a class="ghost" style="display:inline-block;padding:0.45rem 0.8rem;border:1px solid var(--line);border-radius:8px;color:var(--ink);" href="/api/runs/${encodeURIComponent(report.runId)}/report.json" download>↓ JSON</a>
        <a class="ghost" style="display:inline-block;padding:0.45rem 0.8rem;border:1px solid var(--line);border-radius:8px;color:var(--ink);" href="/api/runs/${encodeURIComponent(report.runId)}/report.html" download>↓ HTML</a>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${report.summary.total}</div><div class="l">Tests</div></div>
      <div class="kpi passed"><div class="v">${report.summary.passed}</div><div class="l">Passed</div></div>
      <div class="kpi failed"><div class="v">${report.summary.failed}</div><div class="l">Failed</div></div>
      <div class="kpi"><div class="v">${escapeHtml(passPct)}%</div><div class="l">Pass rate</div></div>
    </div>
    <table class="results-table">
      <thead><tr><th></th><th>Test ID</th><th>Name</th><th>Result</th><th class="dur">Dur</th></tr></thead>
      <tbody>
        ${report.results.map((r) => {
          const cls = r.message.startsWith('SKIPPED') ? 'skip' : (r.pass ? 'pass' : 'fail');
          const icon = cls === 'skip' ? '⏭️' : (cls === 'pass' ? '✅' : '❌');
          const ev = r.evidence ? `<details><summary>evidence</summary><pre>${escapeHtml(JSON.stringify(r.evidence, null, 2))}</pre></details>` : '';
          return `<tr class="${cls}">
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
  btn.disabled = true;
  btn.textContent = 'Running…';

  const body = {
    mode: $('#run-mode').value,
    credentialConfigurationId: $('#run-credential').value,
    targetIssuer: $('#run-issuer').value || undefined,
    targetVerifier: $('#run-verifier').value || undefined,
  };

  const side = $('#run-side');
  side.innerHTML = `<div class="dim">Running conformance…</div><div class="log" id="run-log"></div>`;

  try {
    const report = await api.startRun(body);
    renderReportInto(side, report);
    toast(`Run complete · ${report.summary.passed}/${report.summary.total} passed`, report.summary.failed === 0 ? 'ok' : 'bad');
  } catch (e) {
    side.innerHTML = `<div class="empty">Run failed: ${escapeHtml(e.message)}</div>`;
    toast(`Run failed: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run conformance';
    inFlight = false;
  }
}

// ---------- Config view ----------

async function renderConfig() {
  const c = await api.config();
  const f = $('#config-form');
  f.mode.value = c.mode;
  f.credentialConfigurationId.value = c.credentialConfigurationId;
  f.targetIssuer.value = c.targetIssuer ?? '';
  f.targetVerifier.value = c.targetVerifier ?? '';
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
  toast('Config saved', 'ok');
}

async function regenKeys() {
  await api.regenKeys();
  await renderKeys();
  toast('New wallet keys generated', 'ok');
}

// ---------- History view ----------

async function renderHistory() {
  const list = $('#history-list');
  const { runs } = await api.runs();
  if (!runs.length) { list.textContent = 'No runs yet.'; return; }
  list.innerHTML = runs.map((r) => {
    const p = r.summary.passed, f = r.summary.failed;
    return `<div class="history-row" data-id="${escapeHtml(r.runId)}">
      <div class="id">${escapeHtml(r.runId)}</div>
      <div class="mode">${escapeHtml(r.mode)}</div>
      <div class="dim mono" style="font-size:0.78rem">${escapeHtml(new Date(r.startedAt).toLocaleString())}</div>
      <div class="stats"><span class="ok">${p}✓</span><span class="bad">${f}✗</span></div>
      <div class="dim mono" style="font-size:0.78rem">${r.durationMs} ms</div>
      <div class="dim mono" style="font-size:0.78rem">${escapeHtml(r.target.credentialConfigurationId)}</div>
    </div>`;
  }).join('');
  $$('.history-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const report = await api.run(row.dataset.id);
      showView('run');
      const side = $('#run-side');
      side.innerHTML = '';
      renderReportInto(side, report);
    });
  });
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
      <span class="dim" style="align-self:center;margin-left:0.5rem">${rows.length} of ${catalogData.tests.length}</span>
    </div>
    <div>
      ${rows.map((t) => `<div class="catalog-row">
        <div class="id">${escapeHtml(t.id)}</div>
        <div><div class="name">${escapeHtml(t.name)}</div><div class="dim" style="font-size:0.78rem">${escapeHtml(t.operation)}</div></div>
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
  $$('.nav').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));
  $('#btn-run').addEventListener('click', startRun);
  $('#btn-load-cfg').addEventListener('click', loadConfigIntoForm);
  $('#config-form').addEventListener('submit', saveConfig);
  $('#btn-regen').addEventListener('click', regenKeys);

  await Promise.all([checkHealth(), loadModes(), loadCredentials(), loadConfigIntoForm()]);

  // light periodic health check
  setInterval(checkHealth, 20_000);
});
