import {
  BILLING_LOG_REDACT_PATHS,
  BillingApiModule,
  BillingCoreModule,
  BillingMessagingModule,
  billingLedgerMigrations,
  billingSchema,
  type LedgerConfig,
  ledgerConfig,
} from '@domain/billing';
import { FilesModule } from '@domain/files';
import { IdentityApiModule, IdentityCoreModule, identitySchema } from '@domain/identity';
import { IDENTITY_MAIL_TEMPLATES_DIR } from '@domain/identity-contracts';
import {
  NOTIFICATIONS_MAIL_TEMPLATES_DIR,
  NotificationsApiModule,
  NotificationsCoreModule,
  NotificationsMessagingModule,
  notificationsCassandraMigrations,
} from '@domain/notifications';
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '@platform/auth';
import { CassandraHealthIndicator, CassandraModule } from '@platform/cassandra';
import {
  CorrelationIdMiddleware,
  MaintenanceModeMiddleware,
  provideCommonEnhancersAsync,
} from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig } from '@platform/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@platform/database';
import { AppGraphqlModule, GraphqlPubSubModule } from '@platform/graphql';
import { ImmudbHealthIndicator, ImmudbModule } from '@platform/immudb';
import { AppMailerModule } from '@platform/mailer';
import { ObservabilityModule } from '@platform/observability';
import {
  AppCacheModule,
  AppQueueModule,
  AppThrottlerModule,
  IpThrottlerModule,
  RedisHealthIndicator,
  RedisModule,
} from '@platform/redis';
import { StorageModule } from '@platform/storage';
import { KafkaProducerModule } from '@platform/transport';
import { DATABASE_MIGRATIONS } from './database.migrations.js';
import { PaymentUserFieldResolver } from './graphql/payment-user.resolver.js';

/** Both Postgres contexts live in the monolith's database (one drizzle instance, one pool). */
const DATABASE_SCHEMA = { ...identitySchema, ...billingSchema };

/**
 * The modular monolith: every bounded context in one process. Presentation (REST, GraphQL,
 * Socket.IO, Kafka consumers) is the same code the gateway serves; here the ports are bound to
 * LOCAL adapters (`.forLocal()` → CommandBus/QueryBus), so a request never leaves the process.
 * Kafka still carries the async integration events (user registered → welcome notification,
 * payment succeeded → receipt, notification created → push), exactly as between microservices.
 *
 * Import order matters where a module reads another's providers while it is being set up:
 * config → observability (logger, cls, health) → infrastructure → IpThrottlerModule BEFORE
 * AuthModule BEFORE AppThrottlerModule (global guards run in registration order: the ip cap must
 * count requests JWT rejects, the per-user throttler must see `req.user`) → GraphQL → domain
 * modules (their `Api` modules no longer import a `Core` module: each is imported here, once,
 * before its Api module).
 *
 * With `LEDGER_ENABLED=true` the monolith also owns the immudb ledger: `ImmudbModule` (billing's
 * ledger migrations at boot when `IMMUDB_RUN_MIGRATIONS=true`, otherwise from `migrate.ts`),
 * `BillingMessagingModule` (the `billing.ledger-posting.v1` consumer, on the hybrid Kafka server of
 * main.ts) and immudb in readiness. With the default `false` none of them loads.
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
      // Readiness = the stores a request needs (+ immudb with the ledger on). Kafka is deliberately
      // NOT a contributor: events wait in the outboxes until the broker is back and the consumers
      // just resume, so a Kafka outage must not take the whole REST/GraphQL API out of rotation.
      ObservabilityModule.forRoot({
        healthContributors: [
          DatabaseHealthIndicator,
          CassandraHealthIndicator,
          RedisHealthIndicator,
          ...(ledger.enabled ? [ImmudbHealthIndicator] : []),
        ],
        redactPaths: BILLING_LOG_REDACT_PATHS,
      }),
      CqrsModule.forRoot(),
      ScheduleModule.forRoot(),

      // Data stores. Migrations: DATABASE_RUN_MIGRATIONS / CASSANDRA_RUN_MIGRATIONS (advisory lock /
      // LWT claim, so concurrent replicas are safe) or, for Postgres, this app's `db:migrate` script
      // (`dist/migrate.js`, the same DATABASE_MIGRATIONS) as a release job.
      DatabaseModule.forRootAsync({ schema: DATABASE_SCHEMA, migrations: DATABASE_MIGRATIONS }),
      CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] }),
      RedisModule.forRootAsync(),
      AppCacheModule.forRootAsync(),

      // Edge security: the pre-auth per-IP cap (counts 401/403 floods), JWT + RBAC guards, then the
      // per-user / per-route / credential throttler.
      IpThrottlerModule,
      AuthModule.forRootAsync(),
      AppThrottlerModule.forRootAsync(),

      // Async work and external services.
      AppQueueModule.forRootAsync(),
      AppMailerModule.forRootAsync({
        templateDirs: [NOTIFICATIONS_MAIL_TEMPLATES_DIR, IDENTITY_MAIL_TEMPLATES_DIR],
      }),
      KafkaProducerModule.forRootAsync(),
      StorageModule.forRootAsync(),

      // GraphQL (Apollo on Fastify) + Redis PubSub for subscriptions across replicas.
      AppGraphqlModule.forRootAsync(),
      GraphqlPubSubModule,

      // Bounded contexts: every Core module, then the edge bound to the local adapters
      // (XApiModule.forLocal() does not import the core; @domain/<x>/api never reaches it).
      IdentityCoreModule,
      IdentityApiModule.forLocal(),
      NotificationsCoreModule,
      NotificationsApiModule.forLocal(),
      NotificationsMessagingModule,
      BillingCoreModule,
      BillingApiModule.forLocal(),
      FilesModule,
      // LEDGER_ENABLED=true only: immudb (global ImmudbClient) + the ledger-posting consumer.
      ...ledgerImports,
    ],
    providers: [
      // `Payment.user` (billing → identity): the one cross-domain GraphQL field is composed here.
      PaymentUserFieldResolver,
      // Validation pipes (class-validator + Standard Schema), problem+json filter, handler timeout.
      ...provideCommonEnhancersAsync({
        inject: [appConfig.KEY],
        useFactory: (app: AppConfig) => ({
          exposeInternalErrors: !app.isProduction,
          maintenanceMode: app.maintenanceMode,
          defaultTimeoutMs: app.handlerTimeoutMs,
        }),
      }),
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply(CorrelationIdMiddleware, MaintenanceModeMiddleware)
        .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
    }
  }
  return AppModule;
}

/** The root module main.ts boots, as the process env's `LEDGER_ENABLED` says. */
export const AppModule = createAppModule();
