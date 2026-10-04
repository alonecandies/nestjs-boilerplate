import type { Kafka } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import { buildDeadLetterRecord } from './dead-letter.js';
import { buildReplayRecord, replayDeadLetters } from './dead-letter-replay.js';

const TOPIC = 'identity.user-registered.v1';
const DLQ = `${TOPIC}.dlq`;
const quiet = { log: vi.fn(), warn: vi.fn() };

interface StoredRecord {
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: Record<string, Buffer>;
}

/** A dead-letter record exactly as the broker hands it back (headers as Buffers). */
function dlqRecord(partition: number, offset: number, id: string, topic = TOPIC): StoredRecord {
  const { message } = buildDeadLetterRecord(
    {
      getMessage: () => ({
        key: 'user-1',
        value: { id },
        headers: { 'x-correlation-id': 'corr-1' },
        offset: '42',
      }),
      getTopic: () => topic,
      getPartition: () => 0,
    } as never,
    new Error('cassandra down'),
  );
  const headers = Object.fromEntries(
    Object.entries(message.headers).map(([name, value]) => [name, Buffer.from(value)]),
  );
  return {
    partition,
    offset: String(offset),
    key: Buffer.from(String(message.key)),
    value: Buffer.from(String(message.value)),
    headers,
  };
}

/** Minimal in-memory kafkajs: one DLQ topic, committed offsets per group, recorded sends. */
function fakeKafka(records: StoredRecord[], committed: Record<number, string> = {}) {
  const sent: { topic: string; messages: unknown[] }[] = [];
  const commits: { partition: number; offset: string }[] = [];
  const partitions = [...new Set(records.map((r) => r.partition)), 0];
  const watermarks = [...new Set(partitions)].map((partition) => {
    const offsets = records.filter((r) => r.partition === partition).map((r) => Number(r.offset));
    return {
      partition,
      offset: '0',
      low: String(offsets.length > 0 ? Math.min(...offsets) : 0),
      high: String(offsets.length > 0 ? Math.max(...offsets) + 1 : 0),
    };
  });
  const kafka = {
    admin: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchTopicOffsets: (topic: string) => {
        expect(topic).toBe(DLQ);
        return Promise.resolve(watermarks);
      },
      fetchOffsets: () =>
        Promise.resolve([
          {
            topic: DLQ,
            partitions: watermarks.map(({ partition }) => ({
              partition,
              offset: committed[partition] ?? '-1',
            })),
          },
        ]),
    }),
    producer: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: (record: { topic: string; messages: unknown[] }) => {
        sent.push(record);
        return Promise.resolve([]);
      },
    }),
    consumer: () => ({
      events: { CRASH: 'consumer.crash' },
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      commitOffsets: (offsets: { partition: number; offset: string }[]) => {
        commits.push(...offsets.map(({ partition, offset }) => ({ partition, offset })));
        return Promise.resolve();
      },
      run: async ({ eachMessage }: { eachMessage: (payload: unknown) => Promise<void> }) => {
        // Delivered from the committed offset on, like a consumer group would.
        for (const record of records) {
          if (BigInt(record.offset) < BigInt(committed[record.partition] ?? '0')) continue;
          await eachMessage({ topic: DLQ, partition: record.partition, message: record });
        }
      },
    }),
  };
  return { kafka: kafka as unknown as Kafka, sent, commits };
}

describe('buildReplayRecord', () => {
  it('restores key, value and the original headers, without the dead-letter ones', () => {
    const replay = buildReplayRecord(dlqRecord(0, 0, 'evt-1'), TOPIC);
    expect(replay?.topic).toBe(TOPIC);
    expect(replay?.message.value?.toString()).toBe('{"id":"evt-1"}');
    expect(replay?.message.key?.toString()).toBe('user-1');
    expect(Object.keys(replay?.message.headers ?? {})).toEqual(['x-correlation-id']);
  });

  it('refuses a record that came from another topic', () => {
    expect(buildReplayRecord(dlqRecord(0, 0, 'evt-1', 'other.topic.v1'), TOPIC)).toBeUndefined();
  });
});

describe('replayDeadLetters', () => {
  it('re-produces every dead-lettered record to the source topic and commits progress', async () => {
    const { kafka, sent, commits } = fakeKafka([
      dlqRecord(0, 0, 'evt-1'),
      dlqRecord(0, 1, 'evt-2'),
      dlqRecord(1, 5, 'evt-3'),
    ]);

    await expect(replayDeadLetters(kafka, { topic: TOPIC, logger: quiet })).resolves.toEqual({
      replayed: 3,
      skipped: 0,
    });

    expect(sent.map(({ topic }) => topic)).toEqual([TOPIC, TOPIC, TOPIC]);
    expect(sent.map(({ messages }) => (messages[0] as { value: Buffer }).value.toString())).toEqual(
      ['{"id":"evt-1"}', '{"id":"evt-2"}', '{"id":"evt-3"}'],
    );
    expect(commits).toEqual([
      { partition: 0, offset: '1' },
      { partition: 0, offset: '2' },
      { partition: 1, offset: '6' },
    ]);
  });

  it('resumes after the committed offset and returns at once when nothing is left', async () => {
    const records = [dlqRecord(0, 0, 'evt-1'), dlqRecord(0, 1, 'evt-2')];
    const resumed = fakeKafka(records, { 0: '1' });
    await expect(
      replayDeadLetters(resumed.kafka, { topic: TOPIC, logger: quiet }),
    ).resolves.toEqual({ replayed: 1, skipped: 0 });

    const done = fakeKafka(records, { 0: '2' });
    await expect(replayDeadLetters(done.kafka, { topic: TOPIC, logger: quiet })).resolves.toEqual({
      replayed: 0,
      skipped: 0,
    });
    expect(done.sent).toEqual([]);
  });

  it('produces and commits nothing in dry-run mode', async () => {
    const { kafka, sent, commits } = fakeKafka([dlqRecord(0, 0, 'evt-1')]);
    await expect(
      replayDeadLetters(kafka, { topic: TOPIC, dryRun: true, logger: quiet }),
    ).resolves.toEqual({ replayed: 1, skipped: 0 });
    expect(sent).toEqual([]);
    expect(commits).toEqual([]);
  });
});
