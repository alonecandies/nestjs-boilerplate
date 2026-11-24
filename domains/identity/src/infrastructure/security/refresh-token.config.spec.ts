import { DEV_JWT_ACCESS_SECRET, EnvValidationError } from '@platform/config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEV_JWT_REFRESH_SECRET,
  type RefreshTokenConfig,
  refreshTokenConfig,
} from './refresh-token.config.js';

const PROD = { NODE_ENV: 'production' } as const;
/** The docker-compose fallback for JWT_REFRESH_SECRET (publicly known). */
const COMPOSE_REFRESH_SECRET = 'compose-local-refresh-secret-not-for-production-0002';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('refreshToken config namespace', () => {
  it('defaults to the development secret and a 7-day TTL, never exposing the access secret', () => {
    expect(refreshTokenConfig.parse({})).toEqual({
      refreshSecret: DEV_JWT_REFRESH_SECRET,
      refreshTtlSec: 604_800,
      refreshKeyId: undefined,
      refreshVerifyKeys: [],
    } satisfies RefreshTokenConfig);
    expect(refreshTokenConfig.KEY).toBe('CONFIGURATION(refreshToken)');
    expectTypeOf<RefreshTokenConfig['refreshSecret']>().toEqualTypeOf<string>();
    expectTypeOf<RefreshTokenConfig['refreshTtlSec']>().toEqualTypeOf<number>();
  });

  it('requires a secret of at least 32 characters in every environment', () => {
    const error = errorOf(() => refreshTokenConfig.parse({ JWT_REFRESH_SECRET: 'short' }));
    expect(error.namespace).toBe('refreshToken');
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
  });

  it('rejects the development default in production, even with the opt-out', () => {
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }),
    );
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
    expect(error.message).toContain('development default');
    expect(error.message).not.toContain(DEV_JWT_REFRESH_SECRET);
  });

  it('rejects the compose fallback in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = { ...PROD, JWT_REFRESH_SECRET: COMPOSE_REFRESH_SECRET };
    expect(errorOf(() => refreshTokenConfig.parse(env)).message).toContain(
      'ALLOW_KNOWN_LOCAL_SECRETS',
    );
    expect(
      refreshTokenConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).refreshSecret,
    ).toBe(COMPOSE_REFRESH_SECRET);
  });

  it('rejects a refresh secret equal to the access secret in production', () => {
    const same = 's'.repeat(48);
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }),
    );
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
    expect(error.message).toContain('must differ');
  });

  it('accepts a strong distinct secret in production and the dev default elsewhere', () => {
    expect(
      refreshTokenConfig.parse({
        ...PROD,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
      }).refreshSecret,
    ).toBe('b'.repeat(48));
    expect(refreshTokenConfig.parse({ NODE_ENV: 'test' }).refreshSecret).toBe(
      DEV_JWT_REFRESH_SECRET,
    );
    // The access secret is only compared here; the platform `auth` namespace owns its rules.
    expect(() =>
      refreshTokenConfig.parse({ JWT_ACCESS_SECRET: DEV_JWT_ACCESS_SECRET }),
    ).not.toThrow();
  });
});

describe('refreshToken production guards match the platform ones', () => {
  const PROD = { NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(48) } as const;

  it.each([
    'compose-local-refresh-secret-not-for-production-0002',
    '<a random secret of at least 32 characters>',
    'set-a-real-refresh-secret-here-please-...',
  ])('refuses the publicly known value %s with the shared message and opt-out', (value) => {
    const env = { ...PROD, JWT_REFRESH_SECRET: value };
    const error = errorOf(() => refreshTokenConfig.parse(env));
    expect(error.message).toContain('JWT_REFRESH_SECRET is a publicly known value');
    expect(error.message).toContain('ALLOW_KNOWN_LOCAL_SECRETS=true');
    expect(() =>
      refreshTokenConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }),
    ).not.toThrow();
  });

  it('compares with the auth default when JWT_ACCESS_SECRET is unset', () => {
    // refreshToken reads JWT_ACCESS_SECRET only for the must-differ rule. Its default must be auth's, or a refresh
    // secret equal to the access secret the services really use would pass.
    const error = errorOf(() =>
      refreshTokenConfig.parse({
        NODE_ENV: 'production',
        JWT_REFRESH_SECRET: DEV_JWT_ACCESS_SECRET,
        ALLOW_KNOWN_LOCAL_SECRETS: 'true',
      }),
    );
    expect(error.message).toContain('must differ');
  });
});

describe('refreshToken key rotation settings (SEC-1)', () => {
  const ACCESS = 'a-strong-access-secret-of-at-least-32-chars-0001';
  const OLD = 'a-strong-refresh-secret-of-at-least-32-chars-0001';
  const NEW = 'a-strong-refresh-secret-of-at-least-32-chars-0002';
  const PROD = {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: ACCESS,
    JWT_REFRESH_SECRET: NEW,
  } as const;

  it('reads the refresh key id and the verify-only kid:secret list', () => {
    expect(
      refreshTokenConfig.parse({
        ...PROD,
        JWT_REFRESH_KEY_ID: 'r2',
        JWT_REFRESH_VERIFY_SECRETS: `r1:${OLD}`,
      }),
    ).toEqual({
      refreshSecret: NEW,
      refreshTtlSec: 604_800,
      refreshKeyId: 'r2',
      refreshVerifyKeys: [{ kid: 'r1', secret: OLD }],
    } satisfies RefreshTokenConfig);
  });

  it('refuses a short verify-only secret and a malformed entry in every environment', () => {
    const short = errorOf(() =>
      refreshTokenConfig.parse({ JWT_REFRESH_VERIFY_SECRETS: 'r1:short' }),
    );
    expect(short.message).toContain('→ at JWT_REFRESH_VERIFY_SECRETS');
    const malformed = errorOf(() => refreshTokenConfig.parse({ JWT_REFRESH_VERIFY_SECRETS: OLD }));
    expect(malformed.message).toContain('entry 1');
    expect(malformed.message).not.toContain(OLD);
  });

  it.each([DEV_JWT_REFRESH_SECRET, DEV_JWT_ACCESS_SECRET])(
    'refuses a development default inside the verify list in production, even with the opt-out',
    (devDefault) => {
      const error = errorOf(() =>
        refreshTokenConfig.parse({
          ...PROD,
          ALLOW_KNOWN_LOCAL_SECRETS: 'true',
          JWT_REFRESH_VERIFY_SECRETS: `r1:${devDefault}`,
        }),
      );
      expect(error.message).toContain('→ at JWT_REFRESH_VERIFY_SECRETS');
      expect(error.message).not.toContain(devDefault);
    },
  );

  it('refuses a publicly known value inside the verify list in production', () => {
    const known = 'compose-local-refresh-secret-not-for-production-0002';
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, JWT_REFRESH_VERIFY_SECRETS: `r1:${known}` }),
    );
    expect(error.message).toContain('is a publicly known value');
    expect(error.message).not.toContain(known);
  });

  it('names the entry of a publicly known value inside the verify list', () => {
    const known = 'compose-local-refresh-secret-not-for-production-0002';
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, JWT_REFRESH_VERIFY_SECRETS: `r1:${OLD},r2:${known}` }),
    );
    expect(error.message).toContain('JWT_REFRESH_VERIFY_SECRETS entry 2 is a publicly known value');
    expect(error.message).not.toContain(known);
  });

  it('refuses a secret listed twice under two key ids in every environment, naming both entries', () => {
    for (const env of [{ NODE_ENV: 'test' }, PROD]) {
      const error = errorOf(() =>
        refreshTokenConfig.parse({ ...env, JWT_REFRESH_VERIFY_SECRETS: `r1:${OLD},r2:${OLD}` }),
      );
      expect(error.message).toContain('→ at JWT_REFRESH_VERIFY_SECRETS');
      expect(error.message).toContain('entry 1');
      expect(error.message).toContain('entry 2');
      for (const value of [OLD, 'r1', 'r2']) expect(error.message).not.toContain(value);
    }
  });

  it('keeps the access and refresh sets disjoint in production, verify-only keys included', () => {
    const cases = [
      // A verify-only refresh secret equal to the access signing secret.
      { JWT_REFRESH_VERIFY_SECRETS: `r1:${ACCESS}` },
      // The refresh signing secret equal to a verify-only access secret.
      { JWT_ACCESS_VERIFY_SECRETS: `a1:${NEW}` },
      // A verify-only secret in both lists.
      { JWT_ACCESS_VERIFY_SECRETS: `a1:${OLD}`, JWT_REFRESH_VERIFY_SECRETS: `r1:${OLD}` },
    ];
    for (const extra of cases) {
      const error = errorOf(() => refreshTokenConfig.parse({ ...PROD, ...extra }));
      expect(error.message, JSON.stringify(Object.keys(extra))).toContain('must differ');
      for (const secret of [ACCESS, OLD, NEW]) expect(error.message).not.toContain(secret);
    }
  });
});
