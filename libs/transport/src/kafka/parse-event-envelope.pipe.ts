import type { PipeTransform } from '@nestjs/common';
import {
  type EventContract,
  type EventEnvelope,
  eventEnvelopeSchemaFor,
  safeParseEventEnvelope,
  topicVersion,
} from '@platform/contracts';
import { InvalidEventException } from './kafka.errors.js';

/**
 * Validates a Kafka payload against the envelope + payload schema of `contract` and returns the
 * typed envelope:
 *
 * ```ts
 * @KafkaEventPattern(ORDER_PLACED_EVENT)
 * onOrderPlaced(@Payload(new ParseEventEnvelopePipe(ORDER_PLACED_EVENT)) event: EventEnvelopeOf<typeof ORDER_PLACED_EVENT>)
 * ```
 *
 * Besides the schema, it checks that `type` and `version` match the topic: a record produced for
 * another contract version is rejected rather than half-understood. Failures throw
 * `InvalidEventException`, which `KafkaDeadLetterFilter` moves to `<topic>.dlq` (a schema error
 * never succeeds on retry). Payload schemas stay tolerant readers: unknown keys are stripped.
 */
export class ParseEventEnvelopePipe<TPayload>
  implements PipeTransform<unknown, EventEnvelope<TPayload>>
{
  private readonly topic: string;
  private readonly version: number;

  constructor(private readonly contract: EventContract<TPayload>) {
    // Fail at bootstrap (decorator evaluation), not on the first message: a topic without a
    // `.v<major>` suffix throws here, and the envelope schema is built once, now.
    this.topic = contract.topic;
    this.version = topicVersion(contract.topic);
    eventEnvelopeSchemaFor(contract);
  }

  transform(value: unknown): EventEnvelope<TPayload> {
    const result = safeParseEventEnvelope(this.contract, value);
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
