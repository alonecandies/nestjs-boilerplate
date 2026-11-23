import { EnvValidationError, validateAllEnv } from '@platform/config';
import { RATE_LIMIT_POLICY_KEY } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { AuthResolver } from '../graphql/auth.resolver.js';
import { AuthController } from '../http/auth.controller.js';
import { identityRateLimitConfig } from './identity-rate-limit.config.js';
import { IDENTITY_RATE_LIMITS, identityRateLimitPolicies } from './identity-rate-limit.js';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('identity rate-limit policies', () => {
  it('declares identity.credentials from IDENTITY_* env with lockout', () => {
    expect(identityRateLimitPolicies(identityRateLimitConfig.parse({}))).toEqual([
      {
        name: 'identity.credentials',
        key: 'credentials',
        limit: 10,
        ttlMs: 60_000,
        credentialField: 'email',
        lockout: { threshold: 10, durationMs: 900_000 },
      },
    ]);
    const tuned = identityRateLimitConfig.parse({
      IDENTITY_CREDENTIALS_LIMIT: '3',
      IDENTITY_CREDENTIALS_TTL_MS: '1000',
      IDENTITY_LOCKOUT_THRESHOLD: '5',
      IDENTITY_LOCKOUT_MS: '2000',
    });
    expect(identityRateLimitPolicies(tuned)[0]).toMatchObject({
      limit: 3,
      ttlMs: 1_000,
      lockout: { threshold: 5, durationMs: 2_000 },
    });
  });

  it('every credential endpoint (REST and GraphQL) uses identity.credentials', () => {
    for (const handler of [
      AuthController.prototype.register,
      AuthController.prototype.login,
      AuthResolver.prototype.register,
      AuthResolver.prototype.login,
    ]) {
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe(
        IDENTITY_RATE_LIMITS.CREDENTIALS,
      );
    }
  });

  // THROTTLE_AUTH_* moved to IDENTITY_CREDENTIALS_* (F6); setting a removed name must not be ignored.
  it.each([
    ['THROTTLE_AUTH_LIMIT', /set IDENTITY_CREDENTIALS_LIMIT instead/],
    ['THROTTLE_AUTH_TTL_MS', /set IDENTITY_CREDENTIALS_TTL_MS instead/],
  ])(
    'fails validation when the removed %s is set, naming its replacement',
    (legacy, replacement) => {
      const error = errorOf(() => identityRateLimitConfig.parse({ [legacy]: '7' }));
      expect(error.issues).toHaveLength(1);
      expect(error.issues[0]?.path).toEqual([legacy]);
      expect(error.issues[0]?.message).toMatch(replacement);
      expect(error.message).toContain(legacy);
      expect(
        errorOf(() => validateAllEnv({ [legacy]: '7' }, [identityRateLimitConfig])).message,
      ).toMatch(replacement);
    },
  );

  it('a blank removed variable is unset, like every other variable', () => {
    expect(() =>
      identityRateLimitConfig.parse({ THROTTLE_AUTH_LIMIT: '', THROTTLE_AUTH_TTL_MS: ' ' }),
    ).not.toThrow();
  });
});
