/**
 * RunRoute — the live progress view.
 *
 * Renders:
 *  - StopOnErrorBanner the moment `run.aborted` (or `failed`) fires
 *  - A progress bar (passed + failed + skipped) / total
 *  - One row per case that has resolved, with case.passed → green,
 *    case.failed → red (no false greens), case.skipped → gold
 *  - A live region (aria-live=polite) that announces progress to screen
 *    readers
 *  - When the run is done, a "View report" link to the ReportRoute
 *
 * Role tint: the active role for the header band is derived from the
 * `?role=` query param (set by SuiteRoute when the operator focused a
 * role chip) or, as a fallback, the most-common role across the cases
 * the engine has emitted so far. The selected role is a summary only —
 * every case still gets its own role badge from the case-id map.
 */

import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useRunStream } from '../hooks/useRunStream';
import { CaseRow } from '../components/CaseRow';
import { StopOnErrorBanner } from '../components/StopOnErrorBanner';
import type { CaseRow as CaseRowData } from '../lib/types';
import { PRIMARY_ROLES, ROLE_META, resolveRoleForCase, type PrimaryRole } from '../lib/roles';

function isPrimaryRole(v: string | null): v is PrimaryRole {
  return v === 'issuer' || v === 'verifier' || v === 'wallet';
}

function deriveActiveRole(
  queryRole: string | null,
  cases: Record<string, CaseRowData>,
): PrimaryRole | null {
  if (isPrimaryRole(queryRole)) return queryRole;
  // Fallback: pick the role with the most resolved cases. This keeps
  // the header band informative even when the operator lands on a run
  // URL directly (no SuiteRoute context).
  const counts: Record<PrimaryRole, number> = { issuer: 0, verifier: 0, wallet: 0 };
  for (const id of Object.keys(cases)) {
    const r = resolveRoleForCase(id);
    if (r) counts[r] += 1;
  }
  let best: PrimaryRole | null = null;
  let bestN = -1;
  for (const r of ['issuer', 'verifier', 'wallet'] as PrimaryRole[]) {
    if (counts[r] > bestN) {
      best = r;
      bestN = counts[r];
    }
  }
  return bestN > 0 ? best : null;
}

export function RunRoute(): JSX.Element {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const runId = params.id ?? null;
  const queryRole = searchParams.get('role');
  const { state, status } = useRunStream(runId);

  const orderedCases: CaseRowData[] = useMemo(() => {
    if (!state) return [];
    return Object.values(state.cases).sort((a, b) => a.id.localeCompare(b.id));
  }, [state]);

  const progressPct = state
    ? Math.min(
        100,
        Math.round(
          ((state.passed + state.failed + state.skipped) /
            Math.max(1, state.total)) *
            100,
        ),
      )
    : 0;

  const isTerminal =
    state?.status === 'completed' ||
    state?.status === 'aborted' ||
    state?.status === 'failed';

  const activeRole = deriveActiveRole(queryRole, state?.cases ?? {});

  // Count of cases the engine has emitted per role. Used for the
  // run-role-band stats and to make the per-case filter chips feel
  // concrete. Counts can grow as the run progresses; we recompute on
  // every state change (cheap: a few hundred ids at most).
  const caseCountByRole = useMemo(() => {
    const out: Record<PrimaryRole, number> = { issuer: 0, verifier: 0, wallet: 0 };
    if (!state) return out;
    for (const id of Object.keys(state.cases)) {
      const r = resolveRoleForCase(id);
      if (r) out[r] += 1;
    }
    return out;
  }, [state]);

  // Live filter for the case list (cosmetic; every case is still in
  // the underlying state). Defaults to "all" so the operator sees
  // everything until they deliberately focus a role.
  const [listRoleFilter, setListRoleFilter] = useState<PrimaryRole | 'all'>('all');
  const visibleCases: CaseRowData[] = useMemo(() => {
    if (listRoleFilter === 'all') return orderedCases;
    return orderedCases.filter((c) => resolveRoleForCase(c.id) === listRoleFilter);
  }, [orderedCases, listRoleFilter]);

  // Section role: the role the page is currently "about". Used to tint
  // the header band and the progress fill so the operator can read the
  // dominant role at a glance while a run is in flight.
  return (
    <section
      aria-labelledby="run-h"
      className={activeRole ? `run-view role-active role-${activeRole}` : 'run-view'}
    >
      <header className="view-header">
        <div>
          <span className="eyebrow">Step 02 · Run</span>
          <h2 id="run-h">
            Live run <em>{runId}</em>
          </h2>
          <p>
            Live progress from the v2 engine. The Stop-on-error banner shows
            the moment a real failure halts the suite.
          </p>
        </div>
        <div className="field-row run-header-aside">
          {activeRole ? (
            <span
              className={`role-pill role-${activeRole}`}
              data-testid={`role-pill-${activeRole}`}
              title={`Run focused on the ${ROLE_META[activeRole].label} role`}
            >
              <span className="role-pill-dot" aria-hidden="true" />
              <span className="role-pill-label">Role</span>
              <span className="role-pill-value">{ROLE_META[activeRole].label}</span>
            </span>
          ) : null}
          {isTerminal ? (
            <Link
              to={`/runs/${encodeURIComponent(runId ?? '')}/report`}
              className="btn btn-primary"
              data-testid="link-report"
            >
              View report
            </Link>
          ) : null}
        </div>
      </header>

      {state ? (
        <StopOnErrorBanner state={state} />
      ) : null}

      {activeRole ? (
        <div
          className={`run-role-band run-role-${activeRole}`}
          data-testid="run-role-band"
          aria-label={`Run role summary: ${ROLE_META[activeRole].label}`}
        >
          <span className="run-role-label">Active role</span>
          <span className="run-role-name">{ROLE_META[activeRole].label}</span>
          <span className="run-role-stats">
            {(['issuer', 'verifier', 'wallet'] as PrimaryRole[]).map((r) => (
              <span
                key={r}
                className={`stat-pill ${r === activeRole ? 'role-count' : ''}`}
                data-testid={`run-stat-${r}`}
              >
                {ROLE_META[r].label} · {caseCountByRole[r]}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      <div className="progress" aria-hidden={status === 'open' ? 'false' : 'true'}>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct}>
          <span
            className={activeRole ? `is-role-${activeRole}` : ''}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="label">
          {state
            ? `${state.passed} passed · ${state.failed} failed · ${state.skipped} skipped · ${state.total} total`
            : 'Connecting…'}
        </span>
      </div>

      {/* Live region: announces progress to assistive tech. */}
      <div
        className="live-sr"
        aria-live="polite"
        aria-atomic="true"
        data-testid="run-live"
      >
        {state
          ? `Run ${state.id}: ${state.status}. ${state.passed} passed, ${state.failed} failed, ${state.skipped} skipped of ${state.total}.`
          : 'Connecting to run stream.'}
      </div>

      {orderedCases.length === 0 ? (
        <p className="empty" data-testid="run-empty">
          {status === 'open' ? 'Awaiting first case event…' : 'Connecting to event stream…'}
        </p>
      ) : (
        <>
          <div
            className="role-chips role-chips-compact"
            role="tablist"
            aria-label="Filter case list by role"
            data-testid="run-role-filter"
          >
            <button
              type="button"
              role="tab"
              aria-selected={listRoleFilter === 'all'}
              className={`role-chip role-chip-all ${listRoleFilter === 'all' ? 'is-active' : ''}`}
              onClick={() => setListRoleFilter('all')}
              data-testid="run-role-filter-all"
            >
              <span className="role-chip-label">All</span>
              <span className="role-chip-count">{orderedCases.length}</span>
              <span className="role-chip-caption">emitted</span>
            </button>
            {PRIMARY_ROLES.map((r) => {
              const meta = ROLE_META[r];
              const isActive = listRoleFilter === r;
              return (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`role-chip role-chip-${r} ${isActive ? 'is-active' : ''}`}
                  onClick={() => setListRoleFilter(r)}
                  data-testid={`run-role-filter-${r}`}
                >
                  <span className="role-chip-glow" aria-hidden="true" />
                  <span className="role-chip-label">{meta.label}</span>
                  <span className="role-chip-count">{caseCountByRole[r]}</span>
                  <span className="role-chip-caption">cases</span>
                </button>
              );
            })}
          </div>
          {visibleCases.length === 0 ? (
            <p className="empty" data-testid="run-empty-filtered">
              No emitted cases match this role yet.
            </p>
          ) : (
            <ul className="case-list" data-testid="case-list">
              {visibleCases.map((c) => (
                <CaseRow key={c.id} case={c} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
