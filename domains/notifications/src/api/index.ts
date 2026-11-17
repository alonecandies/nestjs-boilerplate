/**
 * @domain/notifications/api — the notifications edge: `NotificationsApiModule` (`forRemote()` for
 * the gateway; `forLocal()` for the monolith, which also imports `NotificationsCoreModule`),
 * `NotificationsPort` and its adapters, REST / GraphQL / WebSocket / push presentation and their
 * constants. No core, Cassandra or mail code is reachable from here.
 */
export { NotificationsPort } from '../application/ports/notifications.port.js';
export { NotificationsGrpcAdapter } from '../infrastructure/adapters/grpc/notifications-grpc.adapter.js';
export {
  type NotificationsGrpcClientConfig,
  notificationsGrpcClientConfig,
  notificationsGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/notifications-grpc-client.config.js';
export { NotificationsLocalAdapter } from '../infrastructure/adapters/local/notifications-local.adapter.js';
export {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
  NOTIFICATION_CREATED_TRIGGER,
  NOTIFICATIONS_WS_EVENTS,
  NOTIFICATIONS_WS_NAMESPACE,
  notificationCreatedTrigger,
  PAGE_STATE_MAX_LENGTH,
  PAGE_STATE_PATTERN,
  tenantUserRoom,
} from '../notifications.constants.js';
export { NOTIFICATIONS_RBAC, NotificationsPermission } from '../notifications.permissions.js';
export { NotificationsApiModule } from '../notifications-api.module.js';
export {
  NotificationConnectionModel,
  NotificationModel,
  NotificationTypeEnum,
} from '../presentation/graphql/notification.model.js';
export {
  isOwnNotification,
  NotificationsResolver,
  toCreatedNotificationModel,
  toNotificationConnection,
} from '../presentation/graphql/notifications.resolver.js';
export { NotificationsController } from '../presentation/http/notifications.controller.js';
export {
  type ListNotificationsQueryParams,
  listNotificationsQuerySchema,
  type NotificationPageResponse,
  type NotificationResponse,
  notificationIdParamSchema,
  notificationPageResponseSchema,
  notificationResponseSchema,
  toNotificationPageResponse,
  toNotificationResponse,
} from '../presentation/http/notifications.dto.js';
export {
  NotificationPushConsumer,
  PUSH_DEDUPE_TTL_SEC,
} from '../presentation/messaging/notification-push.consumer.js';
export {
  NotificationsGateway,
  type NotificationsNamespace,
  type NotificationsSocket,
  type NotificationsSocketData,
} from '../presentation/ws/notifications.gateway.js';
export {
  type NotificationsRateLimitConfig,
  notificationsRateLimitConfig,
} from '../presentation/ws/notifications-rate-limit.config.js';
