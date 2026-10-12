import { join } from 'node:path';
// Value import on purpose: registers the Timestamp <-> Date wrapper (see identity.grpc-package.ts).
import { NOTIFICATIONS_SERVICE_NAME } from '../generated/notifications/v1/notifications.pb.js';
import type { GrpcPackageSpec } from './grpc-package-spec.js';

/** `notifications.v1`: NotificationsService (inbox listing, mark as read). */
export const NOTIFICATIONS_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'notifications.v1',
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['notifications/v1/notifications.proto'],
  services: [NOTIFICATIONS_SERVICE_NAME],
  clientToken: 'NOTIFICATIONS_GRPC_CLIENT',
  idempotentMethods: { [NOTIFICATIONS_SERVICE_NAME]: ['ListNotifications'] },
};
