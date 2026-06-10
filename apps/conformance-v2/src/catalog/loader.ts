/**
 * loadCatalog — reads a directory of YAML test-case files and returns a
 * validated, deduped, sorted TestCase[].
 *
 * Structural guards (these are the v0.1.0 bug fix):
 *   - empty catalogue → reject
 *   - >50% `coverage` cases → reject (the v0.1.0 harness reported
 *     `passRate: 1` because every shape-only case "passed")
 *   - duplicate ids → reject
 *   - missing required fields → reject
 *
 * `kind` defaults to `live` when omitted in the YAML, because the
 * default in the v2 contract is "actually run this against the target".
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TestCase, Kind, Eut } from './types.js';

export class CatalogLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogLoadError';
  }
}

const REQUIRED_FIELDS = ['id', 'name', 'operation', 'eut', 'suite', 'behavior'] as const;

interface RawCase {
  id?: unknown;
  name?: unknown;
  operation?: unknown;
  eut?: unknown;
  suite?: unknown;
  behavior?: unknown;
  kind?: unknown;
  justification?: unknown;
  specRef?: unknown;
  sourceFile?: unknown;
}

function validateCase(raw: RawCase, file: string): TestCase {
  for (const field of REQUIRED_FIELDS) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).trim() === '') {
      throw new CatalogLoadError(`${file}: missing or empty required field "${field}"`);
    }
  }
  const kind: Kind = raw.kind === 'coverage' ? 'coverage' : 'live';
  if (kind === 'coverage') {
    if (typeof raw.justification !== 'string' || raw.justification.trim() === '') {
      throw new CatalogLoadError(`${file}: kind=coverage requires a non-empty "justification" string`);
    }
  }
  const eut = raw.eut as string;
  const allowedEuts: Eut[] = ['issuer', 'verifier', 'wallet', 'holder', 'resolver', 'multi'];
  if (!allowedEuts.includes(eut as Eut)) {
    throw new CatalogLoadError(`${file}: eut "${eut}" is not one of ${allowedEuts.join(', ')}`);
  }
  const behavior = raw.behavior as string;
  if (behavior !== 'valid' && behavior !== 'invalid') {
    throw new CatalogLoadError(`${file}: behavior must be "valid" or "invalid", got "${behavior}"`);
  }
  const suite = raw.suite as string;
  if (!['holder', 'issuer', 'verifier', 'multi'].includes(suite)) {
    throw new CatalogLoadError(`${file}: suite must be one of holder/issuer/verifier/multi`);
  }
  const tc: TestCase = {
    id: raw.id as string,
    name: raw.name as string,
    operation: raw.operation as string,
    eut: eut as Eut,
    suite: suite as TestCase['suite'],
    behavior: behavior as 'valid' | 'invalid',
    kind,
  };
  if (typeof raw.justification === 'string') tc.justification = raw.justification;
  if (typeof raw.specRef === 'string') tc.specRef = raw.specRef;
  if (typeof raw.sourceFile === 'string') tc.sourceFile = raw.sourceFile;
  return tc;
}

export function loadCatalog(dir: string): TestCase[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new CatalogLoadError(`cannot read catalog directory ${dir}: ${(err as Error).message}`);
  }

  const yamlFiles = entries
    .filter((e) => extname(e).toLowerCase() === '.yaml' || extname(e).toLowerCase() === '.yml')
    .filter((e) => {
      const full = join(dir, e);
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  if (yamlFiles.length === 0) {
    throw new CatalogLoadError(`no test cases found in ${dir}: directory is empty (no .yaml files)`);
  }

  const cases: TestCase[] = [];
  const seen = new Set<string>();
  for (const file of yamlFiles) {
    const full = join(dir, file);
    let raw: unknown;
    try {
      const text = readFileSync(full, 'utf8');
      raw = parseYaml(text);
    } catch (err) {
      throw new CatalogLoadError(`${file}: YAML parse error: ${(err as Error).message}`);
    }
    if (raw === null || raw === undefined) {
      throw new CatalogLoadError(`${file}: empty YAML document`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CatalogLoadError(`${file}: top-level YAML must be a mapping, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
    }
    const tc = validateCase(raw as RawCase, file);
    if (seen.has(tc.id)) {
      throw new CatalogLoadError(`duplicate test case id "${tc.id}" in ${basename(file)}`);
    }
    seen.add(tc.id);
    cases.push(tc);
  }

  const live = cases.filter((c) => c.kind === 'live').length;
  const coverage = cases.length - live;
  // Reject when more than 50% of cases are coverage.
  // The boundary (==50%) is acceptable because a reviewer can still claim
  // the suite is "primarily live"; the threshold is structural, not strict.
  if (cases.length > 0 && coverage * 2 > cases.length) {
    const ratio = Math.round((coverage / cases.length) * 100);
    throw new CatalogLoadError(
      `catalog rejected: ${coverage} of ${cases.length} cases (${ratio}%) are kind=coverage, which is more than 50%. ` +
        `Coverage-only suites hide real-target failures; mix in more live cases or reduce coverage.`
    );
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}
