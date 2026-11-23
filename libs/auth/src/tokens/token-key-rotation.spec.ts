import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type TenantRole, UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig, redisConfig } from '@platform/config';
import { RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { describe, expect, it } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { executionContext } from '../guards/execution-context.test.js';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import { JwtStrategy } from '../strategies/jwt.strategy.js';
import { createTestRbacRegistry } from '../testing/rbac-test.utils.js';
import { signTestAccessToken } from '../testing/sign-test-access-token.js';
import { AccessTokenDenylist } from './access-token-denylist.service.js';
import { TokenService } from './token.service.js';

/**
 * SEC-1: access secrets rotate in phases. A known `kid` selects that key only, an unknown `kid` is
 * INVALID_TOKEN, and a token without `kid` tries the signing key, then each verify-only key. Every
 * case runs through `TokenService` (gRPC, WebSocket, subscriptions) and through the passport
 * strategy behind `JwtAuthGuard` (HTTP, GraphQL).
 */

const A = 'rotation-old-access-secret-of-32-chars-aaaa';
const B = 'rotation-new-access-secret-of-32-chars-bbbb';
const user = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  roles: ['member'] satisfies TenantRole[],
};

const configOf = (env: Record<string, string>): AuthConfig =>
  authConfig.parse({ NODE_ENV: 'test', ...env });
const signWith = async (env: Record<string, string>): Promise<string> =>
  (await signTestAccessToken(user, { config: configOf(env) })).token;
const headerOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

const tokenServiceFor = (config: AuthConfig): TokenService =>
  new TokenService(
    new JwtService(createJwtModuleOptions(config)),
    config,
    createTestRbacRegistry(),
  );

const redis = new InMemoryRedis();
const guard = new JwtAuthGuard(new Reflector());
class Controller {
  secured(): void {
    // handler stub
  }
}

/** Outcome through TokenService: 'ok' or the 401 code. */
async function viaTokenService(config: AuthConfig, token: string): Promise<string> {
  try {
    await tokenServiceFor(config).verifyAccessToken(token);
    return 'ok';
  } catch (error) {
    if (error instanceof UnauthenticatedException) return error.code;
    throw error;
  }
}

/** Outcome through the passport strategy and the guard (HTTP): 'ok' or the 401 code. */
async function viaStrategy(config: AuthConfig, token: string): Promise<string> {
  const denylist = new AccessTokenDenylist(
    redis.asRedis(),
    new RedisKeyService(redisConfig.parse({})),
    config,
  );
  // Constructing it registers this verifier's strategy with passport under 'jwt'.
  new JwtStrategy(config, denylist, tokenServiceFor(config));
  const req: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
  try {
    await guard.canActivate(
      executionContext('http', { handler: Controller.prototype.secured, cls: Controller }, req),
    );
    return 'ok';
  } catch (error) {
    if (error instanceof UnauthenticatedException) return error.code;
    throw error;
  }
}

const verifiers = [
  ['TokenService', viaTokenService],
  ['the passport strategy', viaStrategy],
] as const;

describe.each(verifiers)('access key rotation through %s', (_name, verify) => {
  it('phase 2: a token signed with A and no kid verifies where B signs and A is verify-only', async () => {
    const token = await signWith({ JWT_ACCESS_SECRET: A });
    expect(headerOf(token)).not.toHaveProperty('kid');
    const rotating = configOf({
      JWT_ACCESS_SECRET: B,
      JWT_ACCESS_KEY_ID: 'kB',
      JWT_ACCESS_VERIFY_SECRETS: `kA:${A}`,
    });
    expect(await verify(rotating, token)).toBe('ok');
  });

  it('phase 1: a token signed with B under kid kB verifies where A signs and kB is verify-only', async () => {
    const token = await signWith({ JWT_ACCESS_SECRET: B, JWT_ACCESS_KEY_ID: 'kB' });
    expect(headerOf(token)).toMatchObject({ alg: 'HS256', kid: 'kB' });
    const phaseOne = configOf({ JWT_ACCESS_SECRET: A, JWT_ACCESS_VERIFY_SECRETS: `kB:${B}` });
    expect(await verify(phaseOne, token)).toBe('ok');
  });

  it('a known kid selects its key only: kA with B’s signature is refused', async () => {
    // Signed with B but labelled kA: the verifier must not fall through to B.
    const token = await signWith({ JWT_ACCESS_SECRET: B, JWT_ACCESS_KEY_ID: 'kA' });
    const rotating = configOf({
      JWT_ACCESS_SECRET: B,
      JWT_ACCESS_KEY_ID: 'kB',
      JWT_ACCESS_VERIFY_SECRETS: `kA:${A}`,
    });
    expect(await verify(rotating, token)).toBe('INVALID_TOKEN');
  });

  it('an unknown kid is refused even when the signature matches a listed key', async () => {
    const rotating = configOf({
      JWT_ACCESS_SECRET: B,
      JWT_ACCESS_KEY_ID: 'kB',
      JWT_ACCESS_VERIFY_SECRETS: `kA:${A}`,
    });
    for (const secret of [A, B]) {
      const token = await signWith({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_KEY_ID: 'kX' });
      expect(await verify(rotating, token)).toBe('INVALID_TOKEN');
    }
  });

  it('an unknown kid is refused by a verifier with one secret and no key id', async () => {
    // Strict: a kid only verifies where it is configured (introduce it as verify-only first).
    const token = await signWith({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' });
    expect(await verify(configOf({ JWT_ACCESS_SECRET: A }), token)).toBe('INVALID_TOKEN');
    expect(await verify(configOf({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' }), token)).toBe(
      'ok',
    );
  });

  it('phase 3: removing A from the list refuses A’s tokens, with or without kid', async () => {
    const plain = await signWith({ JWT_ACCESS_SECRET: A });
    const labelled = await signWith({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' });
    const withA = configOf({
      JWT_ACCESS_SECRET: B,
      JWT_ACCESS_KEY_ID: 'kB',
      JWT_ACCESS_VERIFY_SECRETS: `kA:${A}`,
    });
    expect(await verify(withA, plain)).toBe('ok');
    expect(await verify(withA, labelled)).toBe('ok');
    const withoutA = configOf({ JWT_ACCESS_SECRET: B, JWT_ACCESS_KEY_ID: 'kB' });
    expect(await verify(withoutA, plain)).toBe('INVALID_TOKEN');
    expect(await verify(withoutA, labelled)).toBe('INVALID_TOKEN');
  });

  it('keeps TOKEN_EXPIRED for an expired token signed with a verify-only key', async () => {
    const expired = await new JwtService().signAsync(
      { sub: user.id, typ: 'access', iat: 1_000, exp: 2_000 },
      {
        secret: A,
        algorithm: 'HS256',
        issuer: 'nestjs-boilerplate',
        audience: 'nestjs-boilerplate',
      },
    );
    const rotating = configOf({
      JWT_ACCESS_SECRET: B,
      JWT_ACCESS_KEY_ID: 'kB',
      JWT_ACCESS_VERIFY_SECRETS: `kA:${A}`,
    });
    expect(await verify(rotating, expired)).toBe('TOKEN_EXPIRED');
  });
});

describe('mixed versions', () => {
  it('an old single-secret replica (one secret, kid ignored) accepts a kid-bearing token', async () => {
    const config = configOf({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' });
    const token = await signWith({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' });
    expect(headerOf(token)).toMatchObject({ kid: 'kA' });
    // The pre-rotation verifier: one secret passed straight to jsonwebtoken.
    const settings = tokenServiceFor(config).verificationSettings;
    await expect(
      new JwtService().verifyAsync(token, { secret: A, ...settings }),
    ).resolves.toMatchObject({ sub: user.id });
  });

  it('the unknown-kid refusal names no key id', async () => {
    const token = await signWith({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'secret-kid-x' });
    const error: unknown = await tokenServiceFor(
      configOf({ JWT_ACCESS_SECRET: A, JWT_ACCESS_KEY_ID: 'kA' }),
    )
      .verifyAccessToken(token)
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(UnauthenticatedException);
    const refused = error as UnauthenticatedException;
    expect(refused.code).toBe('INVALID_TOKEN');
    for (const part of [
      refused.message,
      JSON.stringify(refused.details ?? null),
      String(refused.cause),
    ]) {
      expect(part).not.toContain('secret-kid-x');
    }
  });
});
