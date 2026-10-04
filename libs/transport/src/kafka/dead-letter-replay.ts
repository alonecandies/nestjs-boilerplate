import { Logger } from '@nestjs/common';
import type { IHeaders, Kafka } from 'kafkajs';
import { DEAD_LETTER_HEADERS, DEAD_LETTER_SUFFIX } from './kafka.constants.js';

/** What `replayDeadLetters` needs from a dead-letter record. */
export interface DeadLetterMessage {
  key: Buffer | null;
  value: Buffer | null;
  headers?: IHeaders | undefined;
}

/** A record to re-produce on the source topic. */
export interface ReplayRecord {
  topic: string;
  message: { key: Buffer | null; value: Buffer | null; headers: Record<string, Buffer | string> };
}

const DEAD_LETTER_HEADER_NAMES: ReadonlySet<string> = new Set(Object.values(DEAD_LETTER_HEADERS));

function headerText(value: IHeaders[string]): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}

/**
 * The record `buildDeadLetterRecord` dead-lettered, as it was on `sourceTopic`: same key and value
 * bytes (so the envelope id, and with it every consumer's deduplication, is unchanged) and the
 * original headers, without the `x-original-*` / `x-error-*` / `x-failed-at` ones. Returns
 * `undefined` for a record whose `x-original-topic` names another topic.
 */
export function buildReplayRecord(
  message: DeadLetterMessage,
  sourceTopic: string,
): ReplayRecord | undefined {
  const headers: Record<string, Buffer | string> = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (DEAD_LETTER_HEADER_NAMES.has(name) || value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) headers[name] = first;
  }
  const original = headerText(message.headers?.[DEAD_LETTER_HEADERS.ORIGINAL_TOPIC]);
  if (original !== undefined && original !== sourceTopic) return undefined;
  return { topic: sourceTopic, message: { key: message.key, value: message.value, headers } };
}

export interface ReplayDeadLettersOptions {
  /** Source topic: records of `<topic>.dlq` are re-produced to it. */
  topic: string;
  /**
   * Consumer group that records how far the replay got, so running it again only replays what
   * was dead-lettered since. Default `<topic>.dlq-replay`.
   */
  groupId?: string;
  /** Log what would be replayed, produce nothing and commit nothing. */
  dryRun?: boolean;
  /** Stop when no record arrives for this long (a partition truncated by retention). Default 30 s. */
  idleTimeoutMs?: number;
  logger?: Pick<Logger, 'log' | 'warn'>;
}

export interface ReplayDeadLettersResult {
  /** Records re-produced to the source topic (would-be, with `dryRun`). */
  replayed: number;
  /** Records skipped because `x-original-topic` names another topic. */
  skipped: number;
}

/**
 * Replays `<topic>.dlq` into `<topic>` once the cause of the failures is fixed: every record that
 * was in the dead-letter topic when the replay started, oldest first per partition. Records
 * dead-lettered during the replay are left for the next run.
 *
 * Progress is committed to `groupId` after each record is acknowledged, so an interrupted replay
 * resumes where it stopped; at worst one record is produced twice, which consumers tolerate
 * because they deduplicate on the envelope id.
 */
export async function replayDeadLetters(
  kafka: Kafka,
  options: ReplayDeadLettersOptions,
): Promise<ReplayDeadLettersResult> {
  const { topic, dryRun = false, idleTimeoutMs = 30_000 } = options;
  const logger = options.logger ?? new Logger('DeadLetterReplay');
  const dlq = `${topic}${DEAD_LETTER_SUFFIX}`;
  const groupId = options.groupId ?? `${dlq}-replay`;

  // Snapshot: per partition, the offset to stop at (the high watermark when the replay starts).
  const admin = kafka.admin();
  await admin.connect();
  const pending = new Map<number, bigint>();
  try {
    const [watermarks, committed] = await Promise.all([
      admin.fetchTopicOffsets(dlq),
      admin.fetchOffsets({ groupId, topics: [dlq] }),
    ]);
    const committedOffsets = new Map(
      (committed[0]?.partitions ?? []).map(({ partition, offset }) => [partition, BigInt(offset)]),
    );
    for (const { partition, low, high } of watermarks) {
      const start = committedOffsets.get(partition) ?? -1n;
      const from = start >= BigInt(low) ? start : BigInt(low);
      if (from < BigInt(high)) pending.set(partition, BigInt(high));
    }
  } finally {
    await admin.disconnect();
  }
  const result: ReplayDeadLettersResult = { replayed: 0, skipped: 0 };
  if (pending.size === 0) {
    logger.log(`${dlq} has nothing to replay for group ${groupId}`);
    return result;
  }

  const producer = kafka.producer({ idempotent: true, allowAutoTopicCreation: false });
  // A record that cannot be produced stops the replay (crash) instead of looping forever.
  const consumer = kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
    retry: { retries: 3, restartOnFailure: () => Promise.resolve(false) },
  });
  await Promise.all([producer.connect(), consumer.connect()]);
  try {
    await consumer.subscribe({ topics: [dlq], fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      let idle: NodeJS.Timeout | undefined;
      const armIdleTimer = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          logger.warn(
            `No record from ${dlq} for ${idleTimeoutMs} ms; stopping with partitions ${[...pending.keys()].join(', ')} unfinished`,
          );
          resolve();
        }, idleTimeoutMs);
      };
      armIdleTimer();
      consumer.on(consumer.events.CRASH, ({ payload }) => {
        clearTimeout(idle);
        reject(payload.error);
      });
      consumer
        .run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            const end = pending.get(partition);
            const offset = BigInt(message.offset);
            if (end === undefined || offset >= end) return;
            armIdleTimer();
            const record = buildReplayRecord(message, topic);
            if (record === undefined) {
              result.skipped += 1;
              logger.warn(`Skipping ${dlq}[${partition}]@${message.offset}: from another topic`);
            } else {
              result.replayed += 1;
              if (!dryRun) {
                await producer.send({ topic: record.topic, acks: -1, messages: [record.message] });
              }
            }
            if (!dryRun) {
              await consumer.commitOffsets([
                { topic: dlq, partition, offset: (offset + 1n).toString() },
              ]);
            }
            if (offset + 1n >= end) {
              pending.delete(partition);
              if (pending.size === 0) {
                clearTimeout(idle);
                resolve();
              }
            }
          },
        })
        .catch((error: unknown) => {
          clearTimeout(idle);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } finally {
    await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
  }
  logger.log(
    `${dryRun ? 'Would replay' : 'Replayed'} ${result.replayed} record(s) from ${dlq} to ${topic}` +
      (result.skipped > 0 ? `, skipped ${result.skipped}` : ''),
  );
  return result;
}
