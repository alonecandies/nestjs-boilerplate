import { EnvValidationError } from '@platform/config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type PasswordConfig, passwordConfig } from './password.config.js';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('password config namespace', () => {
  it('defaults to the OWASP Argon2id baseline with an empty environment', () => {
    expect(passwordConfig.parse({})).toEqual({
      argon2: { memoryCost: 19_456, timeCost: 2, parallelism: 1 },
    } satisfies PasswordConfig);
    expect(passwordConfig.KEY).toBe('CONFIGURATION(password)');
  });

  it('coerces the ARGON2_* variables', () => {
    expect(
      passwordConfig.parse({
        ARGON2_MEMORY_COST: '1024',
        ARGON2_TIME_COST: '1',
        ARGON2_PARALLELISM: '4',
      }).argon2,
    ).toEqual({ memoryCost: 1024, timeCost: 1, parallelism: 4 });
  });

  it.each([
    ['ARGON2_MEMORY_COST', '4'],
    ['ARGON2_TIME_COST', '0'],
    ['ARGON2_PARALLELISM', '256'],
  ])('rejects %s=%s by name', (variable, value) => {
    const error = errorOf(() => passwordConfig.parse({ [variable]: value }));
    expect(error.namespace).toBe('password');
    expect(error.message).toContain(`→ at ${variable}`);
  });

  it('keeps precise inferred types', () => {
    expectTypeOf<PasswordConfig['argon2']['memoryCost']>().toEqualTypeOf<number>();
  });
});
