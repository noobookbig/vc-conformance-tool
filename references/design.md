# Design notes — vc-conformance-test webapp

A short, evolving record of design decisions for the conformance test webapp.
For the current plan, see [MAS-131 plan document](/MAS/issues/MAS-131#document-plan).

## What it is

A Dockerized webapp that simulates an OID4VCI / OID4VP wallet and runs it
against a target issuer or verifier (or against the in-process mock). It
produces a downloadable conformance report.

## Why one app, not three (issuer / verifier / wallet)

Per the MAS-131 plan, the four role cross-modes need a wallet that is
reusable on both the driver and the EUT sides. Splitting into three apps
would mean two of them were 90% identical. One TS app, one deployment.

## Why in-process mock issuer/verifier

- `docker compose up` must work with no external dependency.
- A real conformance run can swap the target via the UI or env. The mock
  is the "no target" demo path, not a reference implementation.

## Why no SQLite for v1

- In-memory `Map` for the run store is enough at this scale.
- Reports are persisted to `data/reports/<id>.json` so a restart does not
  lose history.
- Add SQLite when we need a query layer for cross-run history or trends.

## Why no PDF

- JSON is the canonical artifact (machine-digestible, easy to diff).
- HTML is the human artifact (downloadable, viewable offline).
- PDF is one more dependency with no concrete user request.

## Why no PKI/CA chain for v1

- v1 uses dev keys generated in-process at server boot.
- A real Thai national ID signing key is a one-way-door decision and is
  explicitly out of scope for v1. See the parent issue plan.

## What v1 explicitly does NOT do

- Auth on the dashboard
- Multi-user support
- Webhook triggers to external CI
- Persistent historical dashboard
- Full 283-case coverage (curated subset only)

## UI

A focused design pass for the vanilla-TS SPA in `apps/web/public/`. Goal:
**clean, professional, restrained** — not flashy. The CEO brief was "ทำ UX ให้สวย"
with the implicit constraint that this is an internal tool used by QA engineers
to read conformance reports, not a marketing page.

### Aesthetic direction — "editorial technical console"

The product sits between two reference points: a Thai-national-color editorial
spread, and a research-lab test console. The pass commits to that intersection
and tightens the previous draft.

- **Type.** Fraunces (display serif) carries warmth on every heading and KPI,
  with italic em-dashes used to signal a softer continuation of a sentence
  ("Run a conformance *pass.*"). IBM Plex Sans Thai for body. JetBrains Mono
  for ids, durations, status pills, log lines. `font-variation-settings: "opsz"`
  bumped to 96–144 on display sizes for the chunky "Fraunces" feel without
  needing a different family.
- **Color.** Deepened ink to `#15140f` for AA contrast on parchment. Teal
  `#0a6464` and gold `#a8761e` for accents. New `--green` and `--rose` are
  pulled darker than the previous build to keep the pass/fail chips legible on
  the warm background. Two soft tints (`--teal-3`, `--gold-3`) are used as
  icon-button backdrops only — never as panel fills.
- **Shape.** Single source of truth: `--radius` 14, `--radius-sm` 9, `--radius-xs`
  5. Spacing is a 4 / 8 / 12 / 16 / 24 / 48 / 64 scale, exposed as
  `--s-1` … `--s-8`. The same scale drives the catalog, history, and KPI grids.
- **Atmosphere.** The body has two large radial gradients (gold from top-right,
  teal from bottom-left) on top of the parchment base. Subtle at rest, but
  breaks up the flat cream when the page is open in a long QA session.
- **Iconography.** Emoji are gone. The nav uses five thin-stroke (1.5px) SVG
  glyphs (run, configure, history, catalog, about) with a `nav-num` prefix
  (`01`–`05`) in monospace. The four mode cards each have a small icon tile
  in a teal-tinted box — Issuer (facade), Verifier (magnifier), Wallet-on-
  Issuer (phone with side connector), Wallet-on-Verifier (laptop). The run
  button has a play glyph; the report uses three status SVGs (check, cross,
  skip). Total SVG count: 14, all inline, all using `currentColor` so they
  recolor automatically in dark mode.

### Motion

The pass deliberately *concentrates* motion into three orchestrated moments
rather than scattering micro-interactions.

1. **Page load.** Top bar fades, then sidebar nav, then view header, then mode
   cards stagger in at 60ms steps. KPI cards / result rows use a 600ms-budget
   stagger: many short steps, not one long delay.
2. **Run dispatch.** Run button gets a left-to-right shimmer sweep, a `Running…`
   label, and a `cursor: progress`. The right-side panel swaps to a skeleton
   block (three lines + a taller card) until the report comes back.
3. **Result reveal.** Result rows fade in from `translateY(4px)` with a small
   per-row delay proportional to count (`600ms / N`, capped at 28ms/row).
   `prefers-reduced-motion: reduce` collapses all of this to instant.

Hover lifts are 2px on cards and translate-X 1px on nav icons. The run
button has a one-shot sweep on hover.

### Layout

- **Sidebar.** 232px fixed, sticky, gradient from `--bg-2` to a slightly
  darker bottom — creates a soft contrast with the content column. Active
  item is `--bg-elev` with a 3px teal left rail; the `nav-num` flips to teal
  in the active state for a secondary affordance.
- **Content.** Max width 1140px, asymmetric padding (32 / 48 on desktop,
  16 / 48 on small). Section breaks use a hairline-prefixed eyebrow
  ("Cross-modes *— pick one*") instead of full-width headings.
- **Mode cards.** Numbered `01`–`04` in monospace top-left, icon top-center,
  title, one-line description, footer with a single test-count badge. Selected
  state adds a 1px teal hairline + small "selected" eyebrow in the top-right.
- **KPI strip.** Four equal cells with a 3px colored left rail on passed /
  failed. Values in Fraunces at opsz 144; labels in 11px caps with 0.14em
  tracking.
- **Results table.** Bordered container, alternating-tint rows for pass/fail,
  monospace test id + duration, 0.78rem name. Evidence disclosure uses
  `<details>` with an uppercase mono summary.

### Empty / loading states

- **No run yet.** Centered-left SVG (terminal with cursor) + italic copy,
  on the parchment side panel.
- **Running.** Three-line skeleton with a 1.4s shimmer, plus a "Dispatching
  catalog…" headline.
- **No history.** Italic muted line at the top of the list — no empty card.
- **No filter results.** Catalog count chip in the filter row says
  `0 / 28` so the user knows the filter is the reason, not a broken catalog.

### Accessibility

- Skip link ("Skip to main content") visible on focus, hidden otherwise.
- All buttons are real `<button>` (or `<a>` for downloads) with `aria-label`
  only where icon-only; the cards are `<button>`s inside the cards grid so
  keyboard users can select modes with Tab + Enter / Space.
- Health pill is `role="status" aria-live="polite"` so screen readers
  announce "online · v0.1.0" / "offline" without re-reading the whole page.
- The run side panel is `aria-busy` while a run is in flight and the meta
  eyebrow in the view header announces the current state ("Running · W->I",
  "Done · W->I", "Failed · W->I").
- Focus rings are 3px teal at 60% mix, with 2px offset. Never removed.
- Color contrast checked for `--ink` on `--bg` (≈ 14.8:1) and `--teal` on
  `--bg` (≈ 6.4:1) in light mode; both clear WCAG AA for body text and UI
  components. `--ink-3` is *only* used for tertiary hints and never carries
  required information.
- `prefers-reduced-motion: reduce` disables every animation and transition.

### Out of design scope (intentionally)

- A real Thai locale string (the webapp is internal/English-only for v1).
- A new icon family / icon font. The 14 inline SVGs are sufficient for the
  current surface and recolor automatically.
- A dark-mode-specific tuning pass. The dark mode inverts the surface scale
  and adjusts the accents; if a future user reports legibility issues we'll
  tune `--teal` / `--gold` for dark directly.
