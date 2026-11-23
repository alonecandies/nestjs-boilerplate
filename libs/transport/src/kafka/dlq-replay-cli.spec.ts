import type { Kafka, KafkaConfig } from 'kafkajs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeadLetterRecord } from './dead-letter.js';
import { runDlqReplayCli } from './dlq-replay-cli.js';

const TOPIC = 'orders.order-placed.v1';
const DLQ = `${TOPIC}.dlq`;

/** One dead-letter record of TOPIC at partition 0, offset 0, as the broker hands it back. */
function dlqRecord() {
  const { message } = buildDeadLetterRecord(
    {
      getMessage: () => ({ key: 'user-1', value: { id: 'evt-1' }, headers: {}, offset: '7' }),
      getTopic: () => TOPIC,
      getPartition: () => 0,
    } as never,
    new Error('store down'),
  );
  return {
    offset: '0',
    key: Buffer.from(String(message.key)),
    value: Buffer.from(String(message.value)),
    headers: Object.fromEntries(
      Object.entries(message.headers).map(([name, value]) => [name, Buffer.from(value)]),
    ),
  };
}

/** A kafkajs stand-in holding one record in `<topic>.dlq`; records every send and commit. */
function fakeKafka() {
  const sent: unknown[] = [];
  const commits: unknown[] = [];
  const kafka = {
    admin: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      fetchTopicOffsets: () =>
        Promise.resolve([{ partition: 0, offset: '0', low: '0', high: '1' }]),
      fetchOffsets: () =>
        Promise.resolve([{ topic: DLQ, partitions: [{ partition: 0, offset: '-1' }] }]),
    }),
    producer: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: (record: unknown) => {
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
      commitOffsets: (offsets: unknown[]) => {
        commits.push(...offsets);
        return Promise.resolve();
      },
      run: async ({ eachMessage }: { eachMessage: (payload: unknown) => Promise<void> }) => {
        await eachMessage({ topic: DLQ, partition: 0, message: dlqRecord() });
      },
    }),
  };
  return { kafka: kafka as unknown as Kafka, sent, commits };
}

/** What a `process.stdout.write` / `process.stderr.write` spy recorded. */
interface WriteSpy {
  mock: { calls: unknown[][] };
}

describe('runDlqReplayCli', () => {
  let stderr: WriteSpy;
  let stdout: WriteSpy;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = undefined; // never leak a failure code into the test worker
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const printed = (spy: WriteSpy): string => spy.mock.calls.map((call) => String(call[0])).join('');

  // A production image run without arguments: no Kafka settings, so nothing but the arguments may
  // be read before the usage is printed.
  it.each([
    ['no topic', []],
    ['a topic that is not <context>.<event-name>.v<major>', ['not-a-topic']],
    ['an unknown flag', [TOPIC, '--force']],
  ])('%s: prints the usage, exits 2 and creates no Kafka client', async (_case, args) => {
    vi.stubEnv('NODE_ENV', 'production');
    const createKafka = vi.fn();

    await runDlqReplayCli(args, { createKafka });

    expect(process.exitCode).toBe(2);
    expect(printed(stderr)).toMatch(/^usage: dlq-replay <topic> \[--dry-run\] \[--group <id>\]/);
    expect(createKafka).not.toHaveBeenCalled();
  });

  it('--dry-run replays nothing: no record is produced and no offset committed', async () => {
    vi.stubEnv('KAFKA_BROKERS', 'kafka-1:9092,kafka-2:9092');
    vi.stubEnv('LOG_PRETTY', 'false');
    const { kafka, sent, commits } = fakeKafka();
    let config: KafkaConfig | undefined;

    await runDlqReplayCli([TOPIC, '--dry-run'], {
      createKafka: (clientConfig) => {
        config = clientConfig;
        return kafka;
      },
    });

    expect(config).toMatchObject({
      clientId: 'dlq-replay',
      brokers: ['kafka-1:9092', 'kafka-2:9092'],
    });
    expect(sent).toEqual([]);
    expect(commits).toEqual([]);
    expect(JSON.parse(printed(stdout).trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      level: 'log',
      message: `Would replay 1 record(s) from ${DLQ} to ${TOPIC}`,
    });
    expect(process.exitCode).toBe(0);
  });

  it('without --dry-run re-produces the record and commits its offset', async () => {
    vi.stubEnv('LOG_PRETTY', 'false');
    const { kafka, sent, commits } = fakeKafka();

    await runDlqReplayCli([TOPIC, '--group', 'ops-replay'], { createKafka: () => kafka });

    expect(sent).toEqual([expect.objectContaining({ topic: TOPIC })]);
    expect(commits).toEqual([{ topic: DLQ, partition: 0, offset: '1' }]);
    expect(process.exitCode).toBe(0);
  });

  it('a Kafka config error exits 1 with a JSON error line, before any client exists', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv('KAFKA_SSL', 'false');
    const createKafka = vi.fn();

    await runDlqReplayCli([TOPIC], { createKafka });

    expect(createKafka).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(printed(stderr)).toContain('KAFKA_SSL');
  });
});
