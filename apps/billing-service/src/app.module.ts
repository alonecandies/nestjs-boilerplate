import { BillingGrpcModule, billingSchema } from '@domain/billing';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@platform/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@platform/database';
import { ObservabilityModule } from '@platform/observability';
import { RedisHealthIndicator, RedisModule } from '@platform/redis';
import { KafkaProducerModule } from '@platform/transport';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/**
 * billing-service: `billing.v1.BillingService` over gRPC (served by `connectGrpcServer` in
 * main.ts) — Stripe Checkout sessions, signature-verified idempotent webhooks (the gateway forwards
 * the raw bytes + `Stripe-Signature`), the payments ledger in Postgres — producing
 * `billing.payment-succeeded.v1`. The HTTP port only serves `/health/*` (`/metrics` is on `METRICS_PORT`).
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    // Readiness = Postgres + Redis. Kafka is deliberately NOT a contributor:
    // `billing.payment-succeeded.v1` is a best-effort publish after commit (a failure is logged,
    // never fails the call), so a broker outage must not pull every replica out of rotation.
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator],
    }),
    CqrsModule.forRoot(),
    // PurgeStripeEventsCron (hourly, @WithLock so only one replica runs it).
    ScheduleModule.forRoot(),
    // The platform set, then billing's history (DATABASE_MIGRATIONS, shared with migrate.ts), at boot
    // when DATABASE_RUN_MIGRATIONS=true (advisory-locked). Also provides the transactional CLS plugin
    // behind the webhook handler's @Transactional().
    DatabaseModule.forRootAsync({ schema: billingSchema, migrations: DATABASE_MIGRATIONS }),
    RedisModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    // The core (handlers, repositories, its own Stripe adapter) + billing.v1.BillingService.
    BillingGrpcModule,
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
