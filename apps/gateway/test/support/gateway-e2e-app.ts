import { BillingPort } from '@domain/billing';
import { AuthPort, refreshTokenConfig, UsersPort } from '@domain/identity';
import { InvitationsPort, MembersPort, TenantsPort } from '@domain/identity/api';
import {
  FakeAuthPort,
  FakeIdentityState,
  FakeInvitationsPort,
  FakeMembersPort,
  FakeTenancyState,
  FakeTenantsPort,
  FakeUsersPort,
  TokenIssuer,
} from '@domain/identity/testing';
import { NotificationsPort } from '@domain/notifications';
import { FakeNotificationsPort } from '@domain/notifications/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AccessTokenDenylist } from '@platform/auth';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@platform/bootstrap';
import { MAINTENANCE_MODE, type MaintenanceModeSwitch } from '@platform/common';
import { appConfig, authConfig } from '@platform/config';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import { createL1Store, REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { StorageService } from '@platform/storage';
import { InMemoryStorageService } from '@platform/storage/testing';
import { createFastifyTestApp } from '@platform/testing';
import { createCache } from 'cache-manager';
import { PubSub } from 'graphql-subscriptions';
import { GATEWAY_API_DOCS } from '../../src/app.constants.js';
import { AppModule } from '../../src/app.module.js';

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
 * | `TenantsPort`, `MembersPort`, `InvitationsPort` | fake identity-service (`FakeTenancyState`) |
 * | `NotificationsPort`               | fake notifications-service inbox                       |
 * | `BillingPort`                     | the real gRPC adapter → a dead upstream; or `options.billing` |
 * | `CACHE_MANAGER`                   | real L1 tier only (L2 is node-redis)                   |
 * | `GRAPHQL_PUB_SUB`                 | in-process `PubSub`                                    |
 * | `StorageService`                  | `InMemoryStorageService`                               |
 *
 * The Kafka push consumer and the Redis Socket.IO adapter are not connected (no broker / Redis).
 */
export interface GatewayE2eOptions {
  /** Binds `BillingPort` to this stand-in for billing-service (default: the real gRPC adapter). */
  billing?: BillingPort;
  /**
   * Replaces the `MAINTENANCE_MODE` switch (the root module's boot boolean, `app.maintenanceMode`),
   * for example with a function the spec flips while the app runs.
   */
  maintenanceMode?: MaintenanceModeSwitch;
}

export async function createGatewayE2eApp(options: GatewayE2eOptions = {}) {
  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const identity = new FakeIdentityState();
  const tenancy = new FakeTenancyState(identity);
  const notifications = new FakeNotificationsPort();
  const storage = new InMemoryStorageService();
  // identity-service's signer, built from the env the gateway's AuthModule verifies with.
  const issuer = new TokenIssuer(new JwtService(), authConfig.parse(), refreshTokenConfig.parse());

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis.asRedis())
    .overrideProvider(AuthPort)
    .useFactory({
      factory: (denylist: AccessTokenDenylist) => new FakeAuthPort(identity, issuer, denylist),
      inject: [AccessTokenDenylist],
    })
    .overrideProvider(UsersPort)
    .useValue(new FakeUsersPort(identity))
    .overrideProvider(TenantsPort)
    .useValue(new FakeTenantsPort(tenancy))
    .overrideProvider(MembersPort)
    .useValue(new FakeMembersPort(tenancy))
    .overrideProvider(InvitationsPort)
    .useValue(new FakeInvitationsPort(tenancy))
    .overrideProvider(NotificationsPort)
    .useValue(notifications)
    .overrideProvider(CACHE_MANAGER)
    .useValue(createCache({ stores: [createL1Store({ ttlMs: 5_000, maxItems: 1_000 })] }))
    .overrideProvider(GRAPHQL_PUB_SUB)
    .useValue(new PubSub())
    .overrideProvider(StorageService)
    .useValue(storage);
  if (options.billing !== undefined) {
    builder.overrideProvider(BillingPort).useValue(options.billing);
  }
  if (options.maintenanceMode !== undefined) {
    builder.overrideProvider(MAINTENANCE_MODE).useValue(options.maintenanceMode);
  }

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

  return { app, redis, identity, tenancy, notifications, storage };
}
