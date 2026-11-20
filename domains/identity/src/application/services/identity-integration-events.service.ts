import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import type { MembershipCreatedEvent } from '../../domain/events/membership-created.event.js';
import type { MembershipRemovedEvent } from '../../domain/events/membership-removed.event.js';
import type { UserRegisteredEvent } from '../../domain/events/user-registered.event.js';
import { IdentityOutbox } from '../../infrastructure/persistence/identity-outbox.js';

/**
 * Domain event → integration event, written to `identity.outbox` (G-1): each method enqueues one
 * row in the caller's OPEN unit of work, so the event commits or rolls back with the state change
 * it reports; the outbox relay publishes it afterwards (at least once). Nothing is published to
 * Kafka from the request path.
 *
 * Every identity event is tenant-scoped: key = the user id, envelope id = the domain event id,
 * `occurredAt` = the domain event's, tenant = the event's tenant and actor = the event's actor,
 * all explicit. The writer requires the unit of work's principal to act in that tenant
 * (`OUTBOX_TENANT_MISMATCH` otherwise), which every identity flow does (B3 flow table).
 * @throws OutboxError `OUTBOX_NO_TRANSACTION` outside a unit of work; a failure rolls the unit back
 */
@Injectable()
export class IdentityIntegrationEvents {
  constructor(private readonly outbox: IdentityOutbox) {}

  /** `identity.user-registered.v1`: tenant = the personal workspace, actor = the new user. */
  async userRegistered(event: UserRegisteredEvent): Promise<void> {
    await this.outbox.enqueue(
      USER_REGISTERED_EVENT,
      {
        userId: event.userId,
        email: event.email,
        displayName: event.displayName,
        registeredAt: event.occurredAt.toISOString(),
      },
      {
        key: event.userId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        tenantId: event.tenantId,
        actorId: event.userId,
      },
    );
  }

  /** `identity.membership-created.v1`: tenant = the membership's tenant. */
  async membershipCreated(event: MembershipCreatedEvent): Promise<void> {
    await this.outbox.enqueue(
      MEMBERSHIP_CREATED_EVENT,
      {
        userId: event.userId,
        email: event.email,
        displayName: event.displayName,
        createdAt: event.occurredAt.toISOString(),
      },
      {
        key: event.userId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        tenantId: event.tenantId,
        actorId: event.actorId,
      },
    );
  }

  /** `identity.membership-removed.v1`: tenant = the membership's tenant. */
  async membershipRemoved(event: MembershipRemovedEvent): Promise<void> {
    await this.outbox.enqueue(
      MEMBERSHIP_REMOVED_EVENT,
      { userId: event.userId, removedAt: event.occurredAt.toISOString() },
      {
        key: event.userId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        tenantId: event.tenantId,
        actorId: event.actorId,
      },
    );
  }
}
