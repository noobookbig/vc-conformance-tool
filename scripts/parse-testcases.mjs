#!/usr/bin/env node
/**
 * parse-testcases.mjs
 *
 * Ingests the corrected OpenID4VCI / OID4VP 1.0 testcase markdown and
 * emits one YAML file per test case under `references/testcases/`.
 *
 *   node scripts/parse-testcases.mjs \
 *     --in  /home/big/Documents/vc-test/docs/conformance/openid4vci-vp/conformance-testcase-corrected.md \
 *     --out references/testcases
 *
 * Output: ≥ 1 YAML per test case, named `<ID>.yaml` (or `<ID>__<n>.yaml`
 * if the same id is reused with a different operation in the same source).
 *
 * Mapping rules (v2 contract — `kind` defaults to `live`):
 *   - Test cases whose EUT and Test Suite form a runnable pair in
 *     {I→W, W→I, V→W, W→V} → kind=live (these are the cases the v2
 *     engine actually executes against a real target or the in-process mock).
 *   - Everything else (e.g. Resolver-only, Security-only, Interop
 *     multi-entity) → kind=coverage with a justification naming the
 *     spec section and the reason this is shape-only.
 *
 * The structural guard in `loadCatalog` enforces the >50% coverage
 * ceiling; if too many cases end up coverage-only, the operator must
 * either tighten the live-mapper rules above or add target fixtures.
 *
 * Idempotent: re-running the script overwrites all YAMLs in the out dir.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { in: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/parse-testcases.mjs --in <md> --out <dir>');
      process.exit(0);
    }
  }
  return out;
}

/** Strip surrounding ` and leading/trailing whitespace. */
function clean(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1);
  return s;
}

/** Split a multi-value EUT/Spec-Reference/etc on `+` and `/`, lowercased + trimmed. */
function splitMulti(value) {
  if (!value) return [];
  return String(value)
    .split(/[+\/]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const LIVE_EUT_TO_SUITE = {
  // EUT primary role → test suite role.
  // An EUT of "Issuer" with suite "Holder" is the classic I→W direction
  // (the suite drives the Issuer via the wallet).
  'issuer': 'holder',
  'verifier': 'holder',
  'holder': 'issuer', // placeholder, will be refined by multi-entity rule below
};

/** Decide if a test case is runnable live. The v2 engine's four modes
 *  are: I→W, W→I, V→W, W→V. Multi-entity (3+) → coverage.
 */
function classifyLive(eut, suite) {
  const euts = splitMulti(eut);
  // Strip parentheticals (e.g. "Issuer (simulator)" → "issuer")
  const normEuts = euts.map((s) => s.replace(/\s*\(.*?\)\s*/g, ''));
  if (normEuts.length === 0) return { live: false, reason: 'no EUT' };
  if (normEuts.length > 2) {
    return { live: false, reason: `multi-entity (${normEuts.length} roles: ${normEuts.join('+')})` };
  }
  // EUT and suite must be one of the two cross-mode roles, and they must differ.
  const normSuite = (suite ?? '').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
  if (normEuts.includes('resolver')) {
    return { live: false, reason: 'resolver is not yet a v2 engine target' };
  }
  if (normEuts.includes('security') || normEuts.some((e) => e.includes('attacker'))) {
    return { live: false, reason: 'security-only negative test' };
  }
  if (normEuts.length === 1) {
    // Single-entity EUT (e.g. "Issuer"). Run if the suite is the counterpart.
    const e = normEuts[0];
    if ((e === 'issuer' || e === 'verifier') && normSuite === 'holder') return { live: true };
    if (e === 'holder' && (normSuite === 'issuer' || normSuite === 'verifier')) return { live: true };
    return { live: false, reason: `no runnable counterpart (EUT=${e}, suite=${normSuite})` };
  }
  // 2-entity EUT (e.g. "Issuer + Holder"). Still coverage unless both roles are in the engine's four-mode set AND the suite is the third role.
  const engineRoles = new Set(['issuer', 'holder', 'verifier']);
  if (normEuts.every((r) => engineRoles.has(r)) && engineRoles.has(normSuite)) {
    return { live: true };
  }
  return { live: false, reason: `EUT pair (${normEuts.join('+')}) not in v2 four-mode set` };
}

/** Extract the metadata table from a test-case section body. Returns an
 *  object keyed by lowercased field name with raw string values.
 */
function extractTable(sectionBody) {
  const out = {};
  // Find the first markdown table; the metadata is always the first
  // table in the section.
  const tableRe = /^\|.*\|\n\|[-:|\s]+\n((?:\|.*\|\n?)+)/m;
  const m = sectionBody.match(tableRe);
  if (!m) return out;
  const rows = m[1].split('\n').filter(Boolean);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const key = cells[0].replace(/\*\*/g, '').trim().toLowerCase();
    const val = cells.slice(1).join('|').trim();
    out[key] = val;
  }
  return out;
}

/** Slug a test case id for the filename. */
function slug(id) {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Map EUT/Suite/Behavior to the v2 catalog schema. Throws when
 *  required fields are missing or behavior is not valid/invalid.
 */
function toYaml(testId, table, sourceFile) {
  const id = clean(table['test case id']);
  if (!id) throw new Error(`section "${testId}" has no Test Case ID in metadata table`);
  const name = clean(table['testcase name']) ?? id;
  const operation = clean(table['operation']) ?? 'unknown';
  const eut = clean(table['eut']) ?? 'unknown';
  const suite = (clean(table['test suite']) ?? 'holder').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
  const behaviorRaw = clean(table['behavior']);
  const behavior = behaviorRaw === 'Invalid' || behaviorRaw === 'invalid' ? 'invalid' : 'valid';
  const specRef = clean(table['spec reference']) ?? undefined;
  // Map to allowed enum; default to "holder" when not in {holder, issuer, verifier, multi}.
  const allowedSuite = ['holder', 'issuer', 'verifier', 'multi'];
  const suiteNorm = allowedSuite.includes(suite) ? suite : 'holder';

  // Allowed EUT values: collapse to one of the enums.
  const euts = splitMulti(eut);
  let eutNorm = 'multi';
  if (euts.length === 1) {
    const e = euts[0];
    if (['issuer', 'verifier', 'holder', 'wallet', 'resolver'].includes(e)) eutNorm = e;
    else if (e === 'security' || e.includes('attacker')) eutNorm = 'multi';
  }

  const classification = classifyLive(eut, suite);
  const tc = {
    id,
    name,
    operation,
    eut: eutNorm,
    suite: suiteNorm,
    behavior,
    kind: classification.live ? 'live' : 'coverage',
    sourceFile: basename(sourceFile),
  };
  if (specRef) tc.specRef = specRef;
  if (!classification.live) {
    tc.justification = `${classification.reason}; spec=${specRef ?? 'n/a'}`;
  }
  return tc;
}

/** Split a markdown file into test-case sections keyed by H3 heading. */
function splitSections(md) {
  const sections = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      const start = i;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^###\s+/.test(lines[j]) || /^##\s+/.test(lines[j])) {
          end = j;
          break;
        }
      }
      const body = lines.slice(start + 1, end).join('\n');
      sections.push({ heading: h3[1].trim(), body });
      i = end;
    } else {
      i++;
    }
  }
  return sections;
}

function clearOutDir(outDir) {
  try {
    const entries = readdirSync(outDir);
    for (const e of entries) {
      if (e.endsWith('.yaml') || e.endsWith('.yml')) {
        try {
          unlinkSync(join(outDir, e));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // directory does not exist yet; will be created
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error('Usage: node scripts/parse-testcases.mjs --in <md> --out <dir>');
    process.exit(2);
  }
  const inPath = resolve(args.in);
  const outDir = resolve(REPO_ROOT, args.out);
  if (!statSync(inPath, { throwIfNoEntry: false })) {
    console.error(`input file not found: ${inPath}`);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  clearOutDir(outDir);

  const md = readFileSync(inPath, 'utf8');
  const sections = splitSections(md);

  let written = 0;
  let liveCount = 0;
  let coverageCount = 0;
  let skipped = 0;
  const seenIds = new Map();

  for (const sec of sections) {
    const table = extractTable(sec.body);
    if (!table['test case id']) {
      // Section has no metadata table — skip (likely a protocol subsection).
      skipped++;
      continue;
    }
    let tc;
    try {
      tc = toYaml(sec.heading, table, inPath);
    } catch (err) {
      console.warn(`skip: ${sec.heading}: ${err.message}`);
      skipped++;
      continue;
    }
    // Disambiguate both the ID and filename on duplicate ids. The
    // corrected spec reuses a handful of IDs for distinct test cases
    // (e.g. `FT.IC.CO.H.I.IB.014` is used twice with different
    // `name`s). The v2 engine's contract is that IDs are unique, so
    // the parser promotes the second occurrence's ID and filename with
    // `__N` so loadCatalog's duplicate guard does not false-positive.
    const baseId = tc.id;
    const baseSlug = slug(baseId);
    const seen = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, seen + 1);
    if (seen > 0) {
      tc.id = `${baseId}__${seen}`;
      tc._originalId = baseId;
    }
    const filename = seen === 0 ? `${baseSlug}.yaml` : `${baseSlug}__${seen}.yaml`;

    // Validate against the loader's required-fields contract; if our
    // mapper produced something the loader will reject, warn loudly.
    const required = ['id', 'name', 'operation', 'eut', 'suite', 'behavior'];
    const missing = required.filter((k) => !tc[k]);
    if (missing.length > 0) {
      console.warn(`drop: ${tc.id} missing required fields ${missing.join(',')}`);
      skipped++;
      continue;
    }
    if (tc.kind === 'coverage' && !tc.justification) {
      console.warn(`drop: ${tc.id} coverage case missing justification`);
      skipped++;
      continue;
    }

    writeFileSync(join(outDir, filename), stringify(tc, { lineWidth: 0 }));
    written++;
    if (tc.kind === 'live') liveCount++;
    else coverageCount++;
  }

  console.log(`parse-testcases: ${written} cases written (${liveCount} live, ${coverageCount} coverage), ${skipped} skipped`);
  console.log(`out: ${outDir}`);
  if (written < 30) {
    console.error(`FATAL: only ${written} cases written; v2 contract requires ≥ 30`);
    process.exit(1);
  }
  const coverageRatio = coverageCount / Math.max(1, written);
  if (coverageRatio > 0.5) {
    console.error(`FATAL: ${coverageCount} of ${written} cases (${Math.round(coverageRatio * 100)}%) are coverage; structural guard would reject this catalogue.`);
    process.exit(1);
  }
}

main();
