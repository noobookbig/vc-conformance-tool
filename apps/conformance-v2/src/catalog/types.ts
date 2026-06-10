/**
 * Catalog types — the YAML contract for v2 test cases.
 *
 * A test case is one YAML file under `references/testcases/`. The runner
 * loads them via `loadCatalog(dir)`. The structural guards in loader.ts
 * prevent the v0.1.0 bug class where shape-only `coverage` cases
 * outnumbered real `live` ones and inflated passRate.
 *
 * `kind: live`     — runs against the configured target (issuer / verifier / wallet).
 * `kind: coverage` — runs in-process against a recorded response; the
 *                    target is NOT contacted. Coverage cases must have a
 *                    `justification` string (free-text spec section +
 *                    why this is spec-coverage rather than a live probe).
 */

export type Kind = 'live' | 'coverage';

export type Eut = 'issuer' | 'verifier' | 'wallet' | 'holder' | 'resolver' | 'multi';

export interface TestCase {
  /** Stable id; matches the v2.0 spec IDs (e.g. `FT.IC.AU.I.H.VB.001`). */
  id: string;
  /** Human-readable test case name (from the corrected spec). */
  name: string;
  /** Operation grouping (e.g. `auth`, `token`, `credential`, `presentation`). */
  operation: string;
  /** Entity Under Test. */
  eut: Eut;
  /** Test Suite that drives the EUT. */
  suite: 'holder' | 'issuer' | 'verifier' | 'multi';
  /** Valid / Invalid behavior. */
  behavior: 'valid' | 'invalid';
  /** Default `live` when omitted. */
  kind: Kind;
  /** Required when `kind: coverage`. */
  justification?: string;
  /** Free-form spec reference from the corrected spec. */
  specRef?: string;
  /** Source file in the corrected spec (for traceability). */
  sourceFile?: string;
}
