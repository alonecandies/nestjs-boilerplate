import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { ledgerConfig } from './ledger.config.js';

/** Runs `fn` and returns the `EnvValidationError` it throws; anything else fails the test. */
const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('ledger namespace (owned by billing, L-11)', () => {
  it('defaults: disabled, a 72-hour reconciliation lookback, no verification', () => {
    expect(ledgerConfig.parse({})).toEqual({
      enabled: false,
      reconcileLookbackHours: 72,
      verify: false,
      allowUnverified: false,
    });
  });

  it('keeps its Nest config token', () => {
    expect(ledgerConfig.KEY).toBe('CONFIGURATION(ledger)');
  });

  it('reads the four variables of the contract', () => {
    expect(
      ledgerConfig.parse({
        LEDGER_ENABLED: 'true',
        LEDGER_RECONCILE_LOOKBACK_HOURS: '24',
        LEDGER_VERIFY: 'true',
        LEDGER_ALLOW_UNVERIFIED: 'true',
      }),
    ).toEqual({ enabled: true, reconcileLookbackHours: 24, verify: true, allowUnverified: true });
  });

  it('defaults the same in production (the ledger is opt-in)', () => {
    expect(ledgerConfig.parse({ NODE_ENV: 'production' })).toMatchObject({
      enabled: false,
      verify: false,
    });
  });

  it.each([
    ['LEDGER_ENABLED', 'yes please'],
    ['LEDGER_VERIFY', 'maybe'],
    ['LEDGER_ALLOW_UNVERIFIED', 'sometimes'],
    ['LEDGER_RECONCILE_LOOKBACK_HOURS', '0'],
    ['LEDGER_RECONCILE_LOOKBACK_HOURS', '721'],
    ['LEDGER_RECONCILE_LOOKBACK_HOURS', '1.5'],
  ])('names %s when it is invalid (%s)', (key, value) => {
    const error = errorOf(() => ledgerConfig.parse({ [key]: value }));
    expect(error.namespace).toBe('ledger');
    expect(error.message).toContain(`→ at ${key}`);
  });

  it('accepts the bounds of the lookback (1 hour to 30 days)', () => {
    expect(
      ledgerConfig.parse({ LEDGER_RECONCILE_LOOKBACK_HOURS: '1' }).reconcileLookbackHours,
    ).toBe(1);
    expect(
      ledgerConfig.parse({ LEDGER_RECONCILE_LOOKBACK_HOURS: '720' }).reconcileLookbackHours,
    ).toBe(720);
  });

  describe('production guard (Task 17, D3): an enabled ledger is verified against a pinned key', () => {
    /** base64 of a PEM public key (the guard checks presence; the immudb namespace the format). */
    const KEY = Buffer.from(
      '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
    ).toString('base64');
    const PROD_ENABLED = { NODE_ENV: 'production', LEDGER_ENABLED: 'true' } as const;

    it.each([
      ['LEDGER_VERIFY=false', { IMMUDB_SERVER_SIGNING_PUBLIC_KEY: KEY }],
      ['no pinned key', { LEDGER_VERIFY: 'true' }],
      ['neither', {}],
    ])('refuses production with %s, naming both variables', (_case, env) => {
      const error = errorOf(() => ledgerConfig.parse({ ...PROD_ENABLED, ...env }));
      expect(error.namespace).toBe('ledger');
      expect(error.message).toContain('LEDGER_VERIFY');
      expect(error.message).toContain('IMMUDB_SERVER_SIGNING_PUBLIC_KEY');
      expect(error.message).toContain('LEDGER_ALLOW_UNVERIFIED');
    });

    it('accepts production with verification and a pinned key', () => {
      expect(
        ledgerConfig.parse({
          ...PROD_ENABLED,
          LEDGER_VERIFY: 'true',
          IMMUDB_SERVER_SIGNING_PUBLIC_KEY: KEY,
        }),
      ).toMatchObject({ enabled: true, verify: true, allowUnverified: false });
    });

    it('LEDGER_ALLOW_UNVERIFIED=true is the only opt-out', () => {
      expect(
        ledgerConfig.parse({ ...PROD_ENABLED, LEDGER_ALLOW_UNVERIFIED: 'true' }),
      ).toMatchObject({ enabled: true, verify: false, allowUnverified: true });
    });

    it('a disabled ledger in production and an enabled one elsewhere are unaffected', () => {
      expect(ledgerConfig.parse({ NODE_ENV: 'production' })).toMatchObject({ enabled: false });
      for (const NODE_ENV of ['development', 'test']) {
        expect(ledgerConfig.parse({ NODE_ENV, LEDGER_ENABLED: 'true' })).toMatchObject({
          enabled: true,
          verify: false,
        });
      }
    });
  });
});
