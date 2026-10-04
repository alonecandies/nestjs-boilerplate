/**
 * @app/notifications — the notifications bounded context (public API).
 * - Modules: `NotificationsCoreModule` (CQRS, saga, Cassandra, digest cron),
 *   `NotificationsGrpcModule`, `NotificationsMessagingModule` (identity/billing Kafka consumers)
 *   and `NotificationsApiModule.forLocal()` / `.forRemote()` (REST, GraphQL, WebSocket, push).
 * - `notificationsCassandraMigrations` for `CassandraModule.forRootAsync({ migrations })`.
 * - `NotificationsPort`, commands/queries, domain types, adapters, and the presentation schemas
 *   and models (docs, clients, composition, tests).
 */
export * from './application/commands/create-notification/create-notification.command.js';
export * from './application/commands/mark-notification-read/mark-notification-read.command.js';
export * from './application/commands/publish-notification-created/publish-notification-created.command.js';
export * from './application/commands/send-daily-digest/send-daily-digest.command.js';
export * from './application/commands/send-payment-receipt/send-payment-receipt.command.js';
export * from './application/commands/welcome-user/welcome-user.command.js';
export * from './application/mappers/notification.mapper.js';
export * from './application/ports/notification-recipients.repository.js';
export * from './application/ports/notifications.port.js';
export * from './application/ports/notifications.repository.js';
export * from './application/queries/list-notifications/list-notifications.query.js';
export * from './domain/events/notification-created.event.js';
export * from './domain/notification.entity.js';
export * from './domain/notification.errors.js';
export * from './domain/notification.types.js';
export * from './domain/notification-id.js';
export * from './infrastructure/adapters/grpc/notifications-grpc.adapter.js';
export * from './infrastructure/adapters/local/notifications-local.adapter.js';
export * from './infrastructure/persistence/notifications-cassandra.migrations.js';
export * from './notifications.constants.js';
export * from './notifications-api.module.js';
export * from './notifications-core.module.js';
export * from './notifications-grpc.module.js';
export * from './notifications-messaging.module.js';
export * from './presentation/graphql/notification.model.js';
export * from './presentation/graphql/notifications.resolver.js';
export * from './presentation/http/notifications.controller.js';
export * from './presentation/http/notifications.dto.js';
export * from './presentation/messaging/notification-push.consumer.js';
export * from './presentation/ws/notifications.gateway.js';
