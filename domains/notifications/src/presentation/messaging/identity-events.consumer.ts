import { USER_REGISTERED_EVENT } from '@domain/identity-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import type { EventEnvelopeOf } from '@platform/contracts';
import {
  KafkaConsumerController,
  KafkaEventPattern,
  ParseEventEnvelopePipe,
} from '@platform/transport';
import { WelcomeUserCommand } from '../../application/commands/welcome-user/welcome-user.command.js';

type UserRegisteredEnvelope = EventEnvelopeOf<typeof USER_REGISTERED_EVENT>;

/**
 * identity → notifications. `@KafkaConsumerController()` = controller-scoped
 * `KafkaDeadLetterFilter` + `KafkaContextInterceptor`: an invalid envelope (pipe) or a failing
 * command lands in `identity.user-registered.v1.dlq` and the offset commits — a poison message
 * never blocks the partition. The command is idempotent (derived
 * notification id, mail idempotency key), so at-least-once redelivery and DLQ replays are
 * harmless.
 */
@KafkaConsumerController()
export class IdentityEventsConsumer {
  constructor(private readonly commandBus: CommandBus) {}

  @KafkaEventPattern(USER_REGISTERED_EVENT)
  async onUserRegistered(
    @Payload(new ParseEventEnvelopePipe(USER_REGISTERED_EVENT))
    event: UserRegisteredEnvelope,
  ): Promise<void> {
    const { userId, email, displayName, registeredAt } = event.payload;
    await this.commandBus.execute(
      new WelcomeUserCommand({ userId, email, displayName, registeredAt: new Date(registeredAt) }),
    );
  }
}
