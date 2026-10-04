import { AuthModule, type Role, TokenService } from '@app/auth';
import { generateId } from '@app/common';
import { AppConfigModule, redisConfig } from '@app/config';
import { REDIS_CLIENT, RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/** Stands in for the global RedisModule (denylist + keys) — no connection. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
export class FakeRedisModule {}

/**
 * The real auth stack of an edge app: config, JWT issuing/verification (dev secrets), the
 * denylist on an in-memory Redis and the GLOBAL guards (JwtAuthGuard → RolesGuard →
 * PermissionsGuard). Requests in tests carry genuine signed tokens.
 */
export const AUTH_TEST_IMPORTS = [
  AppConfigModule.forRoot(),
  FakeRedisModule,
  AuthModule.forRootAsync(),
];

export interface TestPrincipal {
  id: string;
  token: string;
  jti: string;
  exp: number;
}

/** Issues a real access token for a user with `roles`. */
export async function principal(
  app: INestApplication,
  roles: Role[],
  id: string = generateId(),
): Promise<TestPrincipal> {
  const issued = await app
    .get(TokenService)
    .issueAccessToken({ id, email: 'p@example.com', roles });
  return { id, token: issued.token, jti: issued.jti, exp: issued.exp };
}

export const bearer = (who: TestPrincipal): { authorization: string } => ({
  authorization: `Bearer ${who.token}`,
});
