import { AuthModule, type Role, TokenService } from '@app/auth';
import { provideCommonEnhancers } from '@app/common';
import { AppConfigModule, redisConfig } from '@app/config';
import { AppGraphqlModule, GraphqlPubSubModule } from '@app/graphql';
import { REDIS_CLIENT, RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { createFastifyTestApp } from '@app/testing';
import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NotificationsPort } from '../../src/application/ports/notifications.port.js';

/** Stands in for the global RedisModule (auth denylist) — no connection. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: new InMemoryRedis().asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
export class FakeRedisModule {}

export type EdgeTestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

export interface EdgeTestAppOptions {
  port: NotificationsPort;
  controllers?: Type[];
  providers?: Provider[];
  graphql?: boolean;
}

/**
 * The real edge wiring with a FAKE port: config, the real AuthModule (global JWT → roles →
 * permissions guards, real TokenService), the common enhancers (both validation pipes,
 * problem+json filter), optionally Apollo + in-memory PubSub, on Fastify.
 */
export async function createEdgeTestApp(options: EdgeTestAppOptions): Promise<EdgeTestApp> {
  const builder = Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(),
      FakeRedisModule,
      AuthModule.forRootAsync(),
      ...(options.graphql
        ? [AppGraphqlModule.forRootAsync(), GraphqlPubSubModule.forRootAsync({ inMemory: true })]
        : []),
    ],
    controllers: options.controllers ?? [],
    providers: [
      ...provideCommonEnhancers({ exposeInternalErrors: true }),
      { provide: NotificationsPort, useValue: options.port },
      ...(options.providers ?? []),
    ],
  });
  return createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
}

/** A real access token (signed with the configured secret) for `user`. */
export async function bearer(
  app: EdgeTestApp,
  user: { id: string; roles: Role[]; email?: string },
): Promise<string> {
  const issued = await app.get(TokenService).issueAccessToken({
    id: user.id,
    email: user.email ?? 'ada@example.com',
    roles: user.roles,
  });
  return `Bearer ${issued.token}`;
}
