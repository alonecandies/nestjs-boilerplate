import { KAFKA_TOPICS } from '@app/contracts';
import { KafkaProducer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { toNotificationCreatedPayload } from '../../mappers/notification.mapper.js';
import { PublishNotificationCreatedCommand } from './publish-notification-created.command.js';

@CommandHandler(PublishNotificationCreatedCommand)
export class PublishNotificationCreatedHandler
  implements ICommandHandler<PublishNotificationCreatedCommand>
{
  private readonly logger = new Logger(PublishNotificationCreatedHandler.name);

  constructor(private readonly kafka: KafkaProducer) {}

  async execute({ notification }: PublishNotificationCreatedCommand): Promise<boolean> {
    try {
      await this.kafka.publish(
        KAFKA_TOPICS.NOTIFICATION_CREATED,
        toNotificationCreatedPayload(notification),
        {
          // Per-user ordering: every push of one user lands on the same partition.
          key: notification.userId,
          // The envelope id IS the notification id: a re-publish (Kafka redelivery upstream)
          // carries the same event id, so edge consumers can deduplicate on it.
          eventId: notification.id,
          occurredAt: notification.createdAt,
        },
      );
      return true;
    } catch (error) {
      // Never throw into the CQRS bus (it would only reach UnhandledExceptionBus). The inbox row
      // is already stored; only the real-time push is lost. A transactional outbox would make
      // this at-least-once (documented in the README).
      this.logger.error(
        `Could not publish ${KAFKA_TOPICS.NOTIFICATION_CREATED} for notification ${notification.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }
}
