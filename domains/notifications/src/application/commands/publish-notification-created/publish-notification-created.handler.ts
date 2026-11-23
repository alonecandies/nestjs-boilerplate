import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { KafkaProducer } from '@platform/transport';
import { toNotificationCreatedPayload } from '../../mappers/notification.mapper.js';
import { PublishNotificationCreatedCommand } from './publish-notification-created.command.js';

@CommandHandler(PublishNotificationCreatedCommand)
export class PublishNotificationCreatedHandler
  implements ICommandHandler<PublishNotificationCreatedCommand>
{
  constructor(private readonly kafka: KafkaProducer) {}

  /**
   * Throws on a broker failure, on purpose: the caller (a Kafka consumer's command) fails, so the
   * upstream event is retried in process and then dead-lettered, and the push is not lost.
   */
  async execute({ notification }: PublishNotificationCreatedCommand): Promise<void> {
    await this.kafka.publish(
      NOTIFICATION_CREATED_EVENT,
      toNotificationCreatedPayload(notification),
      {
        // Per-user ordering: every push of one user lands on the same partition.
        key: notification.userId,
        // The inbox tenant, explicitly: the CLS principal of the consumer that created the
        // notification is not necessarily it (the event is tenant-scoped).
        tenantId: notification.tenantId,
        // The envelope id IS the notification id: a re-publish (Kafka redelivery upstream)
        // carries the same event id, so edge consumers can deduplicate on it.
        eventId: notification.id,
        occurredAt: notification.createdAt,
      },
    );
  }
}
