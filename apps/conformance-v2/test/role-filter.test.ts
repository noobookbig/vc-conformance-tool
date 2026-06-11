/**
 * Role filter — partition the loaded catalog by Entity Under Test so each
 * role's conformance run targets only its own cases while preserving
 * the four protocol pairings (Issuer↔Wallet, Verifier↔Wallet,
 * Wallet↔Issuer, Wallet↔Verifier).
 *
 * The filter is a thin post-load step. `loadCatalog` itself stays
 * un-filtered so the structural guards (empty dir, >50% coverage,
 * duplicate ids) run on the full set.
 *
 * Spec (per the 15:45Z resume comment on MAS-292):
 *   - `--role=issuer`   → `kind: live` AND `eut === 'issuer'`
 *   - `--role=verifier` → `kind: live` AND `eut === 'verifier'`
 *   - `--role=wallet`   → `kind: live` AND `eut === 'holder'`
 *                          (the catalog uses `holder` as the EUT for wallet-driven
 *                          cases; there is no case with `eut === 'wallet'` today)
 *   - default (no role) → no filter; every case that runs today still runs.
 *   - `--include-coverage` → include `kind: coverage` cases for the selected role
 *                          in addition to the default `kind: live` set.
 *
 * The `eut === 'multi'` cases (live + coverage) are not picked up by
 * any of the three role filters; they remain a future pair (e.g. an
 * "all roles" filter) and are not lost — the un-filtered default run
 * still executes them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, filterCatalogByRole } from '../src/catalog/loader.js';
import type { TestCase } from '../src/catalog/types.js';

function makeCase(id: string, kind: 'live' | 'coverage' = 'live', extra: Partial<TestCase> = {}): TestCase {
  const base: TestCase = {
    id,
    name: `Test ${id}`,
    operation: 'auth',
    eut: 'issuer',
    suite: 'holder',
    behavior: 'valid',
    kind,
  };
  if (kind === 'coverage') base.justification = 'spec §x.y — covered by recorded response';
  return { ...base, ...extra };
}

function writeCase(dir: string, tc: TestCase, fileName?: string): void {
  const { stringify } = require('yaml') as typeof import('yaml');
  writeFileSync(join(dir, fileName ?? `${tc.id}.yaml`), stringify(tc));
}

describe('filterCatalogByRole', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters to live issuer cases when role=issuer', () => {
    writeCase(dir, makeCase('I-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('I-2', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('V-1', 'live', { eut: 'verifier' }));
    writeCase(dir, makeCase('H-1', 'live', { eut: 'holder' }));
    writeCase(dir, makeCase('I-COV-1', 'coverage', { eut: 'issuer' }));
    const all = loadCatalog(dir);
    const issuer = filterCatalogByRole(all, 'issuer');
    expect(issuer.map((c) => c.id).sort()).toEqual(['I-1', 'I-2']);
  });

  it('filters to live verifier cases when role=verifier', () => {
    writeCase(dir, makeCase('V-1', 'live', { eut: 'verifier' }));
    writeCase(dir, makeCase('I-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('V-COV-1', 'coverage', { eut: 'verifier' }));
    const all = loadCatalog(dir);
    const verifier = filterCatalogByRole(all, 'verifier');
    expect(verifier.map((c) => c.id)).toEqual(['V-1']);
  });

  it('filters to live holder (wallet) cases when role=wallet', () => {
    writeCase(dir, makeCase('H-1', 'live', { eut: 'holder' }));
    writeCase(dir, makeCase('H-2', 'live', { eut: 'holder' }));
    writeCase(dir, makeCase('I-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('V-1', 'live', { eut: 'verifier' }));
    writeCase(dir, makeCase('H-COV-1', 'coverage', { eut: 'holder' }));
    const all = loadCatalog(dir);
    const wallet = filterCatalogByRole(all, 'wallet');
    expect(wallet.map((c) => c.id).sort()).toEqual(['H-1', 'H-2']);
  });

  it('drops coverage cases by default; --include-coverage=true keeps them', () => {
    // Use 2 live + 2 coverage so the loader's >50% structural guard accepts
    // the fixture (1 live + 2 coverage would be 67% and trip the guard,
    // which is a feature of the loader, not the role filter).
    writeCase(dir, makeCase('I-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('I-2', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('I-COV-1', 'coverage', { eut: 'issuer' }));
    writeCase(dir, makeCase('I-COV-2', 'coverage', { eut: 'issuer' }));
    const all = loadCatalog(dir);
    expect(filterCatalogByRole(all, 'issuer').map((c) => c.id).sort()).toEqual(['I-1', 'I-2']);
    expect(filterCatalogByRole(all, 'issuer', { includeCoverage: true }).map((c) => c.id).sort()).toEqual([
      'I-1',
      'I-2',
      'I-COV-1',
      'I-COV-2',
    ]);
  });

  it('returns an empty list for a role with no matching cases (does not throw)', () => {
    writeCase(dir, makeCase('I-1', 'live', { eut: 'issuer' }));
    const all = loadCatalog(dir);
    expect(filterCatalogByRole(all, 'verifier')).toEqual([]);
    expect(filterCatalogByRole(all, 'wallet')).toEqual([]);
  });

  it('preserves the loader\'s id-sorted order on the filtered subset', () => {
    writeCase(dir, makeCase('Z-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('A-1', 'live', { eut: 'issuer' }));
    writeCase(dir, makeCase('M-1', 'live', { eut: 'issuer' }));
    const all = loadCatalog(dir);
    const issuer = filterCatalogByRole(all, 'issuer');
    expect(issuer.map((c) => c.id)).toEqual(['A-1', 'M-1', 'Z-1']);
  });
});

/**
 * Integration test against the real shipped catalog. These counts are
 * the public contract for the role-filter feature: 90 issuer, 27
 * verifier, 95 wallet (holder). If the corrected spec is regenerated
 * and the counts change, this test should be updated to match the
 * new spec — and the CHANGELOG should call out the count change.
 *
 * Path is the in-repo catalog (the same one the v2 engine loads by
 * default in the README example).
 */
describe('filterCatalogByRole — real shipped catalog', () => {
  const catalogDir = join(process.cwd(), 'references', 'testcases');
  let cases: TestCase[];

  // Lazy-load once; the test set is large enough that reloading per
  // test would dominate vitest's runtime.
  beforeEach(() => {
    cases = loadCatalog(catalogDir);
  });

  it('ships exactly 90 live issuer cases, 27 live verifier cases, 95 live holder (wallet) cases', () => {
    const liveIssuer = cases.filter((c) => c.kind === 'live' && c.eut === 'issuer').length;
    const liveVerifier = cases.filter((c) => c.kind === 'live' && c.eut === 'verifier').length;
    const liveHolder = cases.filter((c) => c.kind === 'live' && c.eut === 'holder').length;
    expect(liveIssuer).toBe(90);
    expect(liveVerifier).toBe(27);
    expect(liveHolder).toBe(95);
  });

  it('role=issuer returns the 90 live issuer cases; no other roles leak in', () => {
    const issuer = filterCatalogByRole(cases, 'issuer');
    expect(issuer).toHaveLength(90);
    for (const tc of issuer) {
      expect(tc.kind).toBe('live');
      expect(tc.eut).toBe('issuer');
    }
  });

  it('role=verifier returns the 27 live verifier cases; no other roles leak in', () => {
    const verifier = filterCatalogByRole(cases, 'verifier');
    expect(verifier).toHaveLength(27);
    for (const tc of verifier) {
      expect(tc.kind).toBe('live');
      expect(tc.eut).toBe('verifier');
    }
  });

  it('role=wallet returns the 95 live holder cases; no other roles leak in', () => {
    const wallet = filterCatalogByRole(cases, 'wallet');
    expect(wallet).toHaveLength(95);
    for (const tc of wallet) {
      expect(tc.kind).toBe('live');
      expect(tc.eut).toBe('holder');
    }
  });

  it('role filter sum (90+27+95 = 212) leaves multi + coverage cases for the default run', () => {
    const issuer = filterCatalogByRole(cases, 'issuer');
    const verifier = filterCatalogByRole(cases, 'verifier');
    const wallet = filterCatalogByRole(cases, 'wallet');
    const roleTotal = issuer.length + verifier.length + wallet.length;
    const multi = cases.filter((c) => c.kind === 'live' && c.eut === 'multi').length;
    expect(roleTotal).toBe(212);
    expect(multi).toBe(6);
    // The default (un-filtered) run still executes everything.
    expect(cases.length).toBe(318);
  });
});

/**
 * CLI smoke: the --role and --include-coverage flags must thread from
 * argv through cmdRun to the runner. We mock the loader + runner so the
 * test stays an integration test of the CLI plumbing, not a re-test of
 * the loader or the runner.
 */
describe('cmdRun --role flag', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // We test by invoking the real cli via a child process; vitest's
  // module-level mocks would pull loadCatalog into the cli module graph
  // and make this brittle. The CLI is small and the surface is
  // observable through stderr + the runner input.

  it('prints an error and exits 2 on an invalid --role value', async () => {
    const { spawn } = await import('node:child_process');
    const cliPath = join(process.cwd(), 'apps', 'conformance-v2', 'src', 'cli.ts');
    const tmpConfig = join(dir, 'cfg.yaml');
    writeFileSync(tmpConfig, 'useMock: true\n');
    let stderr = '';
    const code: number = await new Promise((resolveP) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'run',
        '--config', tmpConfig,
        '--catalog', join(process.cwd(), 'references', 'testcases'),
        '--out', join(dir, 'out'),
        '--role', 'bogus',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      child.on('exit', (c) => resolveP((c ?? 0) as number));
    });
    // We don't have the role validator yet, so the test is RED until the CLI
    // is wired. Once wired, expect exit 2 and a clear error message.
    expect(code).toBe(2);
    expect(stderr).toMatch(/role/i);
  });
});
