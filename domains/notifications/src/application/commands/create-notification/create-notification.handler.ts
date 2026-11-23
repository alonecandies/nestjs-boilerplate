import type { Notification } from '@domain/notifications-contracts';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { generateId } from '@platform/common';
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
        tenantId: input.tenantId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        createdAt,
      }),
    );
    // This only stores the row. The callers that create notifications (welcome, receipt)
    // publish the push themselves, after the row and the mail, so a failed publish fails their
    // event and its redelivery publishes again; the push never announces a missing row.
    await this.notifications.insert(notification.toSnapshot());
    notification.commit();
    return toNotificationContract(notification.toSnapshot());
  }
}
