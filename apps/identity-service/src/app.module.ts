import { AuthModule } from '@app/auth';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@app/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@app/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@app/database';
import { IdentityGrpcModule, identitySchema } from '@app/identity';
import { ObservabilityModule } from '@app/observability';
import { RedisHealthIndicator, RedisModule } from '@app/redis';
import { KafkaProducerModule } from '@app/transport';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';

/**
 * identity-service: `identity.v1.AuthService` + `identity.v1.UsersService` over gRPC (served by
 * `connectGrpcServer` in main.ts), backed by Postgres (users, sessions), Redis (access-token
 * denylist, cron lock) and Kafka (produces `identity.user-registered.v1`). The HTTP port only
 * serves `/health/*` and `/metrics`.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    // Readiness = every dependency a gRPC call cannot be served without; liveness never checks
    // dependencies. Kafka is deliberately NOT a contributor: `identity.user-registered.v1` is a
    // best-effort publish after commit (a failure is logged, never fails the call), so a broker
    // outage must not pull every replica out of rotation and take login/register down with it.
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator],
    }),
    CqrsModule.forRoot(),
    // PurgeExpiredSessionsCron (hourly, @WithLock so only one replica runs it).
    ScheduleModule.forRoot(),
    // Migrations run at boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked, so replicas
    // starting together apply them once).
    DatabaseModule.forRootAsync({ schema: identitySchema }),
    RedisModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    // TokenService / PasswordHasher / AccessTokenDenylist for the handlers. No global guards:
    // the service only answers the gateway, which authenticates and authorises every request.
    AuthModule.forRootAsync({ globalGuards: false }),
    IdentityGrpcModule,
  ],
  providers: [
    // With `inheritAppConfig: true` these APP_* enhancers also wrap the gRPC handlers; each of
    // them branches on the context type (the gRPC error mapping is controller-scoped).
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({ exposeInternalErrors: !app.isProduction }),
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
