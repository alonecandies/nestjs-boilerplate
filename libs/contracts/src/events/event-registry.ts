import type { z } from 'zod';
import { paymentSucceededPayload } from './billing.events.js';
import { type EventEnvelope, type EventEnvelopeSchema, eventEnvelopeSchema } from './envelope.js';
import { userRegisteredPayload } from './identity.events.js';
import { notificationCreatedPayload } from './notifications.events.js';
import { KAFKA_TOPICS, type KafkaTopic, topicVersion } from './topics.js';

/**
 * Topic -> payload schema. `satisfies Record<KafkaTopic, …>` makes adding a topic without a schema
 * (or a schema without a topic) a compile error.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  [KAFKA_TOPICS.USER_REGISTERED]: userRegisteredPayload,
  [KAFKA_TOPICS.PAYMENT_SUCCEEDED]: paymentSucceededPayload,
  [KAFKA_TOPICS.NOTIFICATION_CREATED]: notificationCreatedPayload,
} as const satisfies Record<KafkaTopic, z.ZodType>;

type PayloadSchemas = typeof EVENT_PAYLOAD_SCHEMAS;

/** Payload type carried by topic `T`. */
export type EventPayload<T extends KafkaTopic> = z.infer<PayloadSchemas[T]>;

/** Full envelope type carried by topic `T`. */
export type EventEnvelopeFor<T extends KafkaTopic> = EventEnvelope<EventPayload<T>>;

/**
 * Topic -> envelope schema, built once at module load: zod object construction is far more
 * expensive than parsing, so hot consumer paths only ever call `.parse()`.
 */
export const EVENT_ENVELOPE_SCHEMAS: {
  readonly [K in KafkaTopic]: EventEnvelopeSchema<PayloadSchemas[K]>;
} = Object.freeze({
  [KAFKA_TOPICS.USER_REGISTERED]: eventEnvelopeSchema(userRegisteredPayload),
  [KAFKA_TOPICS.PAYMENT_SUCCEEDED]: eventEnvelopeSchema(paymentSucceededPayload),
  [KAFKA_TOPICS.NOTIFICATION_CREATED]: eventEnvelopeSchema(notificationCreatedPayload),
});

function envelopeSchemaOf<T extends KafkaTopic>(topic: T): EventEnvelopeSchema<PayloadSchemas[T]> {
  // Runtime guard: topics often arrive as plain strings (KafkaContext#getTopic()) cast to KafkaTopic.
  if (!Object.hasOwn(EVENT_ENVELOPE_SCHEMAS, topic)) {
    throw new Error(`No event schema registered for Kafka topic "${String(topic)}"`);
  }
  return EVENT_ENVELOPE_SCHEMAS[topic];
}

/**
 * Validates a deserialised Kafka message value against the envelope + payload schema of `topic`.
 * Throws `ZodError` on invalid input (transport maps it to its own invalid-event exception) and a
 * plain `Error` for an unregistered topic.
 */
export function parseEventEnvelope<T extends KafkaTopic>(
  topic: T,
  raw: unknown,
): EventEnvelopeFor<T> {
  // zod cannot resolve `output<Schema[T]>` for a generic T; the concrete types are asserted equal
  // in event-registry.spec.ts.
  return envelopeSchemaOf(topic).parse(raw) as EventEnvelopeFor<T>;
}

/** Non-throwing variant of {@link parseEventEnvelope} (still throws for an unregistered topic). */
export function safeParseEventEnvelope<T extends KafkaTopic>(
  topic: T,
  raw: unknown,
): z.ZodSafeParseResult<EventEnvelopeFor<T>> {
  return envelopeSchemaOf(topic).safeParse(raw) as z.ZodSafeParseResult<EventEnvelopeFor<T>>;
}

/** Producer-side metadata for {@link createEventEnvelope}. */
export interface EventEnvelopeMeta {
  /** uuidv7 event id (time-ordered; consumers dedupe on it). */
  id: string;
  /** Producing service name. */
  source: string;
  correlationId?: string | undefined;
  /** Defaults to now. */
  occurredAt?: Date | undefined;
}

/**
 * Builds AND validates the envelope for `topic` (type = topic, version = topic major), so an invalid
 * payload fails in the producer instead of poisoning every consumer's dead-letter topic.
 */
export function createEventEnvelope<T extends KafkaTopic>(
  topic: T,
  payload: EventPayload<T>,
  meta: EventEnvelopeMeta,
): EventEnvelopeFor<T> {
  return parseEventEnvelope(topic, {
    id: meta.id,
    type: topic,
    version: topicVersion(topic),
    occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
    source: meta.source,
    ...(meta.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
    payload,
  });
}
