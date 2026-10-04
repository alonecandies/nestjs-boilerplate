import { Public, UnauthenticatedException } from '@app/common';
import { authConfig, redisConfig } from '@app/config';
import { RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { Role } from '../rbac/role.enum.js';
import { JwtStrategy } from '../strategies/jwt.strategy.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { TokenService } from '../tokens/token.service.js';
import { executionContext, type Transport } from './execution-context.test.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const config = authConfig.parse({ NODE_ENV: 'test' });
const tokens = new TokenService(new JwtService(createJwtModuleOptions(config)), config);
const redis = new InMemoryRedis();
const denylist = new AccessTokenDenylist(
  redis.asRedis(),
  new RedisKeyService(redisConfig.parse({})),
  config,
);
// Constructing the strategy registers it with passport under 'jwt' (what the guard runs).
const strategy = new JwtStrategy(config, denylist);
const guard = new JwtAuthGuard(new Reflector());

class Controller {
  secured(): void {
    // handler stub
  }

  @Public()
  open(): void {
    // handler stub
  }
}

const target = (handler: () => void = Controller.prototype.secured) => ({
  handler,
  cls: Controller,
});
const bearer = async (roles = [Role.User]): Promise<{ token: string; jti: string; exp: number }> =>
  tokens.issueAccessToken({ id: 'u-1', email: 'a@b.c', roles });

async function failureCode(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthenticatedException);
  return (error as UnauthenticatedException).code;
}

describe('JwtAuthGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates a Bearer token and sets req.user (http)', async () => {
    const { token, jti } = await bearer();
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
    await expect(guard.canActivate(executionContext('http', target(), req))).resolves.toBe(true);
    expect(req.user).toMatchObject({ id: 'u-1', roles: [Role.User], jti });
    expect(strategy.name).toBe('jwt');
  });

  it('authenticates GraphQL operations through ctx.req', async () => {
    const { token } = await bearer([Role.Admin]);
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
    await expect(guard.canActivate(executionContext('graphql', target(), req))).resolves.toBe(true);
    expect(req.user).toMatchObject({ roles: [Role.Admin] });
  });

  it('rejects missing, malformed, revoked and expired tokens with distinct codes', async () => {
    const run = (headers: Record<string, string>, type: Transport = 'http') =>
      guard.canActivate(executionContext(type, target(), { headers }));

    await expect(failureCode(run({}))).resolves.toBe('MISSING_TOKEN');
    await expect(failureCode(run({ authorization: 'Bearer nope' }))).resolves.toBe('INVALID_TOKEN');

    const revoked = await bearer();
    await denylist.deny(revoked.jti, revoked.exp);
    await expect(failureCode(run({ authorization: `Bearer ${revoked.token}` }))).resolves.toBe(
      'TOKEN_REVOKED',
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    const expiring = await bearer();
    vi.setSystemTime(Date.now() + (config.accessTtlSec + 10) * 1_000);
    await expect(failureCode(run({ authorization: `Bearer ${expiring.token}` }))).resolves.toBe(
      'TOKEN_EXPIRED',
    );
  });

  it('skips @Public() handlers and rpc handlers without parsing anything', async () => {
    await expect(
      guard.canActivate(executionContext('http', target(Controller.prototype.open))),
    ).resolves.toBe(true);
    await expect(guard.canActivate(executionContext('rpc', target()))).resolves.toBe(true);
  });

  it('for WebSockets, requires the handshake user and rejects it once the token expired', async () => {
    const wsContext = (user: unknown) =>
      executionContext('ws', target(), { data: user === undefined ? {} : { user } });
    await expect(guard.canActivate(wsContext(makeAuthUser()))).resolves.toBe(true);
    await expect(failureCode(guard.canActivate(wsContext(undefined)))).resolves.toBe(
      'MISSING_TOKEN',
    );
    const stale = makeAuthUser({ exp: Math.floor(Date.now() / 1_000) - 1 });
    await expect(failureCode(guard.canActivate(wsContext(stale)))).resolves.toBe('TOKEN_EXPIRED');
  });

  it('401s when a GraphQL context carries no request', async () => {
    const context = executionContext('graphql', target());
    vi.spyOn(context, 'getArgByIndex').mockReturnValue(undefined);
    await expect(failureCode(guard.canActivate(context))).resolves.toBe('MISSING_TOKEN');
  });
});
