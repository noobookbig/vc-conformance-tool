/**
 * api.ts — thin client for the v2 HTTP server.
 *
 * Keeps the network surface narrow. Routes that the UI uses:
 *   GET  /api/health
 *   POST /api/runs                              body: { config: string }
 *   GET  /api/runs/:id                          snapshot
 *   GET  /api/runs/:id/report?format=...        full report (json|junit|html)
 *
 * The SSE stream is consumed by useRunStream directly (native EventSource
 * is the right tool — no need to wrap it in fetch).
 *
 * The base URL is resolved relative to the current origin in production.
 * In dev, Vite's proxy forwards /api/* to http://127.0.0.1:8080.
 */

import type {
  CreateRunResponse,
  HealthResponse,
  Report,
  RunSnapshotResponse,
} from './types';

const DEFAULT_BASE = '';

export function getApiBase(): string {
  // Vite injects import.meta.env.BASE_URL; in production this is the
  // server's origin (the SPA is served from /). Allow override via a
  // window-level var for dev trickery.
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __API_BASE__?: string };
    if (w.__API_BASE__) return w.__API_BASE__;
  }
  return DEFAULT_BASE;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore body parse errors; status + statusText are enough
    }
    throw new ApiError(
      `${res.status} ${res.statusText} on ${path}`,
      res.status,
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  createRun(config: string): Promise<CreateRunResponse> {
    return request<CreateRunResponse>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ config }),
    });
  },

  getRun(id: string): Promise<RunSnapshotResponse> {
    return request<RunSnapshotResponse>(`/api/runs/${encodeURIComponent(id)}`);
  },

  getReport(id: string, format: 'json' | 'junit' | 'html' = 'json'): Promise<Report> {
    return request<Report>(`/api/runs/${encodeURIComponent(id)}/report?format=${format}`);
  },

  reportDownloadUrl(id: string, format: 'json' | 'junit' | 'html' = 'json'): string {
    return `${getApiBase()}/api/runs/${encodeURIComponent(id)}/report?format=${format}`;
  },

  /**
   * Per-case evidence log URL (MAS-302). The server returns
   * `text/plain` with a Content-Disposition: attachment header so a
   * click downloads `evidence-<runId>-<caseId>.log`. Browsers that
   * prefer opening inline will still render the body in a new tab.
   */
  evidenceUrl(id: string, caseId: string): string {
    return `${getApiBase()}/api/runs/${encodeURIComponent(id)}/evidence/${encodeURIComponent(caseId)}`;
  },

  eventsUrl(id: string): string {
    return `${getApiBase()}/api/runs/${encodeURIComponent(id)}/events`;
  },
};

/**
 * Build a YAML config string for POST /api/runs.
 * Mirrors the v2 engine's `parseRunConfig` (config.ts) shape so the
 * server never sees a field it doesn't understand.
 */
export function buildConfigYaml(cfg: {
  targetIssuer?: string;
  targetVerifier?: string;
  wallet?: string;
  issuerMetadataUrl?: string;
  credentialConfigurationId?: string;
  useMock?: boolean;
  stopOnError?: boolean;
}): string {
  const lines: string[] = [];
  const push = (k: string, v: string | boolean | undefined): void => {
    if (v === undefined || v === '') return;
    lines.push(`${k}: ${typeof v === 'string' ? v : v ? 'true' : 'false'}`);
  };
  push('targetIssuer', cfg.targetIssuer);
  push('targetVerifier', cfg.targetVerifier);
  push('wallet', cfg.wallet);
  push('issuerMetadataUrl', cfg.issuerMetadataUrl);
  push('credentialConfigurationId', cfg.credentialConfigurationId);
  // The wire-level config doesn't carry "stopOnError" — that is a runner
  // invariant (always true for v2). We intentionally do not emit it.
  push('useMock', cfg.useMock);
  if (lines.length === 0) return 'useMock: true\n';
  return lines.join('\n') + '\n';
}
