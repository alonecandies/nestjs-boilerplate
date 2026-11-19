import {
  BillingGrpcModule,
  BillingMessagingModule,
  billingLedgerMigrations,
  billingSchema,
  type LedgerConfig,
  ledgerConfig,
} from '@domain/billing';
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { RbacModule } from '@platform/auth';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@platform/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@platform/database';
import { ImmudbHealthIndicator, ImmudbModule } from '@platform/immudb';
import { ObservabilityModule } from '@platform/observability';
import { RedisHealthIndicator, RedisModule } from '@platform/redis';
import { KafkaProducerModule } from '@platform/transport';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/**
 * billing-service: `billing.v1.BillingService` over gRPC (served by `connectGrpcServer` in
 * main.ts) — Stripe Checkout sessions, signature-verified idempotent webhooks (the gateway forwards
 * the raw bytes + `Stripe-Signature`), the payments ledger in Postgres — producing
 * `billing.payment-succeeded.v1`. The HTTP port only serves `/health/*` (`/metrics` is on `METRICS_PORT`).
 *
 * With `LEDGER_ENABLED=true` it also owns the immudb ledger: `ImmudbModule` (billing's ledger
 * migrations at boot when `IMMUDB_RUN_MIGRATIONS=true`, otherwise from `migrate.ts`),
 * `BillingMessagingModule` (the `billing.ledger-posting.v1` consumer, connected by main.ts) and
 * immudb in readiness. With the default `false` none of them loads and no immudb client exists.
 *
 * `LEDGER_ENABLED` is read when the module is defined (like `ObservabilityModule.forRoot()`), so
 * main.ts's `AppModule` follows the process env; the e2e spec defines a second one after stubbing it.
 */
export function createAppModule(
  ledger: Pick<LedgerConfig, 'enabled'> = ledgerConfig.parse(),
): Type<NestModule> {
  const ledgerImports = ledger.enabled
    ? [ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }), BillingMessagingModule]
    : [];

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
      // validated at boot like every other namespace, and resolvable from the app container.
      ConfigModule.forFeature(grpcConfig),
      // Readiness = Postgres + Redis (+ immudb with the ledger on: postings cannot land without it).
      // Kafka is deliberately NOT a contributor: events wait in billing.outbox and the relay publishes
      // them once the broker is back, so a broker outage must not pull every replica out of rotation.
      ObservabilityModule.forRoot({
        healthContributors: [
          DatabaseHealthIndicator,
          RedisHealthIndicator,
          ...(ledger.enabled ? [ImmudbHealthIndicator] : []),
        ],
      }),
      CqrsModule.forRoot(),
      // The RBAC registry: services recompute permissions from the roles in gRPC metadata (B2-23).
      RbacModule.forRoot(),
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
      // LEDGER_ENABLED=true only: immudb (global ImmudbClient) + the ledger-posting consumer.
      ...ledgerImports,
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
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply(CorrelationIdMiddleware)
        .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
    }
  }
  return AppModule;
}

/** The root module main.ts boots, as the process env's `LEDGER_ENABLED` says. */
export const AppModule = createAppModule();
