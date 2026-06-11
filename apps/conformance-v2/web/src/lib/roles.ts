/**
 * Role taxonomy for the v2 conformance UI.
 *
 * The v2 catalog (`references/testcases/`) classifies every test case by
 * `eut` (Entity Under Test). The CLI `--role issuer|verifier|wallet`
 * filter (see MAS-292) is the source of truth for which EUTs are
 * "walletable" roles. Counts below mirror `eut: <role>` occurrences in
 * the catalog and are kept here so the UI can render the role split
 * without a server roundtrip.
 *
 * `multi` and `resolver` are cross-role scenarios — they stay in the
 * "All" view, not in any of the three primary role chips, matching the
 * CLI's role-filter contract of "one role at a time" (see
 * `apps/conformance-v2/src/catalog/loader.ts`).
 *
 * If the catalog is ever refreshed, the totals here must be updated in
 * the same PR. The numbers are also enforced by a Vitest assertion in
 * `roles.test.ts`.
 */

export type PrimaryRole = 'issuer' | 'verifier' | 'wallet';
export type AnyRole = PrimaryRole | 'multi' | 'resolver';

export const PRIMARY_ROLES: ReadonlyArray<PrimaryRole> = ['issuer', 'verifier', 'wallet'];

export interface RoleMeta {
  /** Stable role key. Matches the `--role` CLI flag for primary roles. */
  key: PrimaryRole;
  /** Human-readable label for UI (English). */
  label: string;
  /** Short caption for chips / badges (≤10 chars). */
  short: string;
  /** Number of catalog cases with `eut: <key>`. */
  count: number;
  /** CSS variable suffix for the role's accent — drives the badge tint. */
  accent: 'cyan' | 'magenta' | 'lime';
  /** One-sentence scope. Shown in the role-detail drawer. */
  description: string;
}

/**
 * Counts as of the v2.0 catalog (317 cases total). These are mirrored in
 * the test suite so an out-of-sync catalog trips a test failure.
 */
export const ROLE_META: Readonly<Record<PrimaryRole, RoleMeta>> = {
  issuer: {
    key: 'issuer',
    label: 'Issuer',
    short: 'Issuer',
    count: 90,
    accent: 'cyan',
    description: 'Conformance against an OID4VCI credential issuer (target role: issuer).',
  },
  verifier: {
    key: 'verifier',
    label: 'Verifier',
    short: 'Verifier',
    count: 26,
    accent: 'magenta',
    description: 'Conformance against an OID4VP presentation verifier (target role: verifier).',
  },
  wallet: {
    key: 'wallet',
    label: 'Wallet',
    short: 'Wallet',
    count: 95,
    accent: 'lime',
    description: 'Wallet-driven cases (eut: holder) — wallet acting against issuer and verifier.',
  },
};

export const TOTAL_LIVE_CASES: number = PRIMARY_ROLES.reduce(
  (acc, r) => acc + ROLE_META[r].count,
  0,
);

import caseRoles from './data/case-roles.json';

/**
 * Look up the role for a case id. Returns `undefined` for cross-role
 * cases (`multi` / `resolver`) or unknown ids so the UI can choose to
 * render a neutral badge or nothing. Source: `references/testcases/`,
 * refreshed by `scripts/refresh-case-roles.sh`.
 */
export function resolveRoleForCase(caseId: string): PrimaryRole | undefined {
  const map = caseRoles as unknown as Record<string, string>;
  const raw = map[caseId];
  if (raw === 'issuer' || raw === 'verifier' || raw === 'wallet') {
    return raw;
  }
  return undefined;
}
