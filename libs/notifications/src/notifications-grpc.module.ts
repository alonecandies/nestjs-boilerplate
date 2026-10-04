import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { NotificationsGrpcController } from './presentation/grpc/notifications-grpc.controller.js';

/**
 * `notifications.v1.NotificationsService` over gRPC (notifications-service). The app connects the
 * server with `connectGrpcServer(app, ['notifications'])`.
 */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsGrpcController],
})
export class NotificationsGrpcModule {}
