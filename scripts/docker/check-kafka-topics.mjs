// Fails when docker/kafka/topics.txt drifts from the Kafka contracts: it must provision exactly the
// topic of every exported event contract (`<EVENT>_EVENT`) plus its `.dlq` twin (broker
// auto-creation is off, so a missing topic makes consumers fail at boot). Needs the built
// contracts (`bun run build`):
//   node scripts/docker/check-kafka-topics.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contracts from '@platform/contracts';

const { deadLetterTopic, isEventContract } = contracts;
const topics = Object.values(contracts)
  .filter(isEventContract)
  .map((contract) => contract.topic);

const file = join(import.meta.dirname, '..', '..', 'docker', 'kafka', 'topics.txt');
const provisioned = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean)
  .map((line) => line.split(':')[0]);

const expected = [...topics, ...topics.map((topic) => deadLetterTopic(topic))];
const missing = expected.filter((topic) => !provisioned.includes(topic));
const extra = provisioned.filter((topic) => !expected.includes(topic));
const duplicated = provisioned.filter((topic, i) => provisioned.indexOf(topic) !== i);

for (const topic of missing) console.error(`topics.txt is missing ${topic}`);
for (const topic of extra)
  console.error(`topics.txt provisions ${topic}, which no event contract uses`);
for (const topic of duplicated) console.error(`topics.txt lists ${topic} twice`);
if (missing.length + extra.length + duplicated.length > 0) process.exit(1);
console.info(`docker/kafka/topics.txt provisions all ${expected.length} contract topics`);
