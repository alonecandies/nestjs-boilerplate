import { KAFKA_HEADERS } from '@app/contracts';

/** DI token of the producer-only `ClientKafka` registered by `KafkaProducerModule`. */
export const KAFKA_PRODUCER_CLIENT = Symbol('KAFKA_PRODUCER_CLIENT');

/** DI token of the resolved `KafkaProducerOptions` (envelope `source`, connect behaviour). */
export const KAFKA_PRODUCER_OPTIONS = Symbol('KAFKA_PRODUCER_OPTIONS');

/**
 * Headers on dead-lettered records: the contract headers from `@app/contracts` plus where the
 * record came from, so an operator can replay it or find it in the source partition.
 */
export const DEAD_LETTER_HEADERS = {
  ORIGINAL_TOPIC: KAFKA_HEADERS.ORIGINAL_TOPIC,
  ORIGINAL_PARTITION: 'x-original-partition',
  ORIGINAL_OFFSET: 'x-original-offset',
  ERROR_MESSAGE: KAFKA_HEADERS.ERROR_MESSAGE,
  ERROR_TYPE: KAFKA_HEADERS.ERROR_TYPE,
  FAILED_AT: KAFKA_HEADERS.FAILED_AT,
} as const;

/** Stable error codes raised by the Kafka layer. */
export const KAFKA_ERROR_CODES = {
  /** The record does not match its topic's envelope/payload schema (never retried: dead-lettered). */
  INVALID_EVENT: 'INVALID_EVENT',
  /** The broker did not acknowledge a publish. */
  PUBLISH_FAILED: 'EVENT_PUBLISH_FAILED',
} as const;

/** Suffix of dead-letter topics (`<topic>.dlq`), matching `deadLetterTopic()` in `@app/contracts`. */
export const DEAD_LETTER_SUFFIX = '.dlq';
