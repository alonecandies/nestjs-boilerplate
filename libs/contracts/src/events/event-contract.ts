import type { z } from 'zod';
import { type EventEnvelope, type EventEnvelopeSchema, eventEnvelopeSchema } from './envelope.js';
import { EVENT_TOPIC_PATTERN, isEventTopic, topicVersion } from './topics.js';

/**
 * One integration event: its Kafka topic and its payload schema. The producing domain's contracts
 * package exports one per topic (`<EVENT>_EVENT`); transport, producers and consumers only ever
 * take these values, never a topic name.
 */
export interface EventContract<TPayload> {
  /** `<context>.<event-name>.v<major>`; also the envelope `type`. */
  readonly topic: string;
  /** Payload schema: a tolerant reader (unknown keys are stripped, not rejected). */
  readonly payload: z.ZodType<TPayload>;
}

/** Payload type carried by an event contract. */
export type EventPayloadOf<C> = C extends EventContract<infer TPayload> ? TPayload : never;

/** Envelope type carried by an event contract. */
export type EventEnvelopeOf<C> = EventEnvelope<EventPayloadOf<C>>;

/**
 * A frozen event contract. Fails at module load when `topic` breaks the
 * `<context>.<event-name>.v<major>` convention, so a typo never reaches a broker.
 */
export function defineEventContract<TPayload>(
  topic: string,
  payload: z.ZodType<TPayload>,
): EventContract<TPayload> {
  if (!EVENT_TOPIC_PATTERN.test(topic)) {
    throw new Error(`Kafka topic "${topic}" must be named <context>.<event-name>.v<major>`);
  }
  return Object.freeze({ topic, payload });
}

/** Narrows an unknown value (scripts scan whole module namespaces) to an event contract. */
export function isEventContract(value: unknown): value is EventContract<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const { topic, payload } = value as { topic?: unknown; payload?: { safeParse?: unknown } };
  return isEventTopic(topic) && typeof payload?.safeParse === 'function';
}

const envelopeSchemas = new WeakMap<EventContract<unknown>, z.ZodType>();

/**
 * The envelope schema of `contract`, built on first use and cached per contract object: zod
 * object construction is far more expensive than parsing, so hot paths only ever call `.parse()`.
 */
export function eventEnvelopeSchemaFor<TPayload>(
  contract: EventContract<TPayload>,
): EventEnvelopeSchema<z.ZodType<TPayload>> {
  let schema = envelopeSchemas.get(contract);
  if (schema === undefined) {
    schema = eventEnvelopeSchema(contract.payload);
    envelopeSchemas.set(contract, schema);
  }
  return schema as EventEnvelopeSchema<z.ZodType<TPayload>>;
}

/**
 * Validates a deserialised Kafka message value against the envelope and payload schema of
 * `contract`. Throws `ZodError` on invalid input (transport maps it to its invalid-event
 * exception).
 */
export function parseEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  raw: unknown,
): EventEnvelope<TPayload> {
  return eventEnvelopeSchemaFor(contract).parse(raw);
}

/** Non-throwing variant of {@link parseEventEnvelope}. */
export function safeParseEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  raw: unknown,
): z.ZodSafeParseResult<EventEnvelope<TPayload>> {
  return eventEnvelopeSchemaFor(contract).safeParse(raw);
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
 * Builds AND validates the envelope of `contract` (type = topic, version = topic major), so an
 * invalid payload fails in the producer instead of poisoning every consumer's dead-letter topic.
 */
export function createEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  payload: NoInfer<TPayload>,
  meta: EventEnvelopeMeta,
): EventEnvelope<TPayload> {
  return parseEventEnvelope(contract, {
    id: meta.id,
    type: contract.topic,
    version: topicVersion(contract.topic),
    occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
    source: meta.source,
    ...(meta.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
    payload,
  });
}
