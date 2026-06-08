/**
 * Unit tests for the browser-local config helper (MAS-145).
 *
 * Goals:
 *  - readLocalConfig returns null when the key is absent or malformed.
 *  - readLocalConfig returns the parsed object when a value is present.
 *  - writeLocalConfig shallow-merges over the existing value and
 *    persists non-empty string fields.
 *  - writeLocalConfig drops empty strings, non-strings, and unknown
 *    fields (defense-in-depth: don't round-trip arbitrary user input).
 *  - writeLocalConfig removes the key when the merged result is empty.
 *  - clearLocalConfig removes the key safely.
 *  - A storage object without the expected methods does not throw —
 *    it just returns null (or, for write, throws a clear TypeError).
 *
 * We pass a plain object as `storage` so the tests run in plain Node
 * (no jsdom) and stay under ~50ms.
 */

import { describe, it, expect } from 'vitest';
import {
  readLocalConfig,
  writeLocalConfig,
  clearLocalConfig,
  _internal,
} from '../public/local-config.js';

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    storage: {
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
    },
  };
}

const KEY = _internal.KEY;

describe('readLocalConfig', () => {
  it('returns null when the key is absent', () => {
    const { storage } = makeStore();
    expect(readLocalConfig(storage)).toBeNull();
  });

  it('returns the parsed object when a value is present', () => {
    const value = { targetIssuer: 'https://issuer.example.com' };
    const { storage } = makeStore({ [KEY]: JSON.stringify(value) });
    expect(readLocalConfig(storage)).toEqual(value);
  });

  it('returns null when the stored JSON is malformed', () => {
    const { storage } = makeStore({ [KEY]: '{not-json' });
    expect(readLocalConfig(storage)).toBeNull();
  });

  it('returns null when the stored value is not an object', () => {
    const { storage } = makeStore({ [KEY]: '"hello"' });
    expect(readLocalConfig(storage)).toBeNull();
  });

  it('drops unknown fields and empty strings from the read result', () => {
    const stored = {
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: '',
      mode: 'W->I',
      credentialConfigurationId: 'ThaiNationalID',
      notAllowed: 'leak-me',
      count: 7,
    };
    const { storage } = makeStore({ [KEY]: JSON.stringify(stored) });
    expect(readLocalConfig(storage)).toEqual({
      targetIssuer: 'https://issuer.example.com',
      mode: 'W->I',
      credentialConfigurationId: 'ThaiNationalID',
    });
  });

  it('returns null for a storage object without getItem', () => {
    expect(readLocalConfig({})).toBeNull();
    expect(readLocalConfig(null)).toBeNull();
  });
});

describe('writeLocalConfig', () => {
  it('persists the non-empty string fields it knows about', () => {
    const { storage, data } = makeStore();
    const out = writeLocalConfig(storage, {
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: 'https://verifier.example.com',
    });
    expect(out).toEqual({
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: 'https://verifier.example.com',
    });
    expect(JSON.parse(data[KEY])).toEqual(out);
  });

  it('shallow-merges with the existing value', () => {
    const seed = { targetIssuer: 'https://old.example.com', mode: 'W->I' };
    const { storage, data } = makeStore({ [KEY]: JSON.stringify(seed) });
    const out = writeLocalConfig(storage, { targetVerifier: 'https://new.example.com' });
    expect(out).toEqual({
      targetIssuer: 'https://old.example.com',
      mode: 'W->I',
      targetVerifier: 'https://new.example.com',
    });
    expect(JSON.parse(data[KEY])).toEqual(out);
  });

  it('overwrites a previously stored value when the new partial has it', () => {
    const seed = { targetIssuer: 'https://old.example.com' };
    const { storage, data } = makeStore({ [KEY]: JSON.stringify(seed) });
    writeLocalConfig(storage, { targetIssuer: 'https://new.example.com' });
    expect(JSON.parse(data[KEY])).toEqual({ targetIssuer: 'https://new.example.com' });
  });

  it('drops empty strings and unknown fields from the persisted blob', () => {
    const { storage, data } = makeStore();
    writeLocalConfig(storage, {
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: '',     // dropped
      mode: null,             // dropped
      notAllowed: 'x',        // unknown, dropped
    });
    expect(JSON.parse(data[KEY])).toEqual({ targetIssuer: 'https://issuer.example.com' });
  });

  it('removes the key when the merged result is empty', () => {
    const seed = { targetIssuer: 'https://issuer.example.com' };
    const { storage, data } = makeStore({ [KEY]: JSON.stringify(seed) });
    const out = writeLocalConfig(storage, { targetIssuer: '' });
    expect(out).toBeNull();
    expect(KEY in data).toBe(false);
  });

  it('removes the key when called with an empty partial over an empty store', () => {
    const { storage, data } = makeStore();
    const out = writeLocalConfig(storage, {});
    expect(out).toBeNull();
    expect(KEY in data).toBe(false);
  });

  it('throws a TypeError when storage lacks setItem', () => {
    expect(() => writeLocalConfig({}, { targetIssuer: 'x' })).toThrow(TypeError);
    expect(() => writeLocalConfig(null, { targetIssuer: 'x' })).toThrow(TypeError);
  });
});

describe('clearLocalConfig', () => {
  it('removes the key when present', () => {
    const { storage, data } = makeStore({ [KEY]: '{"targetIssuer":"x"}' });
    clearLocalConfig(storage);
    expect(KEY in data).toBe(false);
  });

  it('is a no-op when the key is absent', () => {
    const { storage } = makeStore();
    expect(() => clearLocalConfig(storage)).not.toThrow();
  });

  it('is a no-op for an empty storage object', () => {
    expect(() => clearLocalConfig({})).not.toThrow();
  });
});

describe('round-trip', () => {
  it('write then read returns the same object', () => {
    const { storage } = makeStore();
    writeLocalConfig(storage, {
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: 'https://verifier.example.com',
      mode: 'W->I',
      credentialConfigurationId: 'ThaiNationalID',
    });
    expect(readLocalConfig(storage)).toEqual({
      targetIssuer: 'https://issuer.example.com',
      targetVerifier: 'https://verifier.example.com',
      mode: 'W->I',
      credentialConfigurationId: 'ThaiNationalID',
    });
  });
});
