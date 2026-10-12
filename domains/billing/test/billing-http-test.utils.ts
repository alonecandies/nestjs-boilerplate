/*
 * Edge test harness: real AuthModule (JWT guards → RBAC guards; tokens signed by
 * signTestAccessToken with the app's auth config), Redis replaced by the in-memory fake, and the
 * common enhancers (both validation pipes + problem+json filter) exactly as the apps install them.
 */

import { Global, type INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
import { generateId } from '@platform/common';
import { type AuthConfig, authConfig, redisConfig } from '@platform/config';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';

/** Stands in for the global RedisModule (access-token denylist) — no connection. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
export class FakeRedisModule {}

export interface TestPrincipal {
  id: string;
  email: string;
  authorization: string;
}

/** A real access token for a user with `roles` (permissions derived like production). */
export async function loginAs(app: INestApplication, ...roles: Role[]): Promise<TestPrincipal> {
  const id = generateId();
  const email = `${roles.join('-') || 'nobody'}-${id.slice(-6)}@example.com`;
  const { token } = await signTestAccessToken(
    { id, email, roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
  return { id, email, authorization: `Bearer ${token}` };
}

export { Role };
