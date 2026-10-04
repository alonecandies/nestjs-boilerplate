import type { DeadLetterTopic, KafkaTopic } from '@app/contracts';
import { EventPattern, Transport } from '@nestjs/microservices';

/**
 * `@EventPattern` for a Kafka integration-event topic. Use it instead of `@EventPattern(topic)`:
 * - The explicit `<string>` type argument is required in Nest 12.1: a bare
 *   `@EventPattern('topic')` picks the new typed overload, whose descriptor type rejects a
 *   typed `@Ctx() ctx: KafkaContext` parameter with TS1241 (nest-distributed §5.4).
 * - `Transport.KAFKA` binds the handler to the Kafka server only, so a hybrid app's gRPC server
 *   does not try to register it.
 * - Typing the topic as `KafkaTopic` (or its `.dlq`, for a replay consumer) turns a typo into a
 *   compile error.
 */
export const KafkaEventPattern = (topic: KafkaTopic | DeadLetterTopic): MethodDecorator =>
  EventPattern<string>(topic, Transport.KAFKA);
