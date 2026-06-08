/**
 * Convert a `TestResult.evidence` object into a single `curl` command line
 * for the failing test case. Best-effort: if the evidence doesn't have
 * method/url, returns a string explaining that no curl can be built.
 */

interface Evidence {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  request?: { method?: string; url?: string; body?: unknown; headers?: Record<string, string> };
  response?: { status?: number; body?: unknown; headers?: Record<string, string> };
  status?: number;
}

function shellQuote(s: string): string {
  if (!/[^A-Za-z0-9_\-./:=?&%@,+]/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function evidenceToCurl(evidence: Record<string, unknown> | undefined): string | null {
  if (!evidence) return null;
  const e = evidence as Evidence;
  const method = e.method ?? e.request?.method ?? 'GET';
  const url = e.url ?? e.request?.url;
  if (!url) return null;
  const headers = { ...(e.headers ?? {}), ...(e.request?.headers ?? {}) };
  const body = e.body ?? e.request?.body;

  const parts: string[] = ['curl', '-X', method, shellQuote(url)];
  for (const [k, v] of Object.entries(headers)) {
    parts.push('-H', shellQuote(`${k}: ${v}`));
  }
  if (body !== undefined && body !== null) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push('--data-raw', shellQuote(payload));
  }
  if (e.response?.status !== undefined) {
    parts.push('#', `expected status: ${e.response.status}`);
  }
  return parts.join(' ');
}
