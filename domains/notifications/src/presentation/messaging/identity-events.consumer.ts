import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import type { EventEnvelopeOf } from '@platform/contracts';
import {
  KafkaConsumerController,
  KafkaEventPattern,
  ParseEventEnvelopePipe,
} from '@platform/transport';
import { RemoveRecipientCommand } from '../../application/commands/remove-recipient/remove-recipient.command.js';
import { UpsertRecipientCommand } from '../../application/commands/upsert-recipient/upsert-recipient.command.js';
import { WelcomeUserCommand } from '../../application/commands/welcome-user/welcome-user.command.js';
import { requireEventTenant } from './event-tenant.js';

type UserRegisteredEnvelope = EventEnvelopeOf<typeof USER_REGISTERED_EVENT>;
type MembershipCreatedEnvelope = EventEnvelopeOf<typeof MEMBERSHIP_CREATED_EVENT>;
type MembershipRemovedEnvelope = EventEnvelopeOf<typeof MEMBERSHIP_REMOVED_EVENT>;

/**
 * identity → notifications. `@KafkaConsumerController()` = controller-scoped
 * `KafkaDeadLetterFilter` + `KafkaContextInterceptor`: an invalid envelope (pipe), a missing
 * tenant (`requireEventTenant`) or a failing command lands in `<topic>.dlq` and the offset
 * commits — a poison message never blocks the partition. The commands are idempotent (derived
 * notification id, mail idempotency key, recipient writes stamped with the event time), so
 * at-least-once redelivery and DLQ replays are harmless.
 */
@KafkaConsumerController()
export class IdentityEventsConsumer {
  constructor(private readonly commandBus: CommandBus) {}

  /** The welcome lands in the envelope tenant's inbox (the personal workspace). */
  @KafkaEventPattern(USER_REGISTERED_EVENT)
  async onUserRegistered(
    @Payload(new ParseEventEnvelopePipe(USER_REGISTERED_EVENT))
    event: UserRegisteredEnvelope,
  ): Promise<void> {
    const tenantId = requireEventTenant(event);
    const { userId, email, displayName, registeredAt } = event.payload;
    await this.commandBus.execute(
      new WelcomeUserCommand({
        tenantId,
        userId,
        email,
        displayName,
        registeredAt: new Date(registeredAt),
      }),
    );
  }

  /** The recipients projection follows memberships: one row per (envelope tenant, user). */
  @KafkaEventPattern(MEMBERSHIP_CREATED_EVENT)
  async onMembershipCreated(
    @Payload(new ParseEventEnvelopePipe(MEMBERSHIP_CREATED_EVENT))
    event: MembershipCreatedEnvelope,
  ): Promise<void> {
    const tenantId = requireEventTenant(event);
    const { userId, email, displayName, createdAt } = event.payload;
    await this.commandBus.execute(
      new UpsertRecipientCommand({
        tenantId,
        userId,
        email,
        displayName,
        createdAt: new Date(createdAt),
      }),
    );
  }

  @KafkaEventPattern(MEMBERSHIP_REMOVED_EVENT)
  async onMembershipRemoved(
    @Payload(new ParseEventEnvelopePipe(MEMBERSHIP_REMOVED_EVENT))
    event: MembershipRemovedEnvelope,
  ): Promise<void> {
    const tenantId = requireEventTenant(event);
    const { userId, removedAt } = event.payload;
    await this.commandBus.execute(
      new RemoveRecipientCommand({ tenantId, userId, removedAt: new Date(removedAt) }),
    );
  }
}
