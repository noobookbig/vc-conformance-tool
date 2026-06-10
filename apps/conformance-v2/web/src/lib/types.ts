/**
 * Domain types — the v2 web UI's contract with the v2 server.
 *
 * The wire shape here MUST match the server's SseEvent + RunRecord shapes
 * from apps/conformance-v2/src/server.ts. Renaming any of these fields
 * is a contract change that requires updating both sides in the same PR.
 */

export type RunStatus = 'queued' | 'running' | 'completed' | 'aborted' | 'failed';

export type CaseOutcome = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export type SseEventName =
  | 'run.started'
  | 'case.passed'
  | 'case.failed'
  | 'case.skipped'
  | 'run.aborted'
  | 'run.completed';

export interface RunStartedData {
  total: number;
  target?: {
    targetIssuer?: string;
    targetVerifier?: string;
    wallet?: string;
    issuerMetadataUrl?: string;
    credentialConfigurationId?: string;
  };
}

export interface CasePassedData {
  id: string;
  mode: 'live';
  status: 'passed';
  responseStatus?: number;
  responseBody?: unknown;
  durationMs: number;
}

export interface CaseFailedData {
  id: string;
  mode: 'live';
  status: 'failed';
  responseStatus?: number;
  responseBody?: unknown;
  message?: string;
  durationMs: number;
}

export interface CaseSkippedData {
  id: string;
  status: 'skipped';
  message?: string;
}

export interface RunAbortedData {
  abortedAt: string;
  error: string;
  failedCaseId: string;
  status: 'failed';
}

export interface RunCompletedData {
  status: 'completed';
  passed: number;
  failed: number;
  skipped: number;
}

export type SseEventData =
  | ({ name: 'run.started' } & RunStartedData)
  | ({ name: 'case.passed' } & CasePassedData)
  | ({ name: 'case.failed' } & CaseFailedData)
  | ({ name: 'case.skipped' } & CaseSkippedData)
  | ({ name: 'run.aborted' } & RunAbortedData)
  | ({ name: 'run.completed' } & RunCompletedData);

export interface CaseRow {
  id: string;
  name?: string;
  operation?: string;
  outcome: CaseOutcome;
  responseStatus?: number;
  durationMs?: number;
  message?: string;
  responseBody?: unknown;
}

export interface RunState {
  id: string;
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: Record<string, CaseRow>;
  /** Populated when the run aborts. */
  abortedAt?: string;
  abortedError?: string;
  failedCaseId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string | null;
}

export interface ReportResult {
  id: string;
  name?: string;
  operation?: string;
  passed: boolean;
  skipped: boolean;
  message?: string;
  responseStatus?: number;
  responseBody?: unknown;
  durationMs: number;
  mode?: 'live' | 'coverage';
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface Report {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: RunStartedData['target'];
  results: ReportResult[];
  summary: ReportSummary;
  aborted: boolean;
  abortedAt: string | null;
  error?: string;
}

export interface RunSnapshotResponse {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  config?: { target: RunStartedData['target']; useMock?: boolean; verbose?: boolean };
  error: string | null;
  report: Report | null;
}

export interface CreateRunResponse {
  id: string;
  status: RunStatus;
}

export interface HealthResponse {
  status: 'ok' | string;
  service: string;
  version: string;
}

export interface RunConfig {
  targetIssuer?: string;
  targetVerifier?: string;
  wallet?: string;
  issuerMetadataUrl?: string;
  credentialConfigurationId?: string;
  useMock?: boolean;
  /** "Continue on error" toggle. Default true on the wire (stopOnError: true). */
  stopOnError?: boolean;
}

export type CrossMode = 'W→I' | 'I→W' | 'W→V' | 'V→W';

/** Human-readable per-case status. The icon component decides the visual. */
export const STATUS_LABEL: Record<CaseOutcome, string> = {
  pending: 'Pending',
  running: 'Running…',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const STATUS_ICON: Record<CaseOutcome, string> = {
  pending: '·',
  running: '…',
  passed: '✓',
  failed: '!',
  skipped: '–',
};
