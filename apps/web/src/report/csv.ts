/**
 * CSV serializer for conformance reports.
 *
 * Produces a flat spreadsheet that QA can paste into Excel / Sheets:
 *   runId, mode, startedAt, finishedAt, durationMs, targetIssuer, targetVerifier,
 *   credentialConfigurationId, testId, testName, result, testDurationMs, message
 *
 * RFC 4180 quoting: any field containing comma, quote, or newline is wrapped in
 * double quotes; embedded quotes are doubled. \r\n line endings so Excel
 * auto-detects the row break.
 */

import type { Report } from '../runners/runner.js';

const LINE_END = '\r\n';

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(report: Report): string {
  const header = [
    'runId', 'mode', 'startedAt', 'finishedAt', 'durationMs',
    'targetIssuer', 'targetVerifier', 'credentialConfigurationId',
    'testId', 'testName', 'result', 'testDurationMs', 'message',
  ];
  const rows: string[] = [header.map(cell).join(',')];
  for (const r of report.results) {
    const row = [
      report.runId,
      report.mode,
      report.startedAt,
      report.finishedAt,
      report.durationMs,
      report.target.issuer ?? '',
      report.target.verifier ?? '',
      report.target.credentialConfigurationId,
      r.id,
      r.name,
      r.pass ? 'PASS' : (r.message.startsWith('SKIPPED') ? 'SKIPPED' : 'FAIL'),
      r.durationMs,
      r.message,
    ];
    rows.push(row.map(cell).join(','));
  }
  return rows.join(LINE_END) + LINE_END;
}
