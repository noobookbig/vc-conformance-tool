/**
 * SuiteRoute — the entry point where the operator picks a config, sees
 * the role split across the v2 catalog, and clicks Run.
 *
 * `useMock: true` short-circuits the precheck (no target to reach). When
 * the operator has not entered a target, the form starts in mock mode
 * (clearly labelled) so a first-time user can see a working run.
 *
 * The "Continue on error" toggle is intentionally framed as the
 * non-default — stop-on-error is mandatory in v2 and the spec language
 * says so.
 *
 * Role split: the catalog chips above the form (Issuer / Verifier /
 * Wallet) show the live count per role and let the operator surface
 * which role a run will exercise. Selecting a chip is purely cosmetic
 * on the UI side — the CLI is the source of truth (see MAS-292).
 *
 * Entity-driven endpoint (MAS-302, v2.1): the "Endpoint" field is
 * labeled against the entity under test (Issuer / Verifier / Wallet).
 * There is no separate "verifier" textbox — the verifier endpoint is
 * the same field, just relabeled when the entity flips. The wallet URL
 * is shown alongside the entity endpoint for the cross-modes
 * ("Issuer with wallet", "Verifier with wallet"); when the entity is
 * Wallet itself, the wallet URL collapses into the single endpoint
 * field to avoid two textboxes with the same value. The
 * `data-testid` and `<label for>` on the entity endpoint switch
 * with the entity selector so existing test surfaces that key off
 * `input-issuerMetadataUrl` (MAS-260) keep working.
 */

import { useState, useCallback, useEffect, useMemo, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, buildConfigYaml } from '../lib/api';
import type { HealthResponse } from '../lib/types';
import { PRIMARY_ROLES, ROLE_META, type PrimaryRole } from '../lib/roles';

type PrecheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'bad'; reason: string };

/** Entity under test — drives the endpoint field label. */
type EntityUnderTest = 'issuer' | 'verifier' | 'wallet';

interface EntitySpec {
  key: EntityUnderTest;
  label: string;
  /** Short caption shown next to the endpoint input. */
  caption: string;
  /** Endpoint placeholder, e.g. `https://issuer.example`. */
  placeholder: string;
  /** YAML key on the run config this endpoint maps to. */
  yamlKey: 'targetIssuer' | 'targetVerifier' | 'wallet';
  /** CSS role class for the small badge. */
  roleClass: PrimaryRole;
}

const ENTITY_SPEC: Record<EntityUnderTest, EntitySpec> = {
  issuer: {
    key: 'issuer',
    label: 'Issuer',
    caption: 'Issuer endpoint',
    placeholder: 'https://issuer.example',
    yamlKey: 'targetIssuer',
    roleClass: 'issuer',
  },
  verifier: {
    key: 'verifier',
    label: 'Verifier',
    caption: 'Verifier endpoint',
    placeholder: 'https://verifier.example',
    yamlKey: 'targetVerifier',
    roleClass: 'verifier',
  },
  wallet: {
    key: 'wallet',
    label: 'Wallet',
    caption: 'Wallet endpoint',
    placeholder: 'https://wallet.example',
    yamlKey: 'wallet',
    roleClass: 'wallet',
  },
};

/** "Issuer with wallet" / "Verifier with wallet" / "Wallet alone" —
 *  derived from the entity + the wallet URL field. */
function describeEntityMode(
  entity: EntityUnderTest,
  walletUrl: string,
): string {
  if (entity === 'wallet') return 'Wallet alone';
  if (walletUrl.trim()) return `${ENTITY_SPEC[entity].label} with wallet`;
  return `${ENTITY_SPEC[entity].label} only`;
}

export function SuiteRoute(): JSX.Element {
  const nav = useNavigate();
  const [entityUnderTest, setEntityUnderTest] = useState<EntityUnderTest>('issuer');
  const [entityUrl, setEntityUrl] = useState('');
  const [walletUrl, setWalletUrl] = useState('');
  const [issuerMetadataUrl, setIssuerMetadataUrl] = useState('');
  const [credentialConfigurationId, setCredentialConfigurationId] = useState('');
  const [useMock, setUseMock] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);
  const [continueOnError, setContinueOnError] = useState(false);
  const [roleFocus, setRoleFocus] = useState<PrimaryRole | 'all'>('all');
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

  // The cross-mode "wallet" field is hidden when the entity IS wallet
  // (would be a duplicate of the entity URL). It shows for issuer and
  // verifier to express "issuer with wallet" / "verifier with wallet".
  const showWalletField = entityUnderTest !== 'wallet';

  // Resolve which YAML keys get the values, depending on the entity
  // selector. Keeping this in a memo makes the onSubmit handler small.
  const targetYaml = useMemo(() => {
    const spec = ENTITY_SPEC[entityUnderTest];
    const out: {
      targetIssuer?: string;
      targetVerifier?: string;
      wallet?: string;
    } = {};
    out[spec.yamlKey] = entityUrl || undefined;
    // Cross-mode: if entity != wallet and wallet URL is set, attach
    // the wallet URL too. For entity == wallet the entity URL itself
    // already maps to `wallet`; no second assignment.
    if (entityUnderTest !== 'wallet' && walletUrl.trim()) {
      out.wallet = walletUrl.trim();
    }
    return out;
  }, [entityUnderTest, entityUrl, walletUrl]);

  const hasAnyTarget = Boolean(
    issuerMetadataUrl || entityUrl || walletUrl,
  );

  const runPrecheck = useCallback(async (): Promise<PrecheckState> => {
    setPrecheck({ kind: 'checking' });
    if (useMock || !hasAnyTarget) {
      setPrecheck({ kind: 'ok' });
      return { kind: 'ok' };
    }
    // The server's precheck runs server-side at run-start; the UI surfaces
    // a lightweight "is the target reachable?" probe so a bad URL is
    // caught at the form level. We do a HEAD/GET against the entity
    // endpoint (or, when set, the optional issuer metadata URL).
    const probeUrl = issuerMetadataUrl || entityUrl || walletUrl;
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
  }, [useMock, hasAnyTarget, issuerMetadataUrl, entityUrl, walletUrl]);

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
        targetIssuer: targetYaml.targetIssuer,
        targetVerifier: targetYaml.targetVerifier,
        wallet: targetYaml.wallet,
        credentialConfigurationId: credentialConfigurationId || undefined,
        useMock,
      });
      void stopOnError; // wire-stable: stopOnError is a v2 invariant
      void continueOnError; // (not configurable in v2; reserved for v3)
      void roleFocus; // (UI-side filter only; CLI is source of truth — see MAS-292)
      const res = await api.createRun(cfg);
      nav(`/runs/${encodeURIComponent(res.id)}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  const spec = ENTITY_SPEC[entityUnderTest];
  const entityModeLabel = describeEntityMode(entityUnderTest, walletUrl);

  return (
    <section aria-labelledby="suite-h">
      <header className="view-header">
        <div>
          <span className="eyebrow">Step 01 · Suite</span>
          <h2 id="suite-h">
            Configure a conformance <em>run.</em>
          </h2>
          <p>
            Pick the entity under test. The precheck probes reachability
            before the run starts; stop-on-error is the default and is
            mandatory in v2.
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

      <div
        className="panel role-split"
        data-testid="role-split"
        role="group"
        aria-label="Catalog role split"
      >
        <div className="role-split-head">
          <span className="eyebrow">Catalog · Role split</span>
          <p className="hint">
            317 cases across the v2.0 conformance catalog. Pick a role to
            see how the run will exercise the suite; the CLI's
            <code> --role</code> flag is the source of truth.
          </p>
        </div>
        <div className="role-chips" role="tablist" aria-label="Role focus">
          <button
            type="button"
            role="tab"
            aria-selected={roleFocus === 'all'}
            className={`role-chip role-chip-all ${roleFocus === 'all' ? 'is-active' : ''}`}
            onClick={() => setRoleFocus('all')}
            data-testid="role-chip-all"
          >
            <span className="role-chip-label">All</span>
            <span className="role-chip-count">317</span>
            <span className="role-chip-caption">full catalog</span>
          </button>
          {PRIMARY_ROLES.map((r) => {
            const meta = ROLE_META[r];
            const isActive = roleFocus === r;
            return (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`role-chip role-chip-${r} ${isActive ? 'is-active' : ''}`}
                onClick={() => setRoleFocus(r)}
                data-testid={`role-chip-${r}`}
                title={meta.description}
              >
                <span className="role-chip-glow" aria-hidden="true" />
                <span className="role-chip-label">{meta.label}</span>
                <span className="role-chip-count">{meta.count}</span>
                <span className="role-chip-caption">cases</span>
              </button>
            );
          })}
        </div>
        {roleFocus !== 'all' ? (
          <p
            className={`role-detail role-detail-${roleFocus}`}
            data-testid="role-detail"
          >
            <span className={`role-badge role-${roleFocus}`} aria-hidden="true">
              {ROLE_META[roleFocus].label}
            </span>
            <span>{ROLE_META[roleFocus].description}</span>
            <span className="role-detail-meta">
              <code>{ROLE_META[roleFocus].count}</code> cases
            </span>
          </p>
        ) : null}
      </div>

      <form className="panel" onSubmit={onSubmit} data-testid="suite-form">
        <fieldset className="entity-fieldset" data-testid="entity-fieldset">
          <legend className="entity-legend">Entity under test</legend>
          <p className="help" data-testid="entity-mode-label">
            {entityModeLabel}. The endpoint textbox below is labeled
            against this entity.
          </p>
          <div
            className="entity-radios"
            role="radiogroup"
            aria-label="Entity under test"
          >
            {(['issuer', 'verifier', 'wallet'] as EntityUnderTest[]).map((e) => {
              const isActive = entityUnderTest === e;
              return (
                <label
                  key={e}
                  className={`entity-radio role-${ENTITY_SPEC[e].roleClass} ${isActive ? 'is-active' : ''}`}
                  data-testid={`entity-radio-${e}`}
                >
                  <input
                    type="radio"
                    name="entityUnderTest"
                    value={e}
                    checked={isActive}
                    onChange={() => setEntityUnderTest(e)}
                    data-testid={`entity-radio-input-${e}`}
                  />
                  <span className="entity-radio-dot" aria-hidden="true" />
                  <span className="entity-radio-label">{ENTITY_SPEC[e].label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="entityUrl" data-testid="entity-endpoint-label">
              {spec.caption}
            </label>
            <input
              id="entityUrl"
              type="url"
              placeholder={spec.placeholder}
              value={entityUrl}
              onChange={(e) => setEntityUrl(e.target.value)}
              data-testid="input-entityUrl"
              aria-describedby="entity-endpoint-help"
            />
            <span className="help" id="entity-endpoint-help">
              Endpoint for the {spec.label.toLowerCase()} being tested.
            </span>
          </div>
          {showWalletField ? (
            <div className="field">
              <label htmlFor="wallet">Wallet URL</label>
              <input
                id="wallet"
                type="url"
                placeholder="https://wallet.example"
                value={walletUrl}
                onChange={(e) => setWalletUrl(e.target.value)}
                data-testid="input-wallet"
              />
              <span className="help">
                Cross-target: our wallet drives {spec.label.toLowerCase()}.
              </span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="credentialConfigurationId">
                Credential configuration id
              </label>
              <input
                id="credentialConfigurationId"
                type="text"
                placeholder="ThaiNationalID"
                value={credentialConfigurationId}
                onChange={(e) => setCredentialConfigurationId(e.target.value)}
                data-testid="input-credentialConfigurationId"
              />
            </div>
          )}
        </div>

        <div className="grid-2">
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
          <div className="field">
            {showWalletField ? (
              <>
                <label htmlFor="credentialConfigurationId">
                  Credential configuration id
                </label>
                <input
                  id="credentialConfigurationId"
                  type="text"
                  placeholder="ThaiNationalID"
                  value={credentialConfigurationId}
                  onChange={(e) => setCredentialConfigurationId(e.target.value)}
                  data-testid="input-credentialConfigurationId"
                />
              </>
            ) : (
              <span className="help">
                Wallet endpoint is the entity URL above; no separate
                wallet field needed.
              </span>
            )}
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
