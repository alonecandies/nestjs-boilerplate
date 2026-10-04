import { AuthModule } from '@app/auth';
import { BillingApiModule } from '@app/billing';
import {
  CorrelationIdMiddleware,
  MaintenanceModeMiddleware,
  provideCommonEnhancersAsync,
} from '@app/common';
import { type AppConfig, AppConfigModule, appConfig } from '@app/config';
import { FilesModule } from '@app/files';
import { AppGraphqlModule, GraphqlPubSubModule } from '@app/graphql';
import { IdentityApiModule } from '@app/identity';
import { NotificationsApiModule } from '@app/notifications';
import { ObservabilityModule } from '@app/observability';
import { AppCacheModule, AppThrottlerModule, RedisHealthIndicator, RedisModule } from '@app/redis';
import { StorageModule } from '@app/storage';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';

/**
 * The API gateway of the microservices topology. It serves the SAME presentation as the monolith
 * (REST controllers, GraphQL resolvers, the Socket.IO gateway, the push consumer), but every port
 * is bound to a gRPC adapter (`.forRemote()`: deadline, retry-on-UNAVAILABLE, circuit breaker,
 * request/correlation ids in metadata) that calls identity-, notifications- or billing-service.
 * Access tokens are verified here, locally (+ the Redis denylist): no RPC per request for auth.
 *
 * Owns no data: no DatabaseModule, Cassandra, mailer, Stripe, CQRS or Core module. Files are
 * edge-only (object storage, presigned URLs), so FilesModule runs here. Readiness only covers
 * Redis — an upstream outage degrades the affected routes (503 problem+json) instead of pulling
 * every gateway replica out of the load balancer.
 *
 * Import order: config → observability → Redis/cache → AuthModule BEFORE AppThrottlerModule
 * (global guards run in registration order: the throttler must see `req.user` to track per user)
 * → GraphQL → domain edge modules.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ healthContributors: [RedisHealthIndicator] }),
    RedisModule.forRootAsync(),
    AppCacheModule.forRootAsync(),

    // Edge security: JWT + RBAC guards, then the Redis-backed throttler.
    AuthModule.forRootAsync(),
    AppThrottlerModule.forRootAsync(),

    // GraphQL (Apollo on Fastify) + Redis PubSub, so a subscription event published by any
    // replica's push consumer reaches the replica holding the client's socket.
    AppGraphqlModule.forRootAsync(),
    GraphqlPubSubModule,
    StorageModule.forRootAsync(),

    // Bounded contexts, presentation only (ports → gRPC clients).
    IdentityApiModule.forRemote(),
    NotificationsApiModule.forRemote(),
    BillingApiModule.forRemote(),
    FilesModule,
  ],
  providers: [
    // Validation pipes (class-validator + Standard Schema), problem+json filter, handler timeout.
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        maintenanceMode: app.maintenanceMode,
      }),
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, MaintenanceModeMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
