/**
 * Pure helpers for the SPA diff deep-link (MAS-143).
 *
 * URL shape:
 *   ?diff=<leftRunId>,<rightRunId>[&report=<runId>]
 *
 * - <leftRunId> is the pinned-left side of the diff.
 * - <rightRunId> is the run that was diffed against the pin.
 * - <report> is optional. When present, the diff header renders a
 *   "back to report" affordance that links to the original report URL.
 *
 * The query is intentionally compact and copy-pastable so a QA finding
 * like "see the diff between run X and Y" can be shared as a single URL.
 */

const DIFF_KEY = 'diff';
const REPORT_KEY = 'report';
const DIFF_SEP = ',';

function safeId(s) {
  if (typeof s !== 'string') return '';
  // Run ids in this app look like "run-2026-01-01T00-00-00-abc123" or
  // a slugified timestamp. We only allow URL-safe characters and trim
  // anything that could break the query string.
  return s.trim().replace(/[^A-Za-z0-9._-]/g, '');
}

/**
 * Parse the diff + report keys from a search string (the value of
 * window.location.search) or a Location-like object. Returns null fields
 * when the keys are absent, empty, or malformed.
 */
export function readDiffFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const raw = params.get(DIFF_KEY);
  let left = null;
  let right = null;
  if (raw) {
    const parts = raw.split(DIFF_SEP).map(safeId).filter(Boolean);
    if (parts.length >= 2 && parts[0] !== parts[1]) {
      left = parts[0];
      right = parts[1];
    }
  }
  const reportRaw = params.get(REPORT_KEY);
  const report = reportRaw ? safeId(reportRaw) || null : null;
  return { left, right, report };
}

/**
 * Build a new search string that reflects the current diff selection.
 * Preserves any unrelated query keys that were already on the URL.
 * Pass nulls to remove the diff/report keys.
 */
export function writeDiffToSearch(search, selection) {
  const params = new URLSearchParams(search || '');
  params.delete(DIFF_KEY);
  params.delete(REPORT_KEY);
  if (selection && selection.left && selection.right && selection.left !== selection.right) {
    params.set(DIFF_KEY, `${safeId(selection.left)}${DIFF_SEP}${safeId(selection.right)}`);
    if (selection.report) params.set(REPORT_KEY, safeId(selection.report));
  }
  const out = params.toString();
  return out ? `?${out}` : '';
}

/**
 * Convenience: produce the full href string (pathname + new search) for
 * a given current location-like and a selection to apply. Pass an
 * object with { search }.
 */
export function buildHref(loc, selection) {
  const search = (loc && typeof loc.search === 'string') ? loc.search : '';
  const searchPart = writeDiffToSearch(search, selection);
  return `${loc.pathname || '/'}${searchPart}`;
}

// Exported for tests; not part of the URL contract.
export const _internal = { DIFF_KEY, REPORT_KEY, DIFF_SEP, safeId };
