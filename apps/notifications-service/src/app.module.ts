import { CassandraHealthIndicator, CassandraModule } from '@app/cassandra';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@app/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@app/config';
import { AppMailerModule } from '@app/mailer';
import {
  NotificationsGrpcModule,
  NotificationsMessagingModule,
  notificationsCassandraMigrations,
} from '@app/notifications';
import { ObservabilityModule } from '@app/observability';
import { AppQueueModule, RedisHealthIndicator, RedisModule } from '@app/redis';
import { KafkaHealthIndicator, KafkaProducerModule } from '@app/transport';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';

/**
 * notifications-service: owns the Cassandra inbox.
 * - gRPC `notifications.v1.NotificationsService` (list / mark read) for the gateway;
 * - Kafka consumers: `identity.user-registered.v1` → welcome, `billing.payment-succeeded.v1` →
 *   receipt (group pinned in main.ts), producing `notifications.notification-created.v1`;
 * - BullMQ `mail` worker (SMTP) and the daily digest cron (`@WithLock`, one replica).
 * The HTTP port only serves `/health/*` and `/metrics`.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    ObservabilityModule.forRoot({
      healthContributors: [CassandraHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
    }),
    CqrsModule.forRoot(),
    // DailyDigestCron (09:00 UTC).
    ScheduleModule.forRoot(),
    // Creates the keyspace and applies the CQL migrations at boot (LWT-claimed, so concurrent
    // replicas apply each file once) unless CASSANDRA_RUN_MIGRATIONS=false.
    CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] }),
    // The digest's distributed lock.
    RedisModule.forRootAsync(),
    // BullMQ connection for the `mail` queue; AppMailerModule registers the queue, MailService
    // and the MailProcessor worker (this service delivers mail).
    AppQueueModule.forRootAsync(),
    AppMailerModule.forRootAsync({ worker: true }),
    KafkaProducerModule.forRootAsync(),
    NotificationsGrpcModule,
    NotificationsMessagingModule,
  ],
  providers: [
    // With `inheritAppConfig: true` these APP_* enhancers also wrap gRPC and Kafka handlers; each
    // branches on the context type (gRPC error mapping and the Kafka dead-letter filter are
    // controller-scoped and take precedence).
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
