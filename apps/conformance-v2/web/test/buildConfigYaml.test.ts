/**
 * buildConfigYaml — keep the wire shape in one place.
 */

import { describe, it, expect } from 'vitest';
import { buildConfigYaml } from '../src/lib/api';

describe('buildConfigYaml', () => {
  it('emits useMock: true when nothing is set', () => {
    expect(buildConfigYaml({})).toBe('useMock: true\n');
  });

  it('emits only the fields that are set', () => {
    expect(
      buildConfigYaml({
        targetIssuer: 'https://issuer.example',
        credentialConfigurationId: 'ThaiNationalID',
      }),
    ).toBe(
      'targetIssuer: https://issuer.example\ncredentialConfigurationId: ThaiNationalID\n',
    );
  });

  it('drops empty strings', () => {
    expect(
      buildConfigYaml({
        targetIssuer: '',
        wallet: 'https://wallet.example',
      }),
    ).toBe('wallet: https://wallet.example\n');
  });

  it('does not emit stopOnError (a v2 invariant, not a config knob)', () => {
    const yaml = buildConfigYaml({ useMock: true, stopOnError: false });
    expect(yaml).not.toMatch(/stopOnError/);
  });
});
