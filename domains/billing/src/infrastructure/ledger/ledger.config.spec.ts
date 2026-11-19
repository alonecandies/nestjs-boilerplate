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
    });
  });

  it('keeps its Nest config token', () => {
    expect(ledgerConfig.KEY).toBe('CONFIGURATION(ledger)');
  });

  it('reads the three variables of the contract', () => {
    expect(
      ledgerConfig.parse({
        LEDGER_ENABLED: 'true',
        LEDGER_RECONCILE_LOOKBACK_HOURS: '24',
        LEDGER_VERIFY: 'true',
      }),
    ).toEqual({ enabled: true, reconcileLookbackHours: 24, verify: true });
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
});
