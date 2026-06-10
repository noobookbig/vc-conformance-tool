/**
 * SuiteRoute — the entry point where the operator picks a config and a
 * target, sees a precheck indicator, and clicks Run.
 *
 * `useMock: true` short-circuits the precheck (no target to reach). When
 * the operator has not entered a target, the form starts in mock mode
 * (clearly labelled) so a first-time user can see a working run.
 *
 * The "Continue on error" toggle is intentionally framed as the
 * non-default — stop-on-error is mandatory in v2 and the spec language
 * says so.
 */

import { useState, useCallback, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, buildConfigYaml } from '../lib/api';
import type { HealthResponse } from '../lib/types';

type PrecheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'bad'; reason: string };

export function SuiteRoute(): JSX.Element {
  const nav = useNavigate();
  const [issuerMetadataUrl, setIssuerMetadataUrl] = useState('');
  const [targetIssuer, setTargetIssuer] = useState('');
  const [targetVerifier, setTargetVerifier] = useState('');
  const [wallet, setWallet] = useState('');
  const [credentialConfigurationId, setCredentialConfigurationId] = useState('');
  const [useMock, setUseMock] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);
  const [continueOnError, setContinueOnError] = useState(false);
  const [precheck, setPrecheck] = useState<PrecheckState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  // Probe health on first mount so the operator knows the server is up.
  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const hasAnyTarget = Boolean(
    issuerMetadataUrl || targetIssuer || targetVerifier || wallet,
  );

  const runPrecheck = useCallback(async (): Promise<PrecheckState> => {
    setPrecheck({ kind: 'checking' });
    if (useMock || !hasAnyTarget) {
      setPrecheck({ kind: 'ok' });
      return { kind: 'ok' };
    }
    // The server's precheck runs server-side at run-start; the UI surfaces
    // a lightweight "is the target reachable?" probe so a bad URL is
    // caught at the form level. We do a HEAD/GET against the issuer
    // metadata URL when present, else the issuer URL.
    const probeUrl = issuerMetadataUrl || targetIssuer || targetVerifier || wallet;
    if (!probeUrl) {
      setPrecheck({ kind: 'ok' });
      return { kind: 'ok' };
    }
    try {
      const res = await fetch(probeUrl, { method: 'GET' });
      if (res.ok) {
        setPrecheck({ kind: 'ok' });
        return { kind: 'ok' };
      }
      const reason = `${probeUrl} returned HTTP ${res.status}`;
      setPrecheck({ kind: 'bad', reason });
      return { kind: 'bad', reason };
    } catch (err) {
      const reason = `${probeUrl}: ${(err as Error).message}`;
      setPrecheck({ kind: 'bad', reason });
      return { kind: 'bad', reason };
    }
  }, [useMock, hasAnyTarget, issuerMetadataUrl, targetIssuer, targetVerifier, wallet]);

  const canSubmit =
    !submitting &&
    (useMock || hasAnyTarget) &&
    (precheck.kind === 'ok' || precheck.kind === 'idle');

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Trigger a precheck pass before submit if we never did.
      let pc = precheck;
      if (pc.kind === 'idle') pc = await runPrecheck();
      if (pc.kind === 'bad') {
        setError(`Precheck failed: ${pc.reason}. Fix the target URL or enable "Use in-process mock".`);
        setSubmitting(false);
        return;
      }
      const cfg = buildConfigYaml({
        issuerMetadataUrl: issuerMetadataUrl || undefined,
        targetIssuer: targetIssuer || undefined,
        targetVerifier: targetVerifier || undefined,
        wallet: wallet || undefined,
        credentialConfigurationId: credentialConfigurationId || undefined,
        useMock,
      });
      void stopOnError; // wire-stable: stopOnError is a v2 invariant
      void continueOnError; // (not configurable in v2; reserved for v3)
      const res = await api.createRun(cfg);
      nav(`/runs/${encodeURIComponent(res.id)}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="suite-h">
      <header className="view-header">
        <div>
          <span className="eyebrow">Step 01 · Suite</span>
          <h2 id="suite-h">
            Configure a conformance <em>run.</em>
          </h2>
          <p>
            Pick a target. The precheck probes reachability before the run
            starts; stop-on-error is the default and is mandatory in v2.
          </p>
        </div>
        <span
          className={`precheck ${precheck.kind === 'ok' || (precheck.kind === 'idle' && useMock) ? 'ok' : precheck.kind === 'bad' ? 'bad' : precheck.kind === 'checking' ? 'checking' : ''}`}
          data-testid="precheck-pill"
          role="status"
          title={precheck.kind === 'bad' ? `Precheck failed: ${precheck.reason}` : undefined}
        >
          {precheck.kind === 'idle' && useMock && 'Ready'}
          {precheck.kind === 'idle' && !useMock && 'Precheck not run'}
          {precheck.kind === 'checking' && (
            <>
              <span className="loading" aria-hidden="true" /> Checking…
            </>
          )}
          {precheck.kind === 'ok' && 'Precheck OK'}
          {precheck.kind === 'bad' && (
            <>
              <span className="precheck-icon" aria-hidden="true">!</span>
              Precheck failed
            </>
          )}
        </span>
      </header>

      <form className="panel" onSubmit={onSubmit} data-testid="suite-form">
        <div className="field">
          <label htmlFor="issuerMetadataUrl">Issuer metadata URL</label>
          <input
            id="issuerMetadataUrl"
            type="url"
            placeholder="https://issuer.example/.well-known/openid-credential-issuer"
            value={issuerMetadataUrl}
            onChange={(e) => setIssuerMetadataUrl(e.target.value)}
            data-testid="input-issuerMetadataUrl"
          />
          <span className="help">
            Optional. If set, the precheck probes this URL first.
          </span>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="targetIssuer">Target issuer base URL</label>
            <input
              id="targetIssuer"
              type="url"
              placeholder="https://issuer.example"
              value={targetIssuer}
              onChange={(e) => setTargetIssuer(e.target.value)}
              data-testid="input-targetIssuer"
            />
          </div>
          <div className="field">
            <label htmlFor="targetVerifier">Target verifier base URL</label>
            <input
              id="targetVerifier"
              type="url"
              placeholder="https://verifier.example"
              value={targetVerifier}
              onChange={(e) => setTargetVerifier(e.target.value)}
              data-testid="input-targetVerifier"
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="wallet">Wallet URL</label>
            <input
              id="wallet"
              type="url"
              placeholder="https://wallet.example"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              data-testid="input-wallet"
            />
          </div>
          <div className="field">
            <label htmlFor="credentialConfigurationId">Credential configuration id</label>
            <input
              id="credentialConfigurationId"
              type="text"
              placeholder="ThaiNationalID"
              value={credentialConfigurationId}
              onChange={(e) => setCredentialConfigurationId(e.target.value)}
              data-testid="input-credentialConfigurationId"
            />
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 'var(--s-3)' }}>
          <label className="toggle toggle-primary">
            <input
              type="checkbox"
              checked={useMock}
              onChange={(e) => setUseMock(e.target.checked)}
              data-testid="toggle-usemock"
            />
            <span className="toggle-label">Use in-process mock</span>
            {useMock ? (
              <span className="mock-badge" data-testid="mock-badge">
                mock
              </span>
            ) : null}
          </label>
          <label className="toggle toggle-inactive">
            <input
              type="checkbox"
              checked={stopOnError}
              onChange={(e) => setStopOnError(e.target.checked)}
              disabled
              data-testid="toggle-stopOnError"
            />
            <span className="toggle-label">Stop on error</span>
            <span className="note">(v2 default, always on)</span>
          </label>
          <label className="toggle toggle-inactive">
            <input
              type="checkbox"
              checked={continueOnError}
              onChange={(e) => setContinueOnError(e.target.checked)}
              disabled
              data-testid="toggle-continueOnError"
            />
            <span className="toggle-label">Continue on error</span>
            <span className="note">(not recommended for conformance runs)</span>
          </label>
        </div>
        {useMock ? (
          <p
            className="mock-callout"
            role="note"
            data-testid="mock-callout"
            style={{ marginTop: 'var(--s-2)' }}
          >
            <strong>Demo data only</strong> — uncheck for a real target run.
          </p>
        ) : null}

        <div className="field-row" style={{ marginTop: 'var(--s-4)' }}>
          <button
            type="button"
            className="btn"
            onClick={() => void runPrecheck()}
            disabled={precheck.kind === 'checking' || (!useMock && !hasAnyTarget)}
            data-testid="btn-precheck"
          >
            Run precheck
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            data-testid="btn-run"
          >
            {submitting ? (
              <>
                <span className="loading" aria-hidden="true" /> Starting…
              </>
            ) : (
              'Run conformance'
            )}
          </button>
          {error ? (
            <span className="err" role="alert" data-testid="suite-error">
              {error}
            </span>
          ) : null}
        </div>
      </form>

      <div className="panel">
        <h3>Server status</h3>
        {health ? (
          <p className="hint">
            <code>{health.service}</code> v{health.version} — <strong>{health.status}</strong>
          </p>
        ) : (
          <p className="hint">
            <span className="loading" aria-hidden="true" /> Server unreachable. Check
            the v2 server is running on port 8080.
          </p>
        )}
      </div>
    </section>
  );
}
