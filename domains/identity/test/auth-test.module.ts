import { Global, type INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule, RbacModule } from '@platform/auth';
import { signTestAccessToken, TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId, type TenantRole } from '@platform/common';
import { AppConfigModule, type AuthConfig, authConfig, redisConfig } from '@platform/config';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { IDENTITY_RBAC } from '../src/identity.permissions.js';

/** Stands in for the global RedisModule (denylist + keys) — no connection. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
export class FakeRedisModule {}

/**
 * The real auth stack of an edge app: config, JWT verification (dev secrets), the
 * denylist on an in-memory Redis, the identity RBAC vocabulary and the GLOBAL guards (JwtAuthGuard → RolesGuard →
 * PermissionsGuard). Requests in tests carry genuine signed tokens.
 */
export const AUTH_TEST_IMPORTS = [
  AppConfigModule.forRoot(),
  FakeRedisModule,
  AuthModule.forRootAsync(),
  RbacModule.forFeature(IDENTITY_RBAC),
];

export interface TestPrincipal {
  id: string;
  token: string;
  jti: string;
  exp: number;
}

/** A real access token for a user with `roles` in `tenantId`, signed with the app's `auth` config. */
export async function principal(
  app: INestApplication,
  roles: TenantRole[],
  id: string = generateId(),
  tenantId: string = TEST_TENANT_ID,
): Promise<TestPrincipal> {
  const issued = await signTestAccessToken(
    { id, email: 'p@example.com', tenantId, roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
  return { id, token: issued.token, jti: issued.jti, exp: issued.exp };
}

export const bearer = (who: TestPrincipal): { authorization: string } => ({
  authorization: `Bearer ${who.token}`,
});
