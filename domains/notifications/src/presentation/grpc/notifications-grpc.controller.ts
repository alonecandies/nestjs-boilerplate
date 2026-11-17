import {
  type ListNotificationsRequest,
  type MarkNotificationReadRequest,
  type NotificationPage,
  type NotificationsServiceController,
  NotificationsServiceControllerMethods,
} from '@domain/notifications-contracts';
import type { Metadata } from '@grpc/grpc-js';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Ctx, Payload } from '@nestjs/microservices';
import { GrpcController, ZodRpcValidationPipe } from '@platform/transport';
import type { z } from 'zod';
import { MarkNotificationReadCommand } from '../../application/commands/mark-notification-read/mark-notification-read.command.js';
import { ListNotificationsQuery } from '../../application/queries/list-notifications/list-notifications.query.js';
import {
  listNotificationsRequestSchema,
  markNotificationReadRequestSchema,
} from './notifications-grpc.schemas.js';

/**
 * `notifications.v1.NotificationsService` — the service side of `NotificationsGrpcAdapter`.
 * `@GrpcController()` scopes the DomainException → gRPC status filter and the metadata → CLS
 * interceptor to this controller. RBAC is enforced at the edge. The request's `tenant_id` and
 * `user_id` must be the caller principal's (from metadata): the handlers check it
 * (`requireInboxActor`, PERMISSION_DENIED TENANT_MISMATCH otherwise).
 */
@GrpcController()
@NotificationsServiceControllerMethods()
export class NotificationsGrpcController implements NotificationsServiceController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  // With a param decorator present Nest no longer injects (request, metadata, call) by default,
  // hence the explicit (optional) @Ctx() to keep the generated 2-arg interface.
  listNotifications(
    @Payload(new ZodRpcValidationPipe(listNotificationsRequestSchema))
    request: ListNotificationsRequest & z.output<typeof listNotificationsRequestSchema>,
    @Ctx() _metadata?: Metadata,
  ): Promise<NotificationPage> {
    return this.queryBus.execute(
      new ListNotificationsQuery(
        request.tenantId,
        request.userId,
        request.limit,
        request.pageState,
      ),
    );
  }

  async markNotificationRead(
    @Payload(new ZodRpcValidationPipe(markNotificationReadRequestSchema))
    request: MarkNotificationReadRequest & z.output<typeof markNotificationReadRequestSchema>,
    @Ctx() _metadata?: Metadata,
  ): Promise<void> {
    await this.commandBus.execute(
      new MarkNotificationReadCommand(request.tenantId, request.userId, request.notificationId),
    );
  }
}
