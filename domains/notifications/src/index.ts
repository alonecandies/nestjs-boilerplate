/**
 * @domain/notifications — the notifications bounded context.
 * - `@domain/notifications/api` (re-exported here): `NotificationsApiModule.forLocal()` /
 *   `.forRemote()`, `NotificationsPort`, adapters, REST / GraphQL / WebSocket / push presentation.
 * - This root entry adds `NotificationsCoreModule` (CQRS, Cassandra, digest cron),
 *   `NotificationsGrpcModule`, `NotificationsMessagingModule` (identity/billing Kafka consumers),
 *   `notificationsCassandraMigrations`, commands/queries, mail and domain types.
 * - The monolith imports `NotificationsCoreModule` next to `NotificationsApiModule.forLocal()`.
 */

// The edge surface (also `@domain/notifications/api`).
export * from './api/index.js';
export * from './application/commands/create-notification/create-notification.command.js';
export * from './application/commands/mark-notification-read/mark-notification-read.command.js';
export * from './application/commands/publish-notification-created/publish-notification-created.command.js';
export * from './application/commands/remove-recipient/remove-recipient.command.js';
export * from './application/commands/send-daily-digest/send-daily-digest.command.js';
export * from './application/commands/send-payment-receipt/send-payment-receipt.command.js';
export * from './application/commands/upsert-recipient/upsert-recipient.command.js';
export * from './application/commands/welcome-user/welcome-user.command.js';
export * from './application/inbox-actor.js';
export * from './application/mail/notifications-mail.js';
export * from './application/mappers/notification.mapper.js';
export * from './application/ports/notification-recipients.repository.js';
export * from './application/ports/notifications.repository.js';
export * from './application/queries/list-notifications/list-notifications.query.js';
export * from './domain/events/notification-created.event.js';
export * from './domain/notification.entity.js';
export * from './domain/notification.errors.js';
export * from './domain/notification.types.js';
export * from './domain/notification-id.js';
export * from './infrastructure/mail/notifications-mail-templates.js';
export * from './infrastructure/persistence/notifications-cassandra.migrations.js';
export {
  DAILY_DIGEST_CRON,
  DAILY_DIGEST_JOB_NAME,
  DAILY_DIGEST_LOCK,
  DAILY_DIGEST_LOCK_TTL_MS,
  DIGEST_CONCURRENCY,
  DIGEST_ITEMS_PER_MAIL,
  DIGEST_MAX_RECIPIENTS,
  DIGEST_RECIPIENTS_PAGE_SIZE,
  DIGEST_SCAN_PER_USER,
} from './notifications.constants.js';
export * from './notifications-core.module.js';
export * from './notifications-grpc.module.js';
export * from './notifications-messaging.module.js';
export * from './presentation/messaging/event-tenant.js';
