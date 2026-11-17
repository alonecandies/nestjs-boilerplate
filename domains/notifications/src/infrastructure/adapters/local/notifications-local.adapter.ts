import type {
  ListNotificationsRequest,
  MarkNotificationReadRequest,
  NotificationPage,
} from '@domain/notifications-contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { MarkNotificationReadCommand } from '../../../application/commands/mark-notification-read/mark-notification-read.command.js';
import type { NotificationsPort } from '../../../application/ports/notifications.port.js';
import { ListNotificationsQuery } from '../../../application/queries/list-notifications/list-notifications.query.js';
import { InboxTenantMismatchException } from '../../../domain/notification.errors.js';

/**
 * The request's tenant (a proto3 `optional`). A request without one names no inbox: it fails
 * closed with the handlers' 403, and it is never filled from the principal.
 */
function requestTenantId(request: { tenantId?: string | undefined }): string {
  if (request.tenantId === undefined) throw new InboxTenantMismatchException();
  return request.tenantId;
}

/** In-process binding of `NotificationsPort` (monolith): straight onto the CQRS buses. */
@Injectable()
export class NotificationsLocalAdapter implements NotificationsPort {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  // async: a missing tenant rejects the promise like every other port failure, never throws.
  async list(input: ListNotificationsRequest): Promise<NotificationPage> {
    return this.queryBus.execute(
      new ListNotificationsQuery(
        requestTenantId(input),
        input.userId,
        input.limit,
        input.pageState,
      ),
    );
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    await this.commandBus.execute(
      new MarkNotificationReadCommand(requestTenantId(input), input.userId, input.notificationId),
    );
  }
}
