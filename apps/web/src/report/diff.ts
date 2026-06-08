/**
 * Diff helper. Compares two Report objects by test id and produces a
 * "flipped" diff (pass → fail, fail → pass, new, removed).
 *
 * The diff is intentionally small and reviewable: a flat list of test rows
 * with left/right pass state and the request/response evidence from each
 * side, plus a one-line summary for the header.
 */

import type { Report } from '../runners/runner.js';

export type Flip = 'pass-to-fail' | 'fail-to-pass' | 'new-fail' | 'new-pass' | 'removed' | 'unchanged';

export interface DiffRow {
  id: string;
  name: string;
  flip: Flip;
  left: { pass: boolean; message: string; evidence?: Record<string, unknown>; durationMs: number } | null;
  right: { pass: boolean; message: string; evidence?: Record<string, unknown>; durationMs: number } | null;
}

export interface DiffSummary {
  leftRunId: string;
  rightRunId: string;
  passToFail: number;
  failToPass: number;
  newFail: number;
  newPass: number;
  removed: number;
  unchanged: number;
  total: number;
}

export interface RunDiff {
  summary: DiffSummary;
  rows: DiffRow[];
}

function isSkip(message: string): boolean {
  return message.startsWith('SKIPPED');
}

export function diffReports(left: Report, right: Report): RunDiff {
  const leftMap = new Map<string, Report['results'][number]>();
  for (const r of left.results) leftMap.set(r.id, r);
  const rightMap = new Map<string, Report['results'][number]>();
  for (const r of right.results) rightMap.set(r.id, r);

  const ids = new Set<string>([...leftMap.keys(), ...rightMap.keys()]);
  const rows: DiffRow[] = [];
  let p2f = 0, f2p = 0, nFail = 0, nPass = 0, removed = 0, unchanged = 0;

  for (const id of ids) {
    const l = leftMap.get(id);
    const r = rightMap.get(id);
    const name = (l ?? r)!.name;
    if (!l) {
      const flip: Flip = r!.pass ? 'new-pass' : 'new-fail';
      if (flip === 'new-fail') nFail++; else nPass++;
      rows.push({
        id, name, flip,
        left: null,
        right: { pass: r!.pass, message: r!.message, evidence: r!.evidence, durationMs: r!.durationMs },
      });
      continue;
    }
    if (!r) {
      removed++;
      rows.push({
        id, name, flip: 'removed',
        left: { pass: l.pass, message: l.message, evidence: l.evidence, durationMs: l.durationMs },
        right: null,
      });
      continue;
    }
    const lPass = l.pass || isSkip(l.message);
    const rPass = r.pass || isSkip(r.message);
    let flip: Flip = 'unchanged';
    if (lPass && !rPass) { flip = 'pass-to-fail'; p2f++; }
    else if (!lPass && rPass) { flip = 'fail-to-pass'; f2p++; }
    else { unchanged++; }
    rows.push({
      id, name, flip,
      left: { pass: l.pass, message: l.message, evidence: l.evidence, durationMs: l.durationMs },
      right: { pass: r.pass, message: r.message, evidence: r.evidence, durationMs: r.durationMs },
    });
  }

  rows.sort((a, b) => {
    const order: Record<Flip, number> = {
      'pass-to-fail': 0,
      'new-fail': 1,
      'fail-to-pass': 2,
      'new-pass': 3,
      'removed': 4,
      'unchanged': 5,
    };
    return order[a.flip] - order[b.flip] || a.id.localeCompare(b.id);
  });

  return {
    summary: {
      leftRunId: left.runId,
      rightRunId: right.runId,
      passToFail: p2f,
      failToPass: f2p,
      newFail: nFail,
      newPass: nPass,
      removed,
      unchanged,
      total: rows.length,
    },
    rows,
  };
}
