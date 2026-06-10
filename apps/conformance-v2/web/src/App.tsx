/**
 * App shell — top bar + sidebar + main routed view.
 */

import { useEffect, useState } from 'react';
import { NavLink, Route, BrowserRouter, Routes } from 'react-router-dom';
import { SuiteRoute } from './routes/SuiteRoute';
import { RunRoute } from './routes/RunRoute';
import { ReportRoute } from './routes/ReportRoute';
import { api } from './lib/api';

function HealthPill(): JSX.Element {
  const [state, setState] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  useEffect(() => {
    let mounted = true;
    const tick = (): void => {
      api
        .health()
        .then(() => mounted && setState('ok'))
        .catch(() => mounted && setState('bad'));
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);
  return (
    <div
      className={`health ${state === 'ok' ? 'is-ok' : state === 'bad' ? 'is-bad' : ''}`}
      data-testid="health-pill"
      title="Server health"
    >
      <span className="dot" aria-hidden="true" />
      <span>
        {state === 'ok' && 'Server ok'}
        {state === 'bad' && 'Server unreachable'}
        {state === 'unknown' && 'Checking…'}
      </span>
    </div>
  );
}

function Sidebar(): JSX.Element {
  return (
    <nav className="sidebar" aria-label="Primary">
      <NavLink
        to="/"
        end
        className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}
      >
        <svg
          className="icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="4,3 13,8 4,13" />
        </svg>
        <span>Suite</span>
        <span className="nav-num">01</span>
      </NavLink>
      <span
        className="nav-link"
        aria-disabled="true"
        title="Open a run from the Suite page"
        data-testid="nav-run-disabled"
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
      >
        <svg
          className="icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.4V8l2.4 1.6" />
        </svg>
        <span>Run</span>
        <span className="nav-num">02</span>
      </span>
      <span
        className="nav-link"
        aria-disabled="true"
        title="Open a report from a finished run"
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
      >
        <svg
          className="icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="3" width="5" height="5" rx="1" />
          <rect x="9" y="3" width="5" height="5" rx="1" />
          <rect x="2" y="10" width="5" height="5" rx="1" />
          <rect x="9" y="10" width="5" height="5" rx="1" />
        </svg>
        <span>Report</span>
        <span className="nav-num">03</span>
      </span>
      <div style={{ flex: 1 }} />
      <div className="hint" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        v2.0.0 — Suite → Run → Report.
      </div>
    </nav>
  );
}

function Topbar(): JSX.Element {
  return (
    <header className="topbar" role="banner">
      <div className="brand">
        <div
          className="logo"
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            background: 'linear-gradient(135deg, var(--teal), var(--gold))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--bg-3)',
            fontFamily: 'var(--serif)',
            fontWeight: 600,
            fontSize: 18,
          }}
        >
          vc
        </div>
        <div className="brand-text">
          <h1>
            Conformance<span className="dim">/</span>
            <em>v2</em>
          </h1>
          <p>OID4VCI 1.0 · OID4VP 1.0 · Thailand VC</p>
        </div>
      </div>
      <HealthPill />
    </header>
  );
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <div className="app">
        <Topbar />
        <Sidebar />
        <main className="main" id="main">
          <Routes>
            <Route path="/" element={<SuiteRoute />} />
            <Route path="/runs/:id" element={<RunRoute />} />
            <Route path="/runs/:id/report" element={<ReportRoute />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
