// Replays a dead-letter topic into its source topic once the cause of the failures is fixed:
//   bun run build   # the script runs the compiled packages (dist/), like the production image
//   node --env-file=.env libs/transport/scripts/kafka-dlq-replay.mjs <topic> [--dry-run] [--group <id>]
// <topic> is the SOURCE topic (e.g. identity.user-registered.v1); `<topic>.dlq` is read. Broker
// settings come from the `kafka` config namespace (KAFKA_BROKERS, KAFKA_SSL, KAFKA_SASL_*), exactly
// as the services read them. Progress is committed to the group (default `<topic>.dlq-replay`), so
// running it again only replays what was dead-lettered since. Records keep their key and value
// bytes, so consumers deduplicate on the envelope id as for any redelivery.
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { kafkaConfig } from '@app/config';
import { isKafkaTopic, KAFKA_TOPIC_VALUES } from '@app/contracts';
import { Kafka } from 'kafkajs';
import { createKafkaClientConfig, replayDeadLetters } from '../dist/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    group: { type: 'string' },
  },
});

const [topic] = positionals;
if (!isKafkaTopic(topic)) {
  process.stderr.write(
    `usage: kafka-dlq-replay.mjs <topic> [--dry-run] [--group <id>]\n  <topic>: ${KAFKA_TOPIC_VALUES.join(' | ')}\n`,
  );
  process.exit(2);
}

const kafka = new Kafka(createKafkaClientConfig(kafkaConfig.parse(), 'dlq-replay'));
const result = await replayDeadLetters(kafka, {
  topic,
  dryRun: values['dry-run'],
  ...(values.group === undefined ? {} : { groupId: values.group }),
});
process.exitCode = result.skipped > 0 ? 1 : 0;
