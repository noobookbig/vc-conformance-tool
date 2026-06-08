/**
 * URL round-trip tests for the SPA diff deep-link (MAS-143).
 *
 * Proves that:
 *  - `readDiffFromSearch` extracts { left, right, report } from a
 *    real-looking search string.
 *  - `writeDiffToSearch` reproduces the original query when fed the
 *    parsed selection, and preserves unrelated keys.
 *  - `buildHref` produces a stable pathname?search string.
 *  - Malformed inputs (missing parts, equal ids, unsafe characters) are
 *    rejected without throwing.
 */

import { describe, it, expect } from 'vitest';
import { readDiffFromSearch, writeDiffToSearch, buildHref } from '../public/diff-url.js';

const L = 'run-2026-01-01T00-00-00-abcd';
const R = 'run-2026-01-02T00-00-00-efgh';

describe('readDiffFromSearch', () => {
  it('parses a full diff query with report key', () => {
    const out = readDiffFromSearch(`?diff=${encodeURIComponent(L)},${encodeURIComponent(R)}&report=run-base-123`);
    expect(out).toEqual({ left: L, right: R, report: 'run-base-123' });
  });

  it('returns null parts when diff key is absent', () => {
    expect(readDiffFromSearch('')).toEqual({ left: null, right: null, report: null });
    expect(readDiffFromSearch('?foo=bar')).toEqual({ left: null, right: null, report: null });
  });

  it('rejects a partial diff (only one id)', () => {
    const out = readDiffFromSearch(`?diff=${encodeURIComponent(L)}`);
    expect(out.left).toBeNull();
    expect(out.right).toBeNull();
  });

  it('rejects a diff where left === right', () => {
    const out = readDiffFromSearch(`?diff=${encodeURIComponent(L)},${encodeURIComponent(L)}`);
    expect(out.left).toBeNull();
    expect(out.right).toBeNull();
  });

  it('strips unsafe characters from run ids', () => {
    const out = readDiffFromSearch(`?diff=${encodeURIComponent('a b/c?d=e&f')},${encodeURIComponent('ok-id_1.2')}`);
    expect(out.left).toBe('abcdef');
    expect(out.right).toBe('ok-id_1.2');
  });
});

describe('writeDiffToSearch', () => {
  it('round-trips a full diff through read → write', () => {
    const input = `?diff=${encodeURIComponent(L)},${encodeURIComponent(R)}&report=run-base-123`;
    const sel = readDiffFromSearch(input);
    const out = writeDiffToSearch(input, sel);
    const outParams = new URLSearchParams(out.startsWith('?') ? out.slice(1) : out);
    // URLSearchParams.toString() percent-encodes commas; we compare the
    // decoded values because that's what matters semantically.
    expect(outParams.get('diff')).toBe(`${L},${R}`);
    expect(outParams.get('report')).toBe('run-base-123');
  });

  it('preserves unrelated query keys', () => {
    const input = `?q=catalog&diff=${encodeURIComponent(L)},${encodeURIComponent(R)}`;
    const sel = readDiffFromSearch(input);
    const out = writeDiffToSearch(input, sel);
    const outParams = new URLSearchParams(out.startsWith('?') ? out.slice(1) : out);
    expect(outParams.get('q')).toBe('catalog');
    expect(outParams.get('diff')).toBe(`${L},${R}`);
  });

  it('removes diff and report keys when the selection is null', () => {
    const input = `?diff=${encodeURIComponent(L)},${encodeURIComponent(R)}&report=run-base-123&keep=me`;
    const out = writeDiffToSearch(input, null);
    const outParams = new URLSearchParams(out.startsWith('?') ? out.slice(1) : out);
    expect(outParams.get('diff')).toBeNull();
    expect(outParams.get('report')).toBeNull();
    expect(outParams.get('keep')).toBe('me');
  });

  it('returns an empty string when nothing remains and no selection', () => {
    const input = `?diff=${encodeURIComponent(L)},${encodeURIComponent(R)}`;
    const out = writeDiffToSearch(input, null);
    expect(out).toBe('');
  });

  it('drops an invalid selection (left === right)', () => {
    const out = writeDiffToSearch('', { left: L, right: L, report: null });
    expect(out).toBe('');
  });
});

describe('buildHref', () => {
  it('combines pathname with a new search string', () => {
    const href = buildHref({ pathname: '/', search: '' }, { left: L, right: R, report: null });
    expect(href.startsWith('/?')).toBe(true);
    const params = new URLSearchParams(href.slice(2));
    expect(params.get('diff')).toBe(`${L},${R}`);
  });

  it('preserves the pathname when given a deep path', () => {
    const href = buildHref({ pathname: '/index.html', search: '' }, { left: L, right: R, report: null });
    expect(href.startsWith('/index.html?')).toBe(true);
  });

  it('returns just the pathname when no diff is selected', () => {
    const href = buildHref({ pathname: '/', search: `?diff=${L},${R}` }, null);
    expect(href).toBe('/');
  });
});
