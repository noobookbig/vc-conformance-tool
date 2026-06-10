/**
 * ReportRoute — the post-run report view.
 *
 * Loads the run's full JSON report on mount. Provides:
 *  - A "summary" panel: passed/failed/skipped/aborted + duration
 *  - Filters: by mode (W→I, I→W, W→V, V→W), by status (passed, failed,
 *    skipped, aborted), free-text id/description
 *  - Download links for report.json, report.junit.xml, report.html —
 *    these point at the same URLs the server exposes and the CLI writes
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { CaseRow } from '../components/CaseRow';
import type { CaseRow as CaseRowData, Report, ReportResult } from '../lib/types';

type Mode = 'W→I' | 'I→W' | 'W→V' | 'V→W' | 'all';
type StatusFilter = 'all' | 'passed' | 'failed' | 'skipped' | 'aborted';

/** Map a report row's id/operation to a cross-mode bucket. The v2 catalog
 *  organizes test cases by their EUT and direction; this gives the UI
 *  a coarse filter without needing the operator to know the catalog
 *  internals.
 */
function rowMode(r: ReportResult): Mode {
  const text = `${r.operation ?? ''} ${r.id}`.toLowerCase();
  // Very small heuristic; the spec's mode is derivable from the
  // holder/issuer/verifier suite + EUT combination. This is good enough
  // for the v2.0.0 first cut; a follow-up issue can add a `mode` field
  // to the catalog types.
  if (text.includes('presentation') || text.includes('oid4vp')) {
    if (text.includes('wallet') || text.includes('holder')) return 'W→V';
    return 'V→W';
  }
  if (text.includes('wallet') || text.includes('holder')) return 'W→I';
  return 'I→W';
}

function rowStatus(r: ReportResult, aborted: boolean): StatusFilter {
  if (r.skipped) return 'skipped';
  if (r.passed) return 'passed';
  // The aborted row is the failing case (the rest were never run).
  if (aborted && r.id && r.message && !r.passed) return 'aborted';
  return 'failed';
}

function toCaseRow(r: ReportResult, aborted: boolean): CaseRowData {
  return {
    id: r.id,
    name: undefined,
    operation: r.operation,
    outcome: r.skipped ? 'skipped' : r.passed ? 'passed' : 'failed',
    responseStatus: r.responseStatus,
    durationMs: r.durationMs,
    message: r.message,
    responseBody: r.responseBody,
  };
}

export function ReportRoute(): JSX.Element {
  const params = useParams();
  const runId = params.id ?? null;
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api
      .getReport(runId, 'json')
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const filtered: ReportResult[] = useMemo(() => {
    if (!report) return [];
    const needle = q.trim().toLowerCase();
    return report.results.filter((r) => {
      const m = rowMode(r);
      if (mode !== 'all' && m !== mode) return false;
      const s = rowStatus(r, report.aborted);
      if (statusFilter !== 'all' && s !== statusFilter) return false;
      if (needle) {
        const hay = `${r.id} ${r.operation ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [report, mode, statusFilter, q]);

  if (error) {
    return (
      <section>
        <header className="view-header">
          <h2>Report unavailable</h2>
        </header>
        <p className="err" role="alert">
          {error}
        </p>
        <Link to="/" className="btn">
          Back to suite
        </Link>
      </section>
    );
  }
  if (!report) {
    return (
      <section>
        <p className="empty">
          <span className="loading" aria-hidden="true" /> Loading report…
        </p>
      </section>
    );
  }

  const abortLabel = report.aborted
    ? `Halted at ${report.abortedAt ?? '?'}`
    : 'Completed';

  return (
    <section aria-labelledby="report-h">
      <header className="view-header">
        <div>
          <span className="eyebrow">Step 03 · Report</span>
          <h2 id="report-h">
            Run report <em>{report.runId}</em>
          </h2>
          <p>
            {abortLabel}. {report.summary.passed}/{report.summary.total} passed in{' '}
            {(report.durationMs / 1000).toFixed(2)}s.
          </p>
        </div>
        <div className="downloads" data-testid="downloads">
          <a
            className="btn"
            href={api.reportDownloadUrl(report.runId, 'json')}
            data-testid="download-json"
            download={`report-${report.runId}.json`}
          >
            Download JSON
          </a>
          <a
            className="btn"
            href={api.reportDownloadUrl(report.runId, 'junit')}
            data-testid="download-junit"
            download={`report-${report.runId}.junit.xml`}
          >
            Download JUnit
          </a>
          <a
            className="btn"
            href={api.reportDownloadUrl(report.runId, 'html')}
            data-testid="download-html"
            download={`report-${report.runId}.html`}
          >
            Download HTML
          </a>
        </div>
      </header>

      <div className="panel">
        <h3>Summary</h3>
        <div className="chip-row" data-testid="summary-chips">
          <span className="chip passed">{report.summary.passed} passed</span>
          <span className="chip failed">{report.summary.failed} failed</span>
          <span className="chip skipped">{report.summary.skipped} skipped</span>
          {report.aborted ? (
            <span className="chip failed">aborted @ {report.abortedAt}</span>
          ) : null}
        </div>

        <div className="filters" data-testid="filters">
          <div className="filter-group">
            <label htmlFor="filter-mode">Mode</label>
            <select
              id="filter-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              data-testid="filter-mode"
            >
              <option value="all">All</option>
              <option value="W→I">W → I (Wallet → Issuer)</option>
              <option value="I→W">I → W (Issuer → Wallet)</option>
              <option value="W→V">W → V (Wallet → Verifier)</option>
              <option value="V→W">V → W (Verifier → Wallet)</option>
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="filter-status">Status</label>
            <select
              id="filter-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              data-testid="filter-status"
            >
              <option value="all">All</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="aborted">Aborted</option>
            </select>
          </div>
          <div className="filter-group" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="filter-q">Search</label>
            <input
              id="filter-q"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="id or operation contains…"
              data-testid="filter-q"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="empty" data-testid="empty-filter">
            No cases match the current filters.
          </p>
        ) : (
          <ul className="case-list" data-testid="case-list">
            {filtered.map((r) => (
              <CaseRow key={r.id} case={toCaseRow(r, report.aborted)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
