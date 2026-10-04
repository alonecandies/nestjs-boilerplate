import { AccessTokenDenylist, TokenService } from '@app/auth';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@app/bootstrap';
import { appConfig } from '@app/config';
import { GRAPHQL_PUB_SUB } from '@app/graphql';
import { AuthPort, UsersPort } from '@app/identity';
import { NotificationsPort } from '@app/notifications';
import { createL1Store, REDIS_CLIENT } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { InMemoryStorageService, StorageService } from '@app/storage';
import { createFastifyTestApp } from '@app/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createCache } from 'cache-manager';
import { PubSub } from 'graphql-subscriptions';
import { GATEWAY_API_DOCS } from '../../src/app.constants.js';
import { AppModule } from '../../src/app.module.js';
import {
  FakeAuthPort,
  FakeIdentityState,
  FakeNotificationsPort,
  FakeUsersPort,
} from './fake-upstreams.js';

export type GatewayE2e = Awaited<ReturnType<typeof createGatewayE2eApp>>;

/**
 * Boots the REAL gateway `AppModule` with the production HTTP wiring (`buildFastifyOptions` +
 * `configureHttpApp` + `setupApiDocs`, raw body + multipart like `main.ts`) and fakes only at the
 * network edges:
 *
 * | provider                          | fake                                                   |
 * |-----------------------------------|--------------------------------------------------------|
 * | `REDIS_CLIENT` (denylist, throttler) | `InMemoryRedis`                                     |
 * | `AuthPort`, `UsersPort`           | fake identity-service (`FakeAuthPort`/`FakeUsersPort`) |
 * | `NotificationsPort`               | fake notifications-service inbox                       |
 * | `BillingPort`                     | NOT faked: the real gRPC adapter → a dead upstream     |
 * | `CACHE_MANAGER`                   | real L1 tier only (L2 is node-redis)                   |
 * | `GRAPHQL_PUB_SUB`                 | in-process `PubSub`                                    |
 * | `StorageService`                  | `InMemoryStorageService`                               |
 *
 * The Kafka push consumer and the Redis Socket.IO adapter are not connected (no broker / Redis).
 */
export async function createGatewayE2eApp() {
  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const identity = new FakeIdentityState();
  const notifications = new FakeNotificationsPort();
  const storage = new InMemoryStorageService();

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis.asRedis())
    .overrideProvider(AuthPort)
    .useFactory({
      factory: (tokens: TokenService, denylist: AccessTokenDenylist) =>
        new FakeAuthPort(identity, tokens, denylist),
      inject: [TokenService, AccessTokenDenylist],
    })
    .overrideProvider(UsersPort)
    .useValue(new FakeUsersPort(identity))
    .overrideProvider(NotificationsPort)
    .useValue(notifications)
    .overrideProvider(CACHE_MANAGER)
    .useValue(createCache({ stores: [createL1Store({ ttlMs: 5_000, maxItems: 1_000 })] }))
    .overrideProvider(GRAPHQL_PUB_SUB)
    .useValue(new PubSub())
    .overrideProvider(StorageService)
    .useValue(storage);

  const app: NestFastifyApplication = await createFastifyTestApp(
    builder,
    async (created) => {
      await configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false });
      setupApiDocs(created, GATEWAY_API_DOCS);
    },
    {
      adapter: new FastifyAdapter(buildFastifyOptions(config, { multipart: true })),
      appOptions: { bufferLogs: true, rawBody: true },
    },
  );

  return { app, redis, identity, notifications, storage };
}
