import type {
  ListNotificationsRequest,
  MarkNotificationReadRequest,
  NotificationPage,
} from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { MarkNotificationReadCommand } from '../../../application/commands/mark-notification-read/mark-notification-read.command.js';
import type { NotificationsPort } from '../../../application/ports/notifications.port.js';
import { ListNotificationsQuery } from '../../../application/queries/list-notifications/list-notifications.query.js';

/** In-process binding of `NotificationsPort` (monolith): straight onto the CQRS buses. */
@Injectable()
export class NotificationsLocalAdapter implements NotificationsPort {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  list(input: ListNotificationsRequest): Promise<NotificationPage> {
    return this.queryBus.execute(
      new ListNotificationsQuery(input.userId, input.limit, input.pageState),
    );
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    await this.commandBus.execute(
      new MarkNotificationReadCommand(input.userId, input.notificationId),
    );
  }
}
