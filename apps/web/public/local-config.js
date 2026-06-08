/**
 * Browser-side convenience store for the QA-typed target URLs.
 *
 * Why this exists:
 *   MAS-137 acceptance #4 says the Configuration tab should persist the
 *   QA's last target URLs to `localStorage` so the browser remembers them
 *   across reloads/tab closes. The server config (PUT /api/config) is
 *   the source of truth for cross-restart durability, but it can be
 *   surprising when a QA types a value into the Run form, refreshes the
 *   tab, and the value is gone because they never clicked "Save config".
 *
 * Contract:
 *   - A single key: `vc-conformance.config.v1`.
 *   - A single value: a JSON object with the two target URLs (and, as a
 *     nicety, the last selected mode and credential configuration).
 *   - `readLocalConfig(storage)` returns the parsed object, or `null` if
 *     nothing is stored or the stored value is malformed.
 *   - `writeLocalConfig(storage, partial)` shallow-merges `partial` over
 *     the existing value and writes it back. Throws on serialization
 *     failure (so the caller can surface a toast).
 *   - `clearLocalConfig(storage)` removes the key.
 *
 * The `storage` argument is always injected (default: `window.localStorage`)
 * so the helpers can be unit-tested in Node by passing a plain object.
 */

const KEY = 'vc-conformance.config.v1';

// Shape of a single persisted field. We keep this list small and explicit
// so a future contributor can't accidentally round-trip arbitrary user
// input through `localStorage` (XSS via the same-origin trust is not the
// concern here — we are; the concern is accidentally persisting PII or
// values that should not survive a session).
const KNOWN_FIELDS = ['targetIssuer', 'targetVerifier', 'mode', 'credentialConfigurationId'];

function pick(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const k of KNOWN_FIELDS) {
    if (typeof value[k] === 'string' && value[k].length > 0) {
      out[k] = value[k];
    }
  }
  return out;
}

/**
 * Read the locally-stored config. Returns `null` when nothing is stored
 * or the stored JSON is malformed. Pass an explicit `storage` (e.g. a
 * plain object) to use this in tests.
 */
export function readLocalConfig(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let raw;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const picked = pick(parsed);
  return picked ?? null;
}

/**
 * Merge `partial` into the existing local config and persist.
 *
 * `partial` is a sparse update: a non-empty string "sets" a field; an
 * empty string (or `null`/`undefined`) "clears" that field — i.e. the
 * user's typed-and-then-cleared value should win over what was
 * previously stored. Unknown fields and non-string values are ignored.
 *
 * If the resulting merge has no surviving fields, the key is removed and
 * `null` is returned.
 */
export function writeLocalConfig(storage = globalThis.localStorage, partial) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw new TypeError('writeLocalConfig: a storage with setItem/removeItem is required');
  }
  if (!partial || typeof partial !== 'object') return readLocalConfig(storage);
  const existing = readLocalConfig(storage) || {};
  const next = { ...existing };
  for (const k of KNOWN_FIELDS) {
    if (!(k in partial)) continue;
    const v = partial[k];
    if (typeof v === 'string' && v.length > 0) {
      next[k] = v;
    } else {
      // Empty string / null / undefined: the user has cleared this field
      // on purpose. Drop it from the stored config so a refresh doesn't
      // show a stale value.
      delete next[k];
    }
  }
  if (Object.keys(next).length === 0) {
    try { storage.removeItem(KEY); } catch { /* best-effort */ }
    return null;
  }
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}

/**
 * Remove the local config. Safe to call when the key is absent.
 */
export function clearLocalConfig(storage = globalThis.localStorage) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  try { storage.removeItem(KEY); } catch { /* best-effort */ }
}

// Exported for tests; not part of the public contract.
export const _internal = { KEY, KNOWN_FIELDS };
