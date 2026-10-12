import { EventPattern, Transport } from '@nestjs/microservices';
import { deadLetterTopic, type EventContract } from '@platform/contracts';

/** Options of {@link KafkaEventPattern}. */
export interface KafkaEventPatternOptions {
  /**
   * Subscribe to the contract's dead-letter twin (`<topic>.dlq`) instead, e.g. for a replay or
   * quarantine consumer. Records there still carry the source topic's envelope.
   */
  deadLetter?: boolean;
}

/**
 * `@EventPattern` for the topic of an integration-event contract. Use it instead of
 * `@EventPattern(topic)`:
 * - The explicit `<string>` type argument is required in Nest 12.1: a bare
 *   `@EventPattern('topic')` picks the new typed overload, whose descriptor type rejects a
 *   typed `@Ctx() ctx: KafkaContext` parameter with TS1241 (nest-distributed §5.4).
 * - `Transport.KAFKA` binds the handler to the Kafka server only, so a hybrid app's gRPC server
 *   does not try to register it.
 * - Taking the contract (exported by the producer's contracts package) instead of a string keeps
 *   the topic name in one place and makes a typo impossible.
 */
export const KafkaEventPattern = (
  contract: EventContract<unknown>,
  options: KafkaEventPatternOptions = {},
): MethodDecorator =>
  EventPattern<string>(
    options.deadLetter === true ? deadLetterTopic(contract.topic) : contract.topic,
    Transport.KAFKA,
  );
