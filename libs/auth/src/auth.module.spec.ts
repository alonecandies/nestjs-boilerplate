import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { generateId } from '@platform/common';
import { redisConfig } from '@platform/config';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthErrorCode } from './auth.constants.js';
import { AuthModule } from './auth.module.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { signTestAccessToken } from './testing/sign-test-access-token.js';
import { TEST_TENANT_ID } from './testing/test-tenant.js';
import { AccessTokenDenylist } from './tokens/access-token-denylist.service.js';
import { TokenService } from './tokens/token.service.js';

/** Stands in for the global RedisModule (no connection). */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
class FakeRedisModule {}

describe('AuthModule (DI wiring)', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('provides token verification and the denylist from config', async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AuthModule.forRootAsync(),
      ],
    })
    class TestModule {}
    app = await NestFactory.createApplicationContext(TestModule, { logger: false });

    const tokens = app.get(TokenService);
    // Signed with the `auth` namespace of process.env: the config this module loaded.
    const issued = await signTestAccessToken({ id: 'u-1', email: 'a@b.c', roles: ['admin'] });
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toMatchObject({ sub: 'u-1' });

    const denylist = app.get(AccessTokenDenylist);
    await denylist.deny(issued.jti, issued.exp);
    await expect(denylist.isDenied(issued.jti)).resolves.toBe(true);

    // This package only verifies: its JwtService has no signing defaults (algorithm, iss, aud), so
    // a stray `sign()` through it can never mint an access token that TokenService accepts.
    const jwt = app.get(JwtService);
    const now = Math.floor(Date.now() / 1_000);
    const stray = await jwt.signAsync({
      sub: 'u-1',
      email: 'a@b.c',
      tid: TEST_TENANT_ID,
      roles: ['admin'],
      typ: 'access',
      jti: generateId(),
      iat: now,
      exp: now + 60,
    });
    expect(jwt.decode(stray)).not.toHaveProperty('iss');
    expect(jwt.decode(stray)).not.toHaveProperty('aud');
    await expect(tokens.verifyAccessToken(stray)).rejects.toMatchObject({
      code: AuthErrorCode.INVALID_TOKEN,
    });
    expect(app.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
  });

  it('registers the three guards globally in auth → roles → permissions order unless disabled', () => {
    const globalGuards = (AuthModule.forRootAsync().providers ?? []).filter(
      (provider) =>
        typeof provider === 'object' && 'provide' in provider && provider.provide === APP_GUARD,
    );
    expect(globalGuards.map((provider) => Reflect.get(provider, 'useExisting'))).toEqual([
      JwtAuthGuard,
      RolesGuard,
      PermissionsGuard,
    ]);
    const serviceSetup = AuthModule.forRootAsync({ globalGuards: false });
    expect(serviceSetup.global).toBe(true);
    expect(serviceSetup.providers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ provide: APP_GUARD })]),
    );
  });
});
