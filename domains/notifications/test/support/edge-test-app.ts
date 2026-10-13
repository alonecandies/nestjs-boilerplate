import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule, type Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
import { provideCommonEnhancers } from '@platform/common';
import { AppConfigModule, type AuthConfig, authConfig, redisConfig } from '@platform/config';
import { AppGraphqlModule, GraphqlPubSubModule } from '@platform/graphql';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { createFastifyTestApp } from '@platform/testing';
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
 * permissions guards, real token verification), the common enhancers (both validation pipes,
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

/** A real access token (signed with the app's `auth` config) for `user`. */
export async function bearer(
  app: EdgeTestApp,
  user: { id: string; roles: Role[]; email?: string },
): Promise<string> {
  const issued = await signTestAccessToken(
    { id: user.id, email: user.email ?? 'ada@example.com', roles: user.roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
  return `Bearer ${issued.token}`;
}
