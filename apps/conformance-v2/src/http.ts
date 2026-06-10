/**
 * httpRequest — minimal HTTP wrapper for the v2 engine.
 *
 * Contract:
 *   - Returns { status, headers, body, contentType, durationMs } on
 *     any response (including 4xx/5xx). The body is parsed as JSON
 *     when content-type says so, otherwise returned as a string.
 *   - Throws `HttpError` on transport failure (timeout, refused, DNS).
 *   - Uses node's built-in fetch (Node 22) with an AbortController for
 *     the timeout. Aborting does NOT throw a hang — fetch rejects with
 *     a DOMException we normalize to HttpError.
 *
 * This is intentionally minimal. The runner is the only caller; we
 * don't need retries, cookies, redirects, or auth here. Add them only
 * when a test case actually needs them.
 */

export class HttpError extends Error {
  readonly cause?: unknown;
  readonly kind: 'timeout' | 'refused' | 'dns' | 'transport' | 'other';
  constructor(message: string, kind: HttpError['kind'] = 'other', cause?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** When true (default), serialize body as JSON and set content-type. */
  jsonBody?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  contentType: string;
  durationMs: number;
}

function classifyError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/aborted|abort/i.test(msg) || /timeout/i.test(msg)) {
    return new HttpError(`request timed out: ${msg}`, 'timeout', err);
  }
  if (/ECONNREFUSED|connection refused/i.test(msg)) {
    return new HttpError(`connection refused: ${msg}`, 'refused', err);
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return new HttpError(`dns failure: ${msg}`, 'dns', err);
  }
  if (/fetch failed|undici|socket hang up/i.test(msg)) {
    return new HttpError(`transport failure: ${msg}`, 'transport', err);
  }
  return new HttpError(`http error: ${msg}`, 'other', err);
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function httpRequest(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    const wantJson = opts.jsonBody !== false;
    if (wantJson) {
      body = JSON.stringify(opts.body);
      if (!('content-type' in headers) && !('Content-Type' in headers)) {
        headers['content-type'] = 'application/json';
      }
    } else {
      body = String(opts.body);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw classifyError(err);
  }
  clearTimeout(timer);
  const durationMs = Date.now() - start;
  const resHeaders = headersToObject(res.headers);
  const contentType = resHeaders['content-type'] ?? '';
  const text = await res.text();
  let parsed: unknown = text;
  if (contentType.includes('application/json') && text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the raw text; the caller's report writer will surface it.
      parsed = text;
    }
  }
  return { status: res.status, headers: resHeaders, body: parsed, contentType, durationMs };
}
