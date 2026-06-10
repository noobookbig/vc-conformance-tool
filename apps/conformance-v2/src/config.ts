/**
 * Run-config loader — shared by the v2 CLI and the v2 HTTP server.
 *
 * The YAML shape is intentionally tiny:
 *
 *   targetIssuer: https://issuer.example
 *   targetVerifier: https://verifier.example
 *   wallet: https://wallet.example
 *   issuerMetadataUrl: https://issuer.example/.well-known/openid-credential-issuer
 *   credentialConfigurationId: ThaiNationalID
 *   useMock: true|false
 *   verbose: true|false
 *
 * We hand-roll the reader to keep startup fast and avoid a YAML dep in the
 * server hot path. The same parser is used by `cli.ts` so the contract
 * the UI workstream and the CLI ship is identical.
 *
 * `loadRunConfig` is the only export. Errors are thrown as plain Error with
 * a stable message; callers (CLI, server) translate to their own error
 * shape (exit 2 / HTTP 400).
 */

import { readFileSync, existsSync } from 'node:fs';
import type { RunTarget } from './runner.js';

export interface RunConfig {
  target: RunTarget;
  /** When true, the runner uses an in-process mock and never touches a real target. */
  useMock?: boolean;
  /** When true, the CLI logs every event to stderr. Ignored by the server. */
  verbose?: boolean;
}

export class RunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export function loadRunConfig(path: string): RunConfig {
  if (!existsSync(path)) {
    throw new RunConfigError(`config file not found: ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  return parseRunConfig(text);
}

/** Parse a YAML config string. Used by the server (config comes over HTTP,
 *  not from a file) and by loadRunConfig (file path).
 */
export function parseRunConfig(text: string): RunConfig {
  const target: RunTarget = {};
  let useMock: boolean | undefined;
  let verbose: boolean | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || !line.includes(':')) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (
      key === 'targetIssuer' ||
      key === 'targetVerifier' ||
      key === 'wallet' ||
      key === 'issuerMetadataUrl'
    ) {
      target[key] = value;
    } else if (key === 'credentialConfigurationId') {
      target.credentialConfigurationId = value;
    } else if (key === 'useMock') {
      useMock = value === 'true';
    } else if (key === 'verbose') {
      verbose = value === 'true';
    } else {
      // Unknown key: surface a clear error so typos in the YAML don't
      // silently drop a target URL.
      throw new RunConfigError(`unknown config key: "${key}"`);
    }
  }
  return { target, useMock, verbose };
}
