/**
 * @domain/notifications-contracts — the published language of the notifications context: the
 * notifications.v1 gRPC contract (ts-proto NestJS output + `NOTIFICATIONS_GRPC_PACKAGE`) and the
 * notification-created event (`NOTIFICATION_CREATED_EVENT`). Other domains and the apps depend on
 * this package to talk to notifications; only the composition roots import
 * @domain/notifications itself.
 *
 * - Generated types are re-exported flat (`Notification`, `NotificationPage`, …) and as the
 *   version-qualified namespace `notificationsV1`, the escape hatch for a later `v2`.
 * - Loading this barrel evaluates the generated module, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/notifications.grpc-package.ts).
 */
export * from './events/notifications.events.js';
export type { Empty } from './generated/google/protobuf/empty.pb.js';
export * from './generated/notifications/v1/notifications.pb.js';
export * as notificationsV1 from './generated/notifications/v1/notifications.pb.js';
export * from './grpc/notifications.grpc-package.js';
