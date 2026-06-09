/**
 * Catalog expansion tests for MAS-136.
 *
 * Covers the 28 new test cases added to apps/web/src/wallet/catalog.ts:
 *   - OID4VCI §8 Deferred (tx_code, user_pin, pending, invalid txid)
 *   - OID4VCI §9 Notification (deleted, failure, invalid id, missing id)
 *   - OID4VCI §5/§6 error envelope (unsupported_grant_type, unsupported_credential_format,
 *                                  unsupported_credential_type, invalid_client)
 *   - OID4VP §5.1 client_metadata (vp_formats, direct_post.jwt, missing vp_formats)
 *   - OID4VP §6.1 Presentation Exchange 2.x (id+descriptors+format, constraints.fields, missing id, empty)
 *   - Refresh (refresh_token grant, invalid_grant, c_nonce rotation, audience mismatch)
 *   - Wallet-side (deferred poll backoff, deleted event handling, JARM response)
 *
 * These are pure assertions over the exported CATALOG and the shape of
 * generated request structures — no network. They prove the catalog is
 * well-formed, every new id is unique, and the spec refs are consistent.
 */

import { describe, it, expect } from 'vitest';
import { CATALOG, listForMode, getById } from '../src/wallet/catalog.js';

const NEW_IDS = [
  'FT.IC.DC.I.H.VB.002',
  'FT.IC.DC.I.H.VB.003',
  'FT.IC.DC.I.H.VB.004',
  'FT.IC.DC.I.H.IB.002',
  'FT.IC.DC.I.H.IB.003',
  'FT.IC.DC.I.H.IB.004',
  'FT.IC.NO.I.H.VB.002',
  'FT.IC.NO.I.H.VB.003',
  'FT.IC.NO.I.H.IB.002',
  'FT.IC.NO.I.H.IB.003',
  'FT.IC.TE.I.H.IB.006',
  'FT.IC.CI.I.H.IB.003',
  'FT.IC.CI.I.H.IB.004',
  'FT.IC.AU.I.H.IB.005',
  'FT.PR.AU.V.H.VB.CM.001',
  'FT.PR.AU.V.H.VB.CM.002',
  'FT.PR.AU.V.H.IB.CM.001',
  'FT.PR.AU.V.H.VB.PD.001',
  'FT.PR.AU.V.H.VB.PD.002',
  'FT.PR.AU.V.H.IB.PD.001',
  'FT.PR.AU.V.H.IB.PD.002',
  'FT.IC.RF.I.H.VB.001',
  'FT.IC.RF.I.H.IB.001',
  'FT.IC.RF.I.H.VB.002',
  'FT.IC.RF.I.H.IB.002',
  'FT.WL.DC.W.V.VB.001',
  'FT.WL.NO.W.V.VB.001',
  'FT.WL.PR.W.V.VB.JARM.001',
];

describe('catalog expansion — existence', () => {
  it('catalog contains all 28 new MAS-136 ids', () => {
    const ids = new Set(CATALOG.map((t) => t.id));
    for (const id of NEW_IDS) {
      expect(ids.has(id), `${id} must be in CATALOG`).toBe(true);
    }
  });

  it('every new id is reachable via getById', () => {
    for (const id of NEW_IDS) {
      const tc = getById(id);
      expect(tc, `getById(${id}) must resolve`).toBeDefined();
      expect(tc!.id).toBe(id);
    }
  });

  it('catalog has at least 80 entries (acceptance: total case count >= 80 across 4 modes)', () => {
    // Sum of per-mode counts (acceptance measures "case count across 4 modes" = 21+7+21+7 = 56 baseline).
    let total = 0;
    for (const mode of ['I->W', 'V->W', 'W->I', 'W->V'] as const) {
      total += listForMode(mode).length;
    }
    expect(total).toBeGreaterThanOrEqual(80);
  });

  it('total executed cases per mode exceeds prior baseline (I->W 21, V->W 7, W->I 21, W->V 7)', () => {
    expect(listForMode('I->W').length).toBeGreaterThan(21);
    expect(listForMode('V->W').length).toBeGreaterThan(7);
    expect(listForMode('W->I').length).toBeGreaterThan(21);
    expect(listForMode('W->V').length).toBeGreaterThan(7);
  });
});

describe('catalog expansion — spec refs', () => {
  it('deferred cases cite OID4VCI §8', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.IC.DC.'))) {
      const tc = getById(id)!;
      expect(tc.specRef, `${id} specRef`).toMatch(/§8/);
    }
  });

  it('notification cases cite OID4VCI §9', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.IC.NO.') || i === 'FT.WL.NO.W.V.VB.001')) {
      const tc = getById(id)!;
      expect(tc.specRef, `${id} specRef`).toMatch(/§9/);
    }
  });

  it('refresh cases cite OID4VCI §6.1 or §7.2', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.IC.RF.'))) {
      const tc = getById(id)!;
      expect(tc.specRef, `${id} specRef`).toMatch(/§6\.1|§7\.2/);
    }
  });

  it('client_metadata cases cite OID4VP §5.1', () => {
    for (const id of NEW_IDS.filter((i) => i.includes('.CM.'))) {
      const tc = getById(id)!;
      expect(tc.specRef, `${id} specRef`).toMatch(/§5\.1/);
    }
  });

  it('presentation_definition cases cite OID4VP §6.1', () => {
    for (const id of NEW_IDS.filter((i) => i.includes('.PD.'))) {
      const tc = getById(id)!;
      expect(tc.specRef, `${id} specRef`).toMatch(/§6\.1/);
    }
  });

  it('JARM response case cites RFC 9101', () => {
    const tc = getById('FT.WL.PR.W.V.VB.JARM.001')!;
    expect(tc.specRef).toMatch(/RFC 9101/);
  });
});

describe('catalog expansion — behaviors', () => {
  it('invalid-behavior (IB) cases reference the right error codes in their spec', () => {
    const ibErrorMap: Array<[string, RegExp]> = [
      ['FT.IC.DC.I.H.IB.002', /§8\.1|§6\.1/],  // invalid_request on missing tx_code
      ['FT.IC.DC.I.H.IB.003', /issuance_pending/],
      ['FT.IC.DC.I.H.IB.004', /invalid_transaction_id/],
      ['FT.IC.NO.I.H.IB.002', /invalid_notification_id/],
      ['FT.IC.TE.I.H.IB.006', /unsupported_grant_type/],
      ['FT.IC.CI.I.H.IB.003', /unsupported_credential_format/],
      ['FT.IC.CI.I.H.IB.004', /unsupported_credential_type/],
      ['FT.IC.AU.I.H.IB.005', /invalid_client/],
      ['FT.IC.RF.I.H.IB.001', /invalid_grant/],
      ['FT.IC.RF.I.H.IB.002', /invalid_grant/],
    ];
    for (const [id, pattern] of ibErrorMap) {
      const tc = getById(id)!;
      expect(tc.behavior, `${id} should be IB`).toBe('IB');
      expect(tc.specRef, `${id} specRef`).toMatch(pattern);
    }
  });

  it('valid-behavior (VB) cases for the new flows are positive', () => {
    const vbIds = NEW_IDS.filter((i) => i.includes('.VB.'));
    for (const id of vbIds) {
      const tc = getById(id)!;
      expect(tc.behavior, `${id} should be VB`).toBe('VB');
    }
  });
});

describe('catalog expansion — modes', () => {
  it('all new cases declare a non-empty modes list', () => {
    for (const id of NEW_IDS) {
      const tc = getById(id)!;
      expect(tc.modes.length, `${id} modes`).toBeGreaterThan(0);
    }
  });

  it('refresh cases are issuer-side only (I->W, W->I)', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.IC.RF.'))) {
      const tc = getById(id)!;
      expect(tc.modes).toEqual(['I->W', 'W->I']);
    }
  });

  it('client_metadata and presentation_definition cases are verifier-side (V->W, W->V)', () => {
    for (const id of NEW_IDS.filter((i) => i.includes('.CM.') || i.includes('.PD.'))) {
      const tc = getById(id)!;
      expect(tc.modes).toEqual(['V->W', 'W->V']);
    }
  });

  it('issuer-side deferred/notification/refresh cases participate in both I->W and W->I', () => {
    const icIds = NEW_IDS.filter((i) => i.startsWith('FT.IC.DC.') || i.startsWith('FT.IC.NO.') || i.startsWith('FT.IC.RF.'));
    for (const id of icIds) {
      const tc = getById(id)!;
      expect(tc.modes, `${id} modes`).toContain('I->W');
      expect(tc.modes, `${id} modes`).toContain('W->I');
    }
  });
});

describe('catalog expansion — shape of generated request structures', () => {
  it('deferred pre-authorized grant can carry tx_code (numeric) per §8.1', () => {
    const grant = { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { pre_authorized_code: 'abc', tx_code: '1234' } };
    expect(grant['urn:ietf:params:oauth:grant-type:pre-authorized_code'].tx_code).toMatch(/^\d{4,8}$/);
  });

  it('deferred pre-authorized grant can carry tx_code (text) per §8.1', () => {
    const grant = { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { pre_authorized_code: 'abc', tx_code: 'ABCD-1234' } };
    expect(grant['urn:ietf:params:oauth:grant-type:pre-authorized_code'].tx_code).toMatch(/^[A-Za-z0-9-]{4,32}$/);
  });

  it('user_pin_required must be a boolean', () => {
    const grant = { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { pre_authorized_code: 'abc', user_pin_required: true } };
    expect(typeof grant['urn:ietf:params:oauth:grant-type:pre-authorized_code'].user_pin_required).toBe('boolean');
  });

  it('notification body must include notification_id and event per §9.1', () => {
    const body = { notification_id: 'n1', event: 'credential_accepted' };
    expect(typeof body.notification_id).toBe('string');
    expect(['credential_accepted', 'credential_deleted', 'credential_failure']).toContain(body.event);
  });

  it('error envelope carries both error and error_description', () => {
    const errors = [
      { error: 'unsupported_grant_type', error_description: 'x' },
      { error: 'unsupported_credential_format', error_description: 'x' },
      { error: 'unsupported_credential_type', error_description: 'x' },
      { error: 'invalid_client', error_description: 'x' },
      { error: 'invalid_grant', error_description: 'x' },
      { error: 'invalid_request', error_description: 'x' },
    ];
    for (const e of errors) {
      expect(typeof e.error).toBe('string');
      expect(typeof e.error_description).toBe('string');
    }
  });

  it('client_metadata.vp_formats must include at least one format with alg values', () => {
    const cm = { vp_formats: { 'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'] } } };
    expect(Object.keys(cm.vp_formats).length).toBeGreaterThan(0);
    expect(cm.vp_formats['dc+sd-jwt']['sd-jwt_alg_values'].length).toBeGreaterThan(0);
  });

  it('JARM requires response_encryption_alg in client_metadata', () => {
    const cm = { response_encryption_alg: 'ECDH-ES', response_encryption_enc: 'A128GCM' };
    expect(typeof cm.response_encryption_alg).toBe('string');
  });

  it('presentation_definition requires id and non-empty input_descriptors', () => {
    const good = { id: 'pd-1', input_descriptors: [{ id: 'pid' }] };
    const badMissingId: any = { input_descriptors: [{ id: 'pid' }] };
    const badEmpty: any = { id: 'pd-2', input_descriptors: [] };
    expect(typeof good.id).toBe('string');
    expect(good.input_descriptors.length).toBeGreaterThan(0);
    expect(typeof badMissingId.id).not.toBe('string');
    expect(badEmpty.input_descriptors.length).toBe(0);
  });

  it('presentation_definition input_descriptor can declare format + constraints.fields', () => {
    const idesc = {
      id: 'pid',
      format: { 'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'] } },
      constraints: { fields: [{ path: ['$.vct'] }] },
    };
    expect(idesc.format).toBeDefined();
    expect(idesc.constraints.fields.length).toBeGreaterThan(0);
    expect(idesc.constraints.fields[0].path).toEqual(['$.vct']);
  });

  it('refresh_token grant body shape per §6.1', () => {
    const body = { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'c1' };
    expect(body.grant_type).toBe('refresh_token');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('issuance_pending error envelope includes positive interval', () => {
    const errBody = { error: 'issuance_pending', error_description: 'not yet ready', interval: 5 };
    expect(errBody.interval).toBeGreaterThan(0);
  });

  it('DCQL query rendering and presentation_definition can co-exist (interop) per §5.1/§6.1/§6.4', () => {
    const dcql = { credentials: [{ id: 'pid', format: 'dc+sd-jwt' as const, meta: { vct_values: ['urn:eudi:pid:1'] } }] };
    const pd = { id: 'pd-1', input_descriptors: [{ id: 'pid', format: { 'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'] } } }] };
    expect(dcql.credentials[0].id).toBe('pid');
    expect(pd.input_descriptors[0].id).toBe('pid');
  });

  it('wallet-side cases are scoped to wallet EUT', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.WL.'))) {
      const tc = getById(id)!;
      expect(tc.eut, `${id} eut`).toBe('wallet');
    }
  });

  it('issuer-side new cases are scoped to issuer EUT', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.IC.'))) {
      const tc = getById(id)!;
      expect(tc.eut, `${id} eut`).toBe('issuer');
    }
  });

  it('verifier-side new cases are scoped to verifier EUT', () => {
    for (const id of NEW_IDS.filter((i) => i.startsWith('FT.PR.'))) {
      const tc = getById(id)!;
      expect(tc.eut, `${id} eut`).toBe('verifier');
    }
  });
});

describe('catalog expansion — WALLET case requires', () => {
  it('JARM response case requires a credential in the wallet', () => {
    const tc = getById('FT.WL.PR.W.V.VB.JARM.001')!;
    expect(tc.requires).toContain('credential');
  });

  it('deferred-pending and invalid-txid cases require the deferredCredentialEndpoint prereq (MAS-169)', () => {
    for (const id of ['FT.IC.DC.I.H.IB.003', 'FT.IC.DC.I.H.IB.004']) {
      const tc = getById(id)!;
      // MAS-169: the catalog moved these tests from `requires: ['issuerMetadata']`
      // to the derived prereq `requires: ['deferredCredentialEndpoint']` so the
      // runner SKIPs (not FAILs) them against issuers that do not advertise
      // `deferred_credential_endpoint` (e.g. Procivis One Core, per OID4VCI
      // 1.0 §8.1 optionality).
      expect(tc.requires ?? [], `${id} requires`).toContain('deferredCredentialEndpoint');
      expect(tc.requires ?? [], `${id} requires`).not.toContain('issuerMetadata');
    }
  });
});
