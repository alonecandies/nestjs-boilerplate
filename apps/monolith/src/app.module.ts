import { AuthModule } from '@app/auth';
import { BillingApiModule, billingSchema } from '@app/billing';
import { CassandraHealthIndicator, CassandraModule } from '@app/cassandra';
import {
  CorrelationIdMiddleware,
  MaintenanceModeMiddleware,
  provideCommonEnhancersAsync,
} from '@app/common';
import { type AppConfig, AppConfigModule, appConfig } from '@app/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@app/database';
import { FilesModule } from '@app/files';
import { AppGraphqlModule, GraphqlPubSubModule } from '@app/graphql';
import { IdentityApiModule, identitySchema } from '@app/identity';
import { AppMailerModule } from '@app/mailer';
import {
  NotificationsApiModule,
  NotificationsMessagingModule,
  notificationsCassandraMigrations,
} from '@app/notifications';
import { ObservabilityModule } from '@app/observability';
import { StripeModule } from '@app/payments';
import {
  AppCacheModule,
  AppQueueModule,
  AppThrottlerModule,
  RedisHealthIndicator,
  RedisModule,
} from '@app/redis';
import { StorageModule } from '@app/storage';
import { KafkaProducerModule } from '@app/transport';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';

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
 * config → observability (logger, cls, health) → infrastructure → AuthModule BEFORE
 * AppThrottlerModule (global guards run in registration order: the throttler must see `req.user`
 * to track per user, and `@AuthThrottle` handlers) → GraphQL → domain modules (their `Api`
 * modules import the matching `Core` module — never import a Core module again here).
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // Readiness = the stores a request needs. Kafka is deliberately NOT a contributor: events are
    // best-effort publishes after commit (a failure is logged, never fails the request) and the
    // consumers just resume once the broker is back, so a Kafka outage must not take the whole
    // REST/GraphQL API out of rotation.
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, CassandraHealthIndicator, RedisHealthIndicator],
    }),
    CqrsModule.forRoot(),
    ScheduleModule.forRoot(),

    // Data stores. Migrations: DATABASE_RUN_MIGRATIONS / CASSANDRA_RUN_MIGRATIONS (advisory lock /
    // LWT claim, so concurrent replicas are safe) or `bun run db:migrate` as a release job.
    DatabaseModule.forRootAsync({ schema: DATABASE_SCHEMA }),
    CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] }),
    RedisModule.forRootAsync(),
    AppCacheModule.forRootAsync(),

    // Edge security: JWT + RBAC guards, then the Redis-backed throttler.
    AuthModule.forRootAsync(),
    AppThrottlerModule.forRootAsync(),

    // Async work and external services.
    AppQueueModule.forRootAsync(),
    AppMailerModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    StripeModule.forRootAsync(),
    StorageModule.forRootAsync(),

    // GraphQL (Apollo on Fastify) + Redis PubSub for subscriptions across replicas.
    AppGraphqlModule.forRootAsync(),
    GraphqlPubSubModule,

    // Bounded contexts.
    IdentityApiModule.forLocal(),
    NotificationsApiModule.forLocal(),
    NotificationsMessagingModule,
    BillingApiModule.forLocal(),
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
