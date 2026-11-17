import { MEMBERSHIP_CREATED_EVENT, MEMBERSHIP_REMOVED_EVENT } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import { KafkaProducer } from '@platform/transport';
import { MembershipCreatedEvent } from '../../domain/events/membership-created.event.js';
import { MembershipRemovedEvent } from '../../domain/events/membership-removed.event.js';

type MembershipEvent = MembershipCreatedEvent | MembershipRemovedEvent;

/**
 * Domain event → integration event: publishes `identity.membership-created.v1` and
 * `identity.membership-removed.v1` so notifications keeps its recipients per `(tenant, user)`.
 * Envelope tenant = the membership's tenant and actor = the event's actor, both passed explicitly
 * (the CLS principal may be the caller's other tenant); key = user id; envelope id = domain event id.
 *
 * Same contract as `UserRegisteredRelay`: the handler publishes after its unit of work committed,
 * and a failure here is logged, never thrown (the publish-after-commit window closes with G-1's
 * outbox).
 */
@EventsHandler(MembershipCreatedEvent, MembershipRemovedEvent)
export class MembershipEventsRelay implements IEventHandler<MembershipEvent> {
  private readonly logger = new Logger(MembershipEventsRelay.name);

  constructor(private readonly kafka: KafkaProducer) {}

  async handle(event: MembershipEvent): Promise<void> {
    const options = {
      key: event.userId,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      tenantId: event.tenantId,
      actorId: event.actorId,
    };
    const topic =
      event instanceof MembershipCreatedEvent
        ? MEMBERSHIP_CREATED_EVENT.topic
        : MEMBERSHIP_REMOVED_EVENT.topic;
    try {
      if (event instanceof MembershipCreatedEvent) {
        await this.kafka.publish(
          MEMBERSHIP_CREATED_EVENT,
          {
            userId: event.userId,
            email: event.email,
            displayName: event.displayName,
            createdAt: event.occurredAt.toISOString(),
          },
          options,
        );
      } else {
        await this.kafka.publish(
          MEMBERSHIP_REMOVED_EVENT,
          { userId: event.userId, removedAt: event.occurredAt.toISOString() },
          options,
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, tenantId: event.tenantId, userId: event.userId, eventId: event.eventId },
        `Failed to publish ${topic}`,
      );
    }
  }
}
