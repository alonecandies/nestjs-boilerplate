import { parseArgs } from 'node:util';
import { ConsoleLogger } from '@nestjs/common';
import { kafkaConfig, observabilityConfig } from '@platform/config';
import { isEventTopic } from '@platform/contracts';
import { Kafka, type KafkaConfig } from 'kafkajs';
import { replayDeadLetters } from './dead-letter-replay.js';
import { createKafkaClientConfig } from './kafka.options.js';

const USAGE =
  'usage: dlq-replay <topic> [--dry-run] [--group <id>]\n' +
  '  <topic>: a source topic, <context>.<event-name>.v<major> (docker/kafka/topics.txt);\n' +
  '           <topic>.dlq is replayed into it\n' +
  '  --dry-run: log what would be replayed, produce and commit nothing\n' +
  '  --group <id>: the consumer group that records progress (default <topic>.dlq-replay)\n';

export interface DlqReplayCliOptions {
  /** Builds the Kafka client from the `kafka` namespace (tests pass a fake). */
  createKafka?: (config: KafkaConfig) => Kafka;
}

/**
 * The body of every consuming app's `src/cli/dlq-replay.ts`: a one-off job that replays
 * `<topic>.dlq` into `<topic>` once the cause of the failures is fixed (`replayDeadLetters`), run as
 * `node dist/cli/dlq-replay.js <topic> [--dry-run] [--group <id>]` in the app's image (docker compose
 * `run`, a k8s Job) or from a checkout through `libs/transport/scripts/kafka-dlq-replay.mjs`.
 *
 * Broker settings come from the `kafka` config namespace (KAFKA_BROKERS, KAFKA_SSL, KAFKA_SASL_*),
 * exactly as the services read them. Without a valid topic, or with an unknown flag, it prints the
 * usage and exits 2 before reading any config: run without arguments it only prints its usage,
 * which is what the image build's load check relies on. Sets `process.exitCode` (0 = replayed,
 * 1 = a record from another topic was skipped or the replay failed) instead of exiting, so the
 * last log line is flushed. Logs are JSON lines unless `LOG_PRETTY` (default on in development).
 * The caller imports `reflect-metadata` first, as the other entrypoints do.
 */
export async function runDlqReplayCli(
  args: readonly string[] = process.argv.slice(2),
  options: DlqReplayCliOptions = {},
): Promise<void> {
  let parsed: { topic: string; dryRun: boolean; group: string | undefined } | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        group: { type: 'string' },
      },
    });
    const [topic, ...rest] = positionals;
    if (topic !== undefined && rest.length === 0 && isEventTopic(topic)) {
      parsed = { topic, dryRun: values['dry-run'], group: values.group };
    }
  } catch {
    // An unknown flag or a missing option value: the usage below says what is accepted.
  }
  if (parsed === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  let logger = createLogger(false);
  try {
    if (observabilityConfig.parse().logPretty) logger = createLogger(true);
    const clientConfig = createKafkaClientConfig(kafkaConfig.parse(), 'dlq-replay');
    const kafka = (options.createKafka ?? ((config: KafkaConfig) => new Kafka(config)))(
      clientConfig,
    );
    const result = await replayDeadLetters(kafka, {
      topic: parsed.topic,
      dryRun: parsed.dryRun,
      logger,
      ...(parsed.group === undefined ? {} : { groupId: parsed.group }),
    });
    process.exitCode = result.skipped > 0 ? 1 : 0;
  } catch (error) {
    // The Error itself: ConsoleLogger in JSON mode serialises it with its message and stack.
    logger.error(error instanceof Error ? error : String(error));
    process.exitCode = 1;
  }
}

function createLogger(pretty: boolean): ConsoleLogger {
  return new ConsoleLogger(
    'DeadLetterReplay',
    pretty ? { colors: true } : { json: true, colors: false },
  );
}
