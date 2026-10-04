/*
 * Edge test harness: real AuthModule (JWT guards → RBAC guards, tokens issued by the real
 * TokenService with the dev/test secret), Redis replaced by the in-memory fake, and the common
 * enhancers (both validation pipes + problem+json filter) exactly as the apps install them.
 */

import { Role, TokenService } from '@app/auth';
import { generateId } from '@app/common';
import { redisConfig } from '@app/config';
import { REDIS_CLIENT, RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
  const { token } = await app.get(TokenService).issueAccessToken({ id, email, roles });
  return { id, email, authorization: `Bearer ${token}` };
}

export { Role };
