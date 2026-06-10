import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, CatalogLoadError } from '../src/catalog/loader.js';
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

describe('loadCatalog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cat-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a directory of YAML files into TestCase[]', () => {
    for (let i = 1; i <= 5; i++) writeCase(dir, makeCase(`CASE-${i}`));
    const cases = loadCatalog(dir);
    expect(cases.map((c) => c.id).sort()).toEqual([
      'CASE-1', 'CASE-2', 'CASE-3', 'CASE-4', 'CASE-5',
    ]);
  });

  it('treats absent "kind" as live (the default)', () => {
    writeCase(dir, makeCase('CASE-1'));
    const cases = loadCatalog(dir);
    expect(cases[0]?.kind).toBe('live');
  });

  it('rejects a catalogue where >50% of cases are coverage', () => {
    for (let i = 1; i <= 4; i++) writeCase(dir, makeCase(`L-${i}`, 'live'));
    for (let i = 1; i <= 6; i++) writeCase(dir, makeCase(`C-${i}`, 'coverage'));
    // 6 of 10 = 60% coverage → reject
    expect(() => loadCatalog(dir)).toThrow(CatalogLoadError);
  });

  it('accepts a catalogue with exactly 50% coverage', () => {
    for (let i = 1; i <= 5; i++) writeCase(dir, makeCase(`L-${i}`, 'live'));
    for (let i = 1; i <= 5; i++) writeCase(dir, makeCase(`C-${i}`, 'coverage'));
    // 5 of 10 = 50% coverage → accept (boundary)
    const cases = loadCatalog(dir);
    expect(cases).toHaveLength(10);
  });

  it('rejects a single-case coverage-only catalogue (100% coverage)', () => {
    writeCase(dir, makeCase('C-1', 'coverage'));
    expect(() => loadCatalog(dir)).toThrow(CatalogLoadError);
  });

  it('error message names the offending coverage ratio', () => {
    for (let i = 1; i <= 2; i++) writeCase(dir, makeCase(`L-${i}`, 'live'));
    for (let i = 1; i <= 8; i++) writeCase(dir, makeCase(`C-${i}`, 'coverage'));
    try {
      loadCatalog(dir);
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogLoadError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/coverage/i);
      expect(msg).toMatch(/80%/);
      expect(msg).toMatch(/rejected/i);
    }
  });

  it('rejects empty catalogues', () => {
    expect(() => loadCatalog(dir)).toThrow(/no test cases/i);
  });

  it('rejects duplicate ids', () => {
    writeCase(dir, makeCase('DUP-A'), 'a.yaml');
    writeCase(dir, makeCase('DUP-B', 'live', { id: 'DUP-A' }), 'b.yaml');
    expect(() => loadCatalog(dir)).toThrow(/duplicate/i);
  });

  it('rejects malformed YAML with a readable error pointing at the file', () => {
    writeFileSync(join(dir, 'bad.yaml'), ':\n: not valid: : :');
    try {
      loadCatalog(dir);
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogLoadError);
      expect((err as Error).message).toMatch(/bad\.yaml/);
    }
  });

  it('ignores non-yaml files in the directory', () => {
    writeCase(dir, makeCase('CASE-1'));
    writeFileSync(join(dir, 'README.md'), '# catalog notes');
    const cases = loadCatalog(dir);
    expect(cases).toHaveLength(1);
  });
});
