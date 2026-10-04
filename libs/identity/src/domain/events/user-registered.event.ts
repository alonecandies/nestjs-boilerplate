import type { IEvent } from '@nestjs/cqrs';

/**
 * A user account was created. `eventId` (uuidv7) becomes the Kafka envelope id, so a re-publish
 * of the same domain event is deduplicated by consumers.
 */
export class UserRegisteredEvent implements IEvent {
  constructor(
    readonly eventId: string,
    readonly userId: string,
    /** Normalised (trimmed, lowercase). */
    readonly email: string,
    readonly displayName: string,
    readonly occurredAt: Date,
  ) {}
}
