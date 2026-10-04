import { KAFKA_TOPICS } from '@app/contracts';
import { KafkaProducer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import { UserRegisteredEvent } from '../../domain/events/user-registered.event.js';

/**
 * Domain event → integration event: publishes `identity.user-registered.v1` (keyed by user id,
 * envelope id = domain event id) for the notifications context (welcome notification + email).
 *
 * Failures are logged, never thrown: the registration already committed and the client got its
 * tokens; an exception here would only surface on the CQRS UnhandledExceptionBus. The window
 * "committed but not published" (broker down, crash) is the known limit of publish-after-commit —
 * a transactional outbox (event row in the same transaction + relay) closes it; see README.
 */
@EventsHandler(UserRegisteredEvent)
export class UserRegisteredRelay implements IEventHandler<UserRegisteredEvent> {
  private readonly logger = new Logger(UserRegisteredRelay.name);

  constructor(private readonly kafka: KafkaProducer) {}

  async handle(event: UserRegisteredEvent): Promise<void> {
    try {
      await this.kafka.publish(
        KAFKA_TOPICS.USER_REGISTERED,
        {
          userId: event.userId,
          email: event.email,
          displayName: event.displayName,
          registeredAt: event.occurredAt.toISOString(),
        },
        { key: event.userId, eventId: event.eventId, occurredAt: event.occurredAt },
      );
    } catch (error) {
      this.logger.error(
        { err: error, userId: event.userId, eventId: event.eventId },
        `Failed to publish ${KAFKA_TOPICS.USER_REGISTERED}`,
      );
    }
  }
}
