import { z } from 'zod';

/**
 * Envelope fields shared by every integration event. Kept as a plain shape (not a schema) so each
 * topic's envelope schema is built ONCE at module load (see event-registry.ts) — never per message.
 */
const envelopeShape = {
  id: z.uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  source: z.string().min(1),
  correlationId: z.string().min(1).optional(),
};

/** zod schema type of an envelope wrapping payload schema `T`. */
export type EventEnvelopeSchema<T extends z.ZodType> = z.ZodObject<
  typeof envelopeShape & { payload: T }
>;

/**
 * Builds the envelope schema for a payload schema. Unknown keys are stripped (zod default) rather
 * than rejected: a tolerant reader lets producers add fields without breaking older consumers.
 */
export function eventEnvelopeSchema<T extends z.ZodType>(payload: T): EventEnvelopeSchema<T> {
  return z.object({ ...envelopeShape, payload });
}

/** Wire format of every Kafka integration event (JSON value of the record). */
export interface EventEnvelope<T> {
  /** Unique event id (uuidv7) — consumers use it as their idempotency key. */
  id: string;
  /** Event type; equals the topic for single-event topics. */
  type: string;
  /** Payload schema major version (matches the topic `.v<major>` suffix). */
  version: number;
  /** ISO-8601 UTC timestamp (`Date#toISOString()`) of when the fact happened. */
  occurredAt: string;
  /** Producing service (`SERVICE_NAME`). */
  source: string;
  /** Request/correlation id of the operation that caused the event, for cross-service tracing. */
  correlationId?: string | undefined;
  payload: T;
}
