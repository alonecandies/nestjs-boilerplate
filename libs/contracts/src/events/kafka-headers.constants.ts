/**
 * Kafka record headers shared by producers, consumers and the dead-letter filter. Headers let
 * brokers/tools route and inspect messages without deserialising the JSON value.
 */
export const KAFKA_HEADERS = {
  /** Envelope `type` (= topic for single-event topics). */
  EVENT_TYPE: 'x-event-type',
  /** Envelope `correlationId`, propagated from the originating request. */
  CORRELATION_ID: 'x-correlation-id',
  /** Dead-letter metadata, set when a message is moved to `<topic>.dlq`. */
  ORIGINAL_TOPIC: 'x-original-topic',
  ERROR_MESSAGE: 'x-error-message',
  ERROR_TYPE: 'x-error-type',
  FAILED_AT: 'x-failed-at',
} as const;

export type KafkaHeader = (typeof KAFKA_HEADERS)[keyof typeof KAFKA_HEADERS];
