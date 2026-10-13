import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { redisConfig } from '@platform/config';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthModule } from './auth.module.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { Role } from './rbac/role.enum.js';
import { signTestAccessToken } from './testing/sign-test-access-token.js';
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
    const issued = await signTestAccessToken({ id: 'u-1', email: 'a@b.c', roles: [Role.Admin] });
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toMatchObject({ sub: 'u-1' });

    const denylist = app.get(AccessTokenDenylist);
    await denylist.deny(issued.jti, issued.exp);
    await expect(denylist.isDenied(issued.jti)).resolves.toBe(true);

    // JwtService defaults (no expiresIn, iss/aud set) stay compatible with TokenService.
    const raw = await app.get(JwtService).signAsync({ sub: 'x', typ: 'other' });
    expect(app.get(JwtService).decode<{ iss: string; aud: string }>(raw)).toMatchObject({
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
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
