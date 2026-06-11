/**
 * MAS-312.A: catalog round-trip test for the new VP-via-QR case.
 *
 * Loads the real `references/testcases/` directory end-to-end and
 * asserts the new test case is present, well-formed, and survives
 * the loader's >50% coverage structural guard. This is the
 * contract the v2 CLI + v2 server depend on when they boot a
 * suite that includes the new endpoint case.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadCatalog, filterCatalogByRole } from '../src/catalog/loader.js';

const CATALOG_DIR = resolve(process.cwd(), 'references', 'testcases');

describe('MAS-312.A: catalog case for VP-via-QR submission', () => {
  it('loads the repo catalog and finds the new IT.PV.AU.H.V.VB.QRP.001 case', () => {
    const cases = loadCatalog(CATALOG_DIR);
    const tc = cases.find((c) => c.id === 'IT.PV.AU.H.V.VB.QRP.001');
    expect(tc).toBeDefined();
    expect(tc?.kind).toBe('live');
    expect(tc?.eut).toBe('verifier');
    expect(tc?.suite).toBe('verifier');
    expect(tc?.behavior).toBe('valid');
    expect(tc?.operation).toMatch(/Present VP/);
    expect(tc?.specRef).toMatch(/OID4VP 1\.0/);
  });

  it('survives the >50% coverage guard and is picked up by the verifier role filter', () => {
    const cases = loadCatalog(CATALOG_DIR);
    const coverage = cases.filter((c) => c.kind === 'coverage').length;
    expect(coverage * 2).toBeLessThanOrEqual(cases.length);
    const verifier = filterCatalogByRole(cases, 'verifier');
    expect(verifier.find((c) => c.id === 'IT.PV.AU.H.V.VB.QRP.001')).toBeDefined();
  });
});
