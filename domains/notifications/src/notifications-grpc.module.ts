import { Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { NOTIFICATIONS_RBAC } from './notifications.permissions.js';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { NotificationsGrpcController } from './presentation/grpc/notifications-grpc.controller.js';

/**
 * `notifications.v1.NotificationsService` over gRPC (notifications-service). The app connects the
 * server with `connectGrpcServer(app, [NOTIFICATIONS_GRPC_PACKAGE])`.
 */
@Module({
  imports: [NotificationsCoreModule, RbacModule.forFeature(NOTIFICATIONS_RBAC)],
  controllers: [NotificationsGrpcController],
})
export class NotificationsGrpcModule {}
