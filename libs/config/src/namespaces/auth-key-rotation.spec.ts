import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';

/**
 * SEC-1: the access secret rotates in phases. `JWT_ACCESS_KEY_ID` names the signing key (the
 * `kid` header) and `JWT_ACCESS_VERIFY_SECRETS` lists verify-only `kid:secret` keys. Every listed
 * secret passes the guards the signing secret passes, and no message echoes a secret or a key id.
 */

const A = 'a-strong-access-secret-of-at-least-32-chars-0001';
const C = 'a-strong-access-secret-of-at-least-32-chars-0003';
const SIGNER = 'the-current-access-signing-secret-of-32-chars-0002';
const PROD = { NODE_ENV: 'production', JWT_ACCESS_SECRET: SIGNER } as const;

const expectNoLeak = (message: string, ...values: string[]): void => {
  for (const value of values) expect(message).not.toContain(value);
};

describe('auth key rotation settings', () => {
  it('default to no key id and no verify-only keys (one secret, as before)', () => {
    expect(authConfig.parse({})).toMatchObject({ accessKeyId: undefined, accessVerifyKeys: [] });
  });

  it('read the signing key id and the verify-only kid:secret list, trimmed', () => {
    const config = authConfig.parse({
      JWT_ACCESS_KEY_ID: ' key-2026.11 ',
      JWT_ACCESS_VERIFY_SECRETS: ` k1:${A} ,, k0 : ${C} `,
    });
    expect(config).toMatchObject({
      accessKeyId: 'key-2026.11',
      accessVerifyKeys: [
        { kid: 'k1', secret: A },
        { kid: 'k0', secret: C },
      ],
    });
  });

  it('split each entry on its first colon only, so a secret may contain colons', () => {
    const secret = `${A}:with:colons`;
    expect(
      authConfig.parse({ JWT_ACCESS_VERIFY_SECRETS: `k1:${secret}` }).accessVerifyKeys,
    ).toEqual([{ kid: 'k1', secret }]);
  });

  it.each([
    ['no colon', A],
    ['an empty kid', `:${A}`],
    ['a kid with a space', `old key:${A}`],
    ['a kid longer than 64 characters', `${'k'.repeat(65)}:${A}`],
  ])('refuse an entry with %s, naming its position only', (_case, value) => {
    const error = errorOf(() =>
      authConfig.parse({ JWT_ACCESS_VERIFY_SECRETS: `k0:${C},${value}` }),
    );
    expect(error.message).toContain('→ at JWT_ACCESS_VERIFY_SECRETS');
    expect(error.message).toContain('entry 2');
    expectNoLeak(error.message, A, C, 'old key', 'kkkk');
  });

  it('refuse a verify-only secret shorter than 32 characters in every environment', () => {
    const error = errorOf(() =>
      authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_VERIFY_SECRETS: 'k1:short-secret' }),
    );
    expect(error.message).toContain('→ at JWT_ACCESS_VERIFY_SECRETS');
    expect(error.message).toContain('32');
    expectNoLeak(error.message, 'short-secret', 'k1');
  });

  it('refuse a key id listed twice, or the signing key id listed as verify-only', () => {
    const twice = errorOf(() =>
      authConfig.parse({ JWT_ACCESS_VERIFY_SECRETS: `dup-kid:${A},dup-kid:${C}` }),
    );
    expect(twice.message).toContain('→ at JWT_ACCESS_VERIFY_SECRETS');
    expect(twice.message).toContain('entry 2');
    expectNoLeak(twice.message, 'dup-kid', A, C);

    const signing = errorOf(() =>
      authConfig.parse({
        JWT_ACCESS_KEY_ID: 'same-kid',
        JWT_ACCESS_VERIFY_SECRETS: `same-kid:${A}`,
      }),
    );
    expect(signing.message).toContain('JWT_ACCESS_KEY_ID');
    expectNoLeak(signing.message, 'same-kid', A);
  });

  it('refuse a malformed JWT_ACCESS_KEY_ID without echoing it', () => {
    const error = errorOf(() => authConfig.parse({ JWT_ACCESS_KEY_ID: 'bad kid/value' }));
    expect(error.message).toContain('→ at JWT_ACCESS_KEY_ID');
    expectNoLeak(error.message, 'bad kid/value');
  });

  it('refuse the development default inside the verify list in production, even with the opt-out', () => {
    for (const optOut of ['false', 'true']) {
      const error = errorOf(() =>
        authConfig.parse({
          ...PROD,
          ALLOW_KNOWN_LOCAL_SECRETS: optOut,
          JWT_ACCESS_VERIFY_SECRETS: `k1:${A},k0:${DEV_JWT_ACCESS_SECRET}`,
        }),
      );
      expect(error.message).toContain('→ at JWT_ACCESS_VERIFY_SECRETS');
      expect(error.message).toContain('development default');
      expectNoLeak(error.message, DEV_JWT_ACCESS_SECRET, A, 'k0');
    }
  });

  it('refuse a publicly known value inside the verify list in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const known = 'compose-local-access-secret-not-for-production-0001';
    const env = { ...PROD, JWT_ACCESS_VERIFY_SECRETS: `k1:${known}` };
    const error = errorOf(() => authConfig.parse(env));
    expect(error.message).toContain('→ at JWT_ACCESS_VERIFY_SECRETS');
    expect(error.message).toContain('is a publicly known value');
    expectNoLeak(error.message, known);
    expect(
      authConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).accessVerifyKeys,
    ).toEqual([{ kid: 'k1', secret: known }]);
  });

  it('accept strong verify-only secrets in production', () => {
    expect(
      authConfig.parse({
        ...PROD,
        JWT_ACCESS_KEY_ID: 'k2',
        JWT_ACCESS_VERIFY_SECRETS: `k1:${A},k0:${C}`,
      }),
    ).toMatchObject({
      accessSecret: SIGNER,
      accessKeyId: 'k2',
      accessVerifyKeys: [{ kid: 'k1' }, { kid: 'k0' }],
    });
  });
});
