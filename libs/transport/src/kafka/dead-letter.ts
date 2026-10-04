import { isDomainException } from '@app/common';
import type { KafkaContext } from '@nestjs/microservices';
import { isNil, isString, truncate } from 'lodash-es';
import { DEAD_LETTER_HEADERS, DEAD_LETTER_SUFFIX } from './kafka.constants.js';

/** A record for `producer.send()`, in the shape kafkajs accepts. */
export interface DeadLetterRecord {
  topic: string;
  message: {
    key: string | Buffer | null;
    value: string | Buffer | null;
    headers: Record<string, string | Buffer>;
  };
}

/** Error messages can be long (zod lists, stack-y driver errors); headers should stay small. */
const MAX_ERROR_MESSAGE_LENGTH = 1_024;

/** `DomainException.code` when there is one (stable, greppable), else the error class name. */
export function errorTypeOf(error: unknown): string {
  if (isDomainException(error)) return error.code;
  if (error instanceof Error) return error.name === 'Error' ? error.constructor.name : error.name;
  return typeof error;
}

function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message, { length: MAX_ERROR_MESSAGE_LENGTH });
}

/**
 * Nest's `KafkaParser` already decoded the record (value and headers JSON-parsed when they looked
 * like JSON, everything else turned into strings). Re-encode it so the dead-letter record carries
 * the same bytes a replay consumer expects. Binary values (e.g. Schema Registry framing) are kept.
 */
function encode(value: unknown): string | Buffer | null {
  if (isNil(value)) return null;
  if (isString(value) || Buffer.isBuffer(value)) return value;
  return JSON.stringify(value);
}

function encodeHeaders(headers: unknown): Record<string, string | Buffer> {
  const result: Record<string, string | Buffer> = {};
  if (typeof headers !== 'object' || headers === null) return result;
  for (const [key, value] of Object.entries(headers)) {
    const encoded = encode(Array.isArray(value) ? value[0] : value);
    if (encoded !== null) result[key] = encoded;
  }
  return result;
}

/**
 * The dead-letter record for the message in `context`: same key, value and headers, sent to
 * `<topic>.dlq`, plus where it came from and why it failed. Same key = same partition order in the
 * dead-letter topic, which makes ordered replays possible.
 */
export function buildDeadLetterRecord(
  context: KafkaContext,
  error: unknown,
  failedAt: Date = new Date(),
): DeadLetterRecord {
  const message = context.getMessage();
  const topic = context.getTopic();
  return {
    topic: `${topic}${DEAD_LETTER_SUFFIX}`,
    message: {
      key: encode(message.key),
      value: encode(message.value),
      headers: {
        ...encodeHeaders(message.headers),
        [DEAD_LETTER_HEADERS.ORIGINAL_TOPIC]: topic,
        [DEAD_LETTER_HEADERS.ORIGINAL_PARTITION]: String(context.getPartition()),
        [DEAD_LETTER_HEADERS.ORIGINAL_OFFSET]: message.offset,
        [DEAD_LETTER_HEADERS.ERROR_TYPE]: errorTypeOf(error),
        [DEAD_LETTER_HEADERS.ERROR_MESSAGE]: errorMessageOf(error),
        [DEAD_LETTER_HEADERS.FAILED_AT]: failedAt.toISOString(),
      },
    },
  };
}

/**
 * Produces the dead-letter record with the consumer's own (idempotent) producer, which every
 * `KafkaContext` carries, so consumers need no separate producer client. Resolves once the broker
 * acknowledged it; rejects otherwise.
 */
export async function sendToDeadLetter(
  context: KafkaContext,
  error: unknown,
  failedAt: Date = new Date(),
): Promise<DeadLetterRecord> {
  const record = buildDeadLetterRecord(context, error, failedAt);
  await context.getProducer().send({ topic: record.topic, acks: -1, messages: [record.message] });
  return record;
}
