/**
 * precheck — the v2 engine's "can we even reach the target?" gate.
 *
 * Returns ok=true when:
 *   - No target URLs are configured (in-process mock mode), OR
 *   - Every configured target responds with a 2xx within the timeout.
 *
 * Returns ok=false with error="target unreachable" when:
 *   - Any target returns 4xx / 5xx (treat as unreachable: the suite
 *     would only collect failures against a broken target), OR
 *   - Any target times out, refuses the connection, or fails DNS.
 *
 * The runner calls precheck BEFORE iterating the catalog. A precheck
 * failure aborts the run with exit code 4 (EXIT_CODES.PRECHECK_FAILED)
 * — this is distinct from a per-case stop-on-error (exit code 3).
 */

import { httpRequest, HttpError } from './http.js';

export interface PrecheckInput {
  targetIssuer?: string;
  targetVerifier?: string;
  /** Optional override for the issuer metadata URL. */
  issuerMetadataUrl?: string;
  /** Wallet URL when the wallet is the target (W→I, W→V modes). */
  wallet?: string;
  /** Per-target timeout in ms. */
  timeoutMs?: number;
}

export interface PrecheckResult {
  ok: boolean;
  error?: 'target unreachable';
  reason?: string;
  failedTarget?: string;
  status?: number;
  durationMs?: number;
}

interface TargetSpec {
  name: string;
  url: string;
}

function listTargets(input: PrecheckInput): TargetSpec[] {
  const out: TargetSpec[] = [];
  if (input.issuerMetadataUrl) out.push({ name: 'issuerMetadataUrl', url: input.issuerMetadataUrl });
  if (input.targetIssuer) {
    out.push({ name: 'targetIssuer', url: input.targetIssuer });
  }
  if (input.targetVerifier) {
    out.push({ name: 'targetVerifier', url: input.targetVerifier });
  }
  if (input.wallet) {
    out.push({ name: 'wallet', url: input.wallet });
  }
  return out;
}

export async function precheck(input: PrecheckInput): Promise<PrecheckResult> {
  const targets = listTargets(input);
  if (targets.length === 0) {
    return { ok: true };
  }
  const timeoutMs = input.timeoutMs ?? 5000;
  for (const t of targets) {
    const start = Date.now();
    try {
      const res = await httpRequest(t.url, { method: 'GET', timeoutMs });
      const durationMs = Date.now() - start;
      if (res.status >= 200 && res.status < 300) continue;
      return {
        ok: false,
        error: 'target unreachable',
        reason: `${t.name} (${t.url}) returned HTTP ${res.status}`,
        failedTarget: t.url,
        status: res.status,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const detail = err instanceof HttpError ? `${err.kind}: ${err.message}` : (err as Error).message;
      return {
        ok: false,
        error: 'target unreachable',
        reason: `${t.name} (${t.url}): ${detail}`,
        failedTarget: t.url,
        durationMs,
      };
    }
  }
  return { ok: true };
}
