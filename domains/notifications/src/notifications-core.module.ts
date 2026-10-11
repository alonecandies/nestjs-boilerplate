import { Module, type Provider } from '@nestjs/common';
import { CreateNotificationHandler } from './application/commands/create-notification/create-notification.handler.js';
import { MarkNotificationReadHandler } from './application/commands/mark-notification-read/mark-notification-read.handler.js';
import { PublishNotificationCreatedHandler } from './application/commands/publish-notification-created/publish-notification-created.handler.js';
import { SendDailyDigestHandler } from './application/commands/send-daily-digest/send-daily-digest.handler.js';
import { SendPaymentReceiptHandler } from './application/commands/send-payment-receipt/send-payment-receipt.handler.js';
import { WelcomeUserHandler } from './application/commands/welcome-user/welcome-user.handler.js';
import { NotificationRecipientsRepository } from './application/ports/notification-recipients.repository.js';
import { NotificationsRepository } from './application/ports/notifications.repository.js';
import { ListNotificationsHandler } from './application/queries/list-notifications/list-notifications.handler.js';
import { NotificationsSagas } from './application/sagas/notifications.sagas.js';
import { CassandraNotificationRecipientsRepository } from './infrastructure/persistence/cassandra-notification-recipients.repository.js';
import { CassandraNotificationsRepository } from './infrastructure/persistence/cassandra-notifications.repository.js';
import { DailyDigestCron } from './infrastructure/scheduling/daily-digest.cron.js';

export const NOTIFICATIONS_COMMAND_HANDLERS: Provider[] = [
  CreateNotificationHandler,
  MarkNotificationReadHandler,
  PublishNotificationCreatedHandler,
  SendDailyDigestHandler,
  SendPaymentReceiptHandler,
  WelcomeUserHandler,
];

export const NOTIFICATIONS_QUERY_HANDLERS: Provider[] = [ListNotificationsHandler];

/**
 * The notifications core: CQRS handlers, saga, Cassandra repositories and the daily digest cron.
 * Imported by processes that OWN the data (monolith, notifications-service); the gateway never
 * imports it.
 *
 * Expects these app-level (global) modules: `CqrsModule.forRoot()`, `CassandraModule.forRootAsync(
 * { migrations: [notificationsCassandraMigrations] })`, `KafkaProducerModule.forRootAsync()`,
 * `AppQueueModule.forRootAsync()` + `AppMailerModule.forRootAsync()` (MailService),
 * `RedisModule.forRootAsync()` (the digest's distributed lock) and `ScheduleModule.forRoot()`.
 */
@Module({
  providers: [
    ...NOTIFICATIONS_COMMAND_HANDLERS,
    ...NOTIFICATIONS_QUERY_HANDLERS,
    NotificationsSagas,
    DailyDigestCron,
    { provide: NotificationsRepository, useClass: CassandraNotificationsRepository },
    {
      provide: NotificationRecipientsRepository,
      useClass: CassandraNotificationRecipientsRepository,
    },
  ],
  exports: [NotificationsRepository, NotificationRecipientsRepository],
})
export class NotificationsCoreModule {}
