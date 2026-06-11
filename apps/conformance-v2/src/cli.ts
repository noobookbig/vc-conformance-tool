/**
 * conformance-v2 CLI entrypoint.
 *
 *   node --import tsx apps/conformance-v2/src/cli.ts run \
 *     --config <yaml> --catalog <dir> --out <dir>
 *
 * Subcommands:
 *   run     — execute the suite against the configured target
 *   parse   — regenerate references/testcases/ from the corrected spec
 *
 * Exit codes (the contract MAS-254 publishes for the Server workstream):
 *   0  full pass
 *   2  partial (skipped only)
 *   3  halted (a real failure triggered stop-on-error)
 *   4  precheck failed (target unreachable)
 *
 * Events are streamed to stderr (so `2>/dev/null` quiets them in CI) and
 * the report files are written to `--out` as `report.json`,
 * `report.junit.xml`, `report.html`.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCatalog, CatalogLoadError, filterCatalogByRole, type Role } from './catalog/loader.js';
import { precheck } from './precheck.js';
import { runConformance, type RunnerEvent, type Report, type CaseRunResult, type RunTarget } from './runner.js';
import { httpRequest, HttpError } from './http.js';
import { AbortCoordinator, EXIT_CODES } from './abort.js';
import { toReportJson, toJunitXml, toReportHtml } from './report/writer.js';
import { loadRunConfig, type RunConfig } from './config.js';
import type { TestCase } from './catalog/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printUsage(): void {
  console.error('Usage:');
  console.error('  conformance-v2 run --config <yaml> --catalog <dir> --out <dir>');
  console.error('                  [--role <issuer|verifier|wallet>] [--include-coverage]');
  console.error('  conformance-v2 parse --in <md> --out <dir>');
  console.error('');
  console.error('Options:');
  console.error('  --role <issuer|verifier|wallet>  Run only the cases whose EUT matches the role.');
  console.error('                                   Default: run every case in the catalog.');
  console.error('  --include-coverage               Include `kind: coverage` cases for the selected');
  console.error('                                   role. Default: live cases only.');
}

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(['issuer', 'verifier', 'wallet']);

/**
 * Parse and validate `--role`. Returns:
 *   - `undefined` when the flag is absent (no filter)
 *   - a valid `Role` when the flag is present and the value is in the
 *     allow-list
 *   - the raw string when the flag is present but the value is invalid
 *     (so the caller can print a precise error)
 *
 * The allow-list is intentionally small and the values are case-folded
 * to lowercase so `Issuer`, `ISSUER`, and `issuer` all work the same.
 */
function parseRoleOpt(args: string[]): { role: Role | undefined; invalid: string | undefined } {
  const raw = getOpt(args, '--role');
  if (raw === undefined) return { role: undefined, invalid: undefined };
  const folded = raw.toLowerCase();
  if (VALID_ROLES.has(folded as Role)) return { role: folded as Role, invalid: undefined };
  return { role: undefined, invalid: raw };
}

interface ParsedArgs {
  cmd: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { cmd: 'help', rest: [] };
  }
  return { cmd: argv[0]!, rest: argv.slice(1) };
}

function getOpt(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v) throw new Error(`flag ${flag} requires a value`);
  return v;
}

/** Build a runCase function that, when no real target is configured,
 *  exercises an in-process mock (the mock lives in the CLI process).
 *  When a real target is configured, it makes one HTTP call per case
 *  and treats a 2xx as passed.
 *
 *  MAS-306 follow-up: every call (real or mock) returns a structured
 *  `evidence` object capturing the request line (method + URL) and
 *  the response side. The CLI's `report.json` and `report.html`
 *  writers surface `evidence` so the operator can confirm what was
 *  actually sent, instead of seeing the legacy
 *  `{"mock": true, "id": "..."}` placeholder. The `responseBody`
 *  field is preserved for backward compatibility.
 */
function makeRunCase(target: RunTarget, useMock: boolean): (tc: TestCase) => Promise<CaseRunResult> {
  if (useMock) {
    return async (tc) => {
      const requestUrl = `<in-process-mock> /case/${encodeURIComponent(tc.id)}`;
      return {
        passed: true,
        responseStatus: 200,
        responseBody: { mock: true, id: tc.id },
        message: 'in-process mock',
        evidence: {
          request: { method: 'GET', url: requestUrl },
          response: {
            status: 200,
            body: {
              mock: true,
              id: tc.id,
              note: 'answered by the in-process mock; no HTTP request was sent',
            },
          },
          mock: true,
        },
      };
    };
  }
  return async (tc) => {
    const baseUrl = target.issuerMetadataUrl ?? target.targetIssuer ?? target.targetVerifier;
    if (!baseUrl) {
      return {
        passed: false,
        message: 'no target configured and useMock is false',
        responseStatus: 0,
        evidence: {
          request: { method: 'GET', url: '(no baseUrl configured)' },
          response: { status: 0, body: { error: 'no target configured' } },
        },
      };
    }
    const requestUrl = `${baseUrl.replace(/\/$/, '')}/case/${encodeURIComponent(tc.id)}`;
    try {
      const res = await httpRequest(requestUrl, {
        method: 'GET',
        timeoutMs: 5000,
      });
      return {
        passed: res.status >= 200 && res.status < 300,
        responseStatus: res.status,
        responseBody: res.body,
        message: res.status >= 200 && res.status < 300 ? 'ok' : `HTTP ${res.status}`,
        evidence: {
          request: { method: 'GET', url: requestUrl },
          response: { status: res.status, headers: res.headers, body: res.body },
        },
      };
    } catch (err) {
      return {
        passed: false,
        message: err instanceof HttpError ? `${err.kind}: ${err.message}` : (err as Error).message,
        responseStatus: 0,
        evidence: {
          request: { method: 'GET', url: requestUrl },
          response: {
            status: 0,
            body: { error: err instanceof HttpError ? `${err.kind}: ${err.message}` : (err as Error).message },
          },
        },
      };
    }
  };
}

async function cmdRun(args: string[]): Promise<number> {
  const configPath = getOpt(args, '--config');
  const catalogDir = getOpt(args, '--catalog');
  const outDir = getOpt(args, '--out');
  if (!configPath || !catalogDir || !outDir) {
    printUsage();
    return 2;
  }
  const { role, invalid: invalidRole } = parseRoleOpt(args);
  if (invalidRole !== undefined) {
    console.error(
      `invalid --role value "${invalidRole}"; must be one of issuer, verifier, wallet`
    );
    return 2;
  }
  const includeCoverage = args.includes('--include-coverage');
  const cfg = loadRunConfig(configPath);
  let cases: TestCase[];
  try {
    cases = loadCatalog(catalogDir);
  } catch (err) {
    if (err instanceof CatalogLoadError) {
      console.error(`catalog error: ${err.message}`);
    } else {
      console.error((err as Error).message);
    }
    return 2;
  }
  if (role !== undefined) {
    const before = cases.length;
    cases = filterCatalogByRole(cases, role, { includeCoverage });
    const after = cases.length;
    console.error(
      `role filter: role=${role} includeCoverage=${includeCoverage} ` +
        `kept=${after} of ${before} catalog cases`
    );
    if (after === 0) {
      console.error(
        `role filter produced an empty run: no ${role} cases in the catalog. ` +
          `Re-run without --role to execute the full suite.`
      );
      // Still write a report so the caller has a non-empty artefact
      // directory and a clear `abortedAt: "empty-role-filter"` record.
      const emptyReport: Report = {
        runId: `r-empty-role-${Date.now().toString(36)}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        target: cfg.target,
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        aborted: true,
        abortedAt: `empty-role-filter:${role}`,
        error: `no ${role} cases in catalog`,
      };
      writeReport(outDir, emptyReport);
      return 2;
    }
  }
  mkdirSync(resolve(outDir), { recursive: true });

  const verbose = cfg.verbose !== false;
  const onEvent = (e: RunnerEvent): void => {
    if (!verbose) return;
    switch (e.type) {
      case 'run.started':
        console.error(`run.started: total=${e.total} target=${JSON.stringify(e.target)}`);
        break;
      case 'case.passed':
        console.error(`case.passed: ${e.id} (${e.durationMs}ms)`);
        break;
      case 'case.failed':
        console.error(`case.failed: ${e.id} status=${e.responseStatus ?? '?'} ${e.message ?? ''}`);
        break;
      case 'case.skipped':
        console.error(`case.skipped: ${e.id} ${e.message ?? ''}`);
        break;
      case 'run.aborted':
        console.error(`run.aborted: at=${e.failedCaseId} reason=${e.reason}`);
        break;
      case 'run.completed':
        console.error(`run.completed: passed=${e.passed} failed=${e.failed} skipped=${e.skipped}`);
        break;
    }
  };

  // Precheck first. A precheck failure is exit code 4, distinct from
  // a per-case stop-on-error (exit 3).
  const pre = await precheck(cfg.target);
  if (!pre.ok) {
    console.error(`precheck failed: ${pre.reason ?? pre.error}`);
    const report: Report = {
      runId: `r-precheck-${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      target: cfg.target,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      aborted: true,
      abortedAt: 'precheck',
      error: pre.error,
    };
    writeReport(outDir, report);
    return EXIT_CODES.PRECHECK_FAILED;
  }

  const abort = new AbortCoordinator();
  const useMock = cfg.useMock === true || (cfg.target.targetIssuer === undefined && cfg.target.targetVerifier === undefined);
  const report = await runConformance({
    catalog: cases,
    runCase: makeRunCase(cfg.target, useMock),
    target: cfg.target,
    emit: onEvent,
    abort,
  });

  writeReport(outDir, report);
  console.error(`wrote ${basename(outDir)}/report.{json,junit.xml,html}`);
  if (report.aborted) return EXIT_CODES.ABORTED;
  if (report.summary.passed > 0 && report.summary.failed === 0 && report.summary.skipped === 0) {
    return EXIT_CODES.PASS;
  }
  if (report.summary.failed === 0 && report.summary.skipped > 0) {
    return EXIT_CODES.SKIPPED_ONLY;
  }
  // Should not reach here for a non-aborted run, but keep the contract
  // honest: any other shape is treated as halted.
  return EXIT_CODES.ABORTED;
}

function writeReport(outDir: string, report: Report): void {
  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(resolve(outDir, 'report.json'), toReportJson(report));
  writeFileSync(resolve(outDir, 'report.junit.xml'), toJunitXml(report));
  writeFileSync(resolve(outDir, 'report.html'), toReportHtml(report));
}

async function cmdParse(args: string[]): Promise<number> {
  const inPath = getOpt(args, '--in');
  const outDir = getOpt(args, '--out');
  if (!inPath || !outDir) {
    printUsage();
    return 2;
  }
  // Delegate to scripts/parse-testcases.mjs by exec-ing it (it has its
  // own argv handling and exit-code contract).
  const { spawn } = await import('node:child_process');
  const scriptPath = resolve(__dirname, '..', '..', '..', 'scripts', 'parse-testcases.mjs');
  return new Promise<number>((resolveP) => {
    const child = spawn(process.execPath, [scriptPath, '--in', inPath, '--out', outDir], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveP(code ?? 0));
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const { cmd, rest } = parseArgs(args);
  switch (cmd) {
    case 'run':
      return cmdRun(rest);
    case 'parse':
      return cmdParse(rest);
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      printUsage();
      return 2;
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

export { main, cmdRun, cmdParse, writeReport };
