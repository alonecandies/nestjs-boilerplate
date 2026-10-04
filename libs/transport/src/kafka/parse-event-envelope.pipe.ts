import {
  type EventEnvelopeFor,
  isKafkaTopic,
  type KafkaTopic,
  safeParseEventEnvelope,
  topicVersion,
} from '@app/contracts';
import type { PipeTransform } from '@nestjs/common';
import { InvalidEventException } from './kafka.errors.js';

/**
 * Validates a Kafka payload against the envelope + payload schema of `topic` and returns the
 * typed envelope:
 *
 * ```ts
 * @KafkaEventPattern(KAFKA_TOPICS.USER_REGISTERED)
 * onUserRegistered(@Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.USER_REGISTERED)) event: EventEnvelopeFor<'identity.user-registered.v1'>)
 * ```
 *
 * Besides the schema, it checks that `type` and `version` match the topic: a record produced for
 * another contract version is rejected rather than half-understood. Failures throw
 * `InvalidEventException`, which `KafkaDeadLetterFilter` moves to `<topic>.dlq` (a schema error
 * never succeeds on retry). Payload schemas stay tolerant readers: unknown keys are stripped.
 */
export class ParseEventEnvelopePipe<T extends KafkaTopic>
  implements PipeTransform<unknown, EventEnvelopeFor<T>>
{
  private readonly version: number;

  constructor(private readonly topic: T) {
    // Fail at bootstrap (decorator evaluation), not on the first message.
    if (!isKafkaTopic(topic)) throw new Error(`Unknown Kafka topic "${String(topic)}"`);
    this.version = topicVersion(topic);
  }

  transform(value: unknown): EventEnvelopeFor<T> {
    const result = safeParseEventEnvelope(this.topic, value);
    if (!result.success) {
      throw InvalidEventException.forTopic(this.topic, result.error.issues, {
        cause: result.error,
      });
    }
    const envelope = result.data;
    if (envelope.type !== this.topic || envelope.version !== this.version) {
      throw InvalidEventException.forTopic(this.topic, [
        ...(envelope.type === this.topic
          ? []
          : [{ path: ['type'], message: `Expected "${this.topic}"`, code: 'invalid_value' }]),
        ...(envelope.version === this.version
          ? []
          : [{ path: ['version'], message: `Expected ${this.version}`, code: 'invalid_value' }]),
      ]);
    }
    return envelope;
  }
}
