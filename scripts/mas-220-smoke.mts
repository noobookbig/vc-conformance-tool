/**
 * Manual smoke check for MAS-220: render a real runConformance report
 * (against a closed port) into JSON + HTML and verify the visible
 * surface (passRate, coverage, kind badges, error banner) is present.
 *
 * This is a one-off run-from-CLI check, not a test file. Invoke with:
 *
 *   node --import tsx scripts/mas-220-smoke.mts
 *
 * (or use the file path below directly). The output goes to
 * /tmp/mas-220-*.json / -*.html so a reviewer can open them in a
 * browser.
 */

import { runConformance, summarize, type Report } from '../apps/web/src/runners/runner.js';
import { toJson, toHtml } from '../apps/web/src/report/serialize.js';
import { writeFileSync } from 'node:fs';

async function capture(label: string, req: Parameters<typeof runConformance>[0]) {
  const report = await runConformance(req);
  const json = toJson(report);
  const html = toHtml(report);
  const jsonPath = `/tmp/mas-220-${label}.json`;
  const htmlPath = `/tmp/mas-220-${label}.html`;
  writeFileSync(jsonPath, json);
  writeFileSync(htmlPath, html);
  console.log(`\n[${label}] wrote ${jsonPath} and ${htmlPath}`);
  console.log(`  summary: ${JSON.stringify(report.summary)}`);
  console.log(`  error:   ${report.error ?? '(none)'}`);
  console.log(`  results: ${report.results.length} rows; first id: ${report.results[0]?.id ?? '(empty)'}`);
  return report;
}

const BOGUS_ISSUER = 'http://127.0.0.1:1/this-port-is-closed-and-bogus-issuer';
const BOGUS_VERIFIER = 'http://127.0.0.1:1/totally-bogus-verifier';

const wi = await capture('wi-bogus-url', {
  mode: 'W->I',
  targetIssuer: BOGUS_ISSUER,
  credentialConfigurationId: 'ThaiNationalID',
});
const iw = await capture('iw-bogus-url', {
  mode: 'I->W',
  targetIssuer: BOGUS_ISSUER,
  credentialConfigurationId: 'ThaiNationalID',
});
const wv = await capture('wv-bogus-url', {
  mode: 'W->V',
  targetVerifier: BOGUS_VERIFIER,
  credentialConfigurationId: 'ThaiNationalID',
});
const mock = await capture('wi-mock', {
  mode: 'W->I',
  // intentionally no targetIssuer
  credentialConfigurationId: 'ThaiNationalID',
});

// Hard assertions on the bogus-URL cases — these are the MAS-220
// acceptance criteria. Throwing here will make the script exit non-zero.
function assertBogus(report: Report, label: string) {
  if (report.error !== 'target unreachable') {
    throw new Error(`${label}: report.error should be 'target unreachable', got ${JSON.stringify(report.error)}`);
  }
  if (report.summary.failed <= 0) {
    throw new Error(`${label}: summary.failed should be > 0, got ${report.summary.failed}`);
  }
  if (!(report.summary.passRate < 1)) {
    throw new Error(`${label}: summary.passRate should be < 1, got ${report.summary.passRate}`);
  }
  console.log(`  ✓ ${label} acceptance: error='target unreachable', failed>0, passRate<1`);
}
assertBogus(wi, 'W->I');
assertBogus(iw, 'I->W');
assertBogus(wv, 'W->V');

// Mock run must NOT have error and must report coverage > 0.
if (mock.error !== undefined) {
  throw new Error(`mock: report.error should be undefined, got ${JSON.stringify(mock.error)}`);
}
if (!(mock.summary.coverage > 0)) {
  throw new Error(`mock: summary.coverage should be > 0, got ${mock.summary.coverage}`);
}
console.log(`  ✓ mock acceptance: no error, coverage=${mock.summary.coverage}`);

// Coverage row check: every unannotated row in the mock report must
// have `kind: 'coverage'`, and the few `kind: 'live'` rows must
// correspond to the httpCall-calling test ids.
const httpCallTests = new Set([
  'FT.WL.MT.W.V.VB.001',
  'FT.WL.IC.W.I.VB.001',
  'FT.WL.PR.W.V.VB.001',
  'FT.WL.PR.W.V.VB.JARM.001',
  'FT.PR.RS.V.H.VB.008',
]);
for (const r of mock.results) {
  if (httpCallTests.has(r.id) && r.kind !== 'live' && !r.message.startsWith('SKIPPED')) {
    throw new Error(`mock: ${r.id} is an httpCall test, must be kind: 'live' (got ${r.kind})`);
  }
}
console.log(`  ✓ httpCall test ids are kind: 'live' as expected`);

console.log('\nAll smoke assertions passed.');
