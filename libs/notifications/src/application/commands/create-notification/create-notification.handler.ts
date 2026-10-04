import { generateId } from '@app/common';
import type { Notification } from '@app/contracts';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { NotificationEntity } from '../../../domain/notification.entity.js';
import { deriveNotificationId } from '../../../domain/notification-id.js';
import { toNotificationContract } from '../../mappers/notification.mapper.js';
import { NotificationsRepository } from '../../ports/notifications.repository.js';
import { CreateNotificationCommand } from './create-notification.command.js';

@CommandHandler(CreateNotificationCommand)
export class CreateNotificationHandler implements ICommandHandler<CreateNotificationCommand> {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute({ input }: CreateNotificationCommand): Promise<Notification> {
    const { idempotency } = input;
    const createdAt = idempotency?.occurredAt ?? new Date();
    const id = idempotency ? deriveNotificationId(idempotency.key, createdAt) : generateId();
    const notification = this.publisher.mergeObjectContext(
      NotificationEntity.create({
        id,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        createdAt,
      }),
    );
    // Persist first, publish second: the push must never announce a row that is not there. A
    // crash in between loses the push, never the notification (an outbox would close that gap).
    await this.notifications.insert(notification.toSnapshot());
    notification.commit();
    return toNotificationContract(notification.toSnapshot());
  }
}
