import { IdentityGrpcModule, identitySchema } from '@domain/identity';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '@platform/auth';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@platform/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@platform/database';
import { AppMailerModule } from '@platform/mailer';
import { ObservabilityModule } from '@platform/observability';
import { AppQueueModule, RedisHealthIndicator, RedisModule } from '@platform/redis';
import { KafkaProducerModule } from '@platform/transport';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/**
 * identity-service: `identity.v1.AuthService` + `identity.v1.UsersService` over gRPC (served by
 * `connectGrpcServer` in main.ts), backed by Postgres (users, sessions), Redis (access-token
 * denylist, cron lock) and Kafka (produces `identity.user-registered.v1`). The HTTP port only
 * serves `/health/*` (`/metrics` is on `METRICS_PORT`).
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    // Readiness = every dependency a gRPC call cannot be served without; liveness never checks
    // dependencies. Kafka is deliberately NOT a contributor: `identity.user-registered.v1` leaves
    // through `identity.outbox` (the row commits with the user) and the relay publishes it once
    // the broker is back, so a broker outage must not pull every replica out of rotation and take
    // login/register down with it.
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator],
    }),
    CqrsModule.forRoot(),
    // PurgeExpiredSessionsCron (hourly, @WithLock so only one replica runs it).
    ScheduleModule.forRoot(),
    // The platform set, then identity's history (DATABASE_MIGRATIONS, shared with migrate.ts), at
    // boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked: replicas starting together apply them once).
    DatabaseModule.forRootAsync({ schema: identitySchema, migrations: DATABASE_MIGRATIONS }),
    RedisModule.forRootAsync(),
    // BullMQ connection and the `mail` queue: CreateInvitationHandler enqueues invitation mail.
    AppQueueModule.forRootAsync(),
    // Enqueue-only: notifications-service (and the monolith) deliver identity mail.
    AppMailerModule.forRootAsync({ templateDirs: [], worker: false }),
    KafkaProducerModule.forRootAsync(),
    // AccessTokenDenylist for LogoutHandler (PasswordHasher and TokenIssuer come with
    // IdentityCoreModule). No global guards: the service only answers the gateway, which
    // authenticates and authorises every request.
    AuthModule.forRootAsync({ globalGuards: false }),
    IdentityGrpcModule,
  ],
  providers: [
    // With `inheritAppConfig: true` these APP_* enhancers also wrap the gRPC handlers; each of
    // them branches on the context type (the gRPC error mapping is controller-scoped).
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        defaultTimeoutMs: app.handlerTimeoutMs,
      }),
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
