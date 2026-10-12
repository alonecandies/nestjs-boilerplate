// Fails when docker/kafka/topics.txt drifts from the Kafka contracts: it must provision exactly the
// topic of every event contract (`<EVENT>_EVENT`) exported by a domains/<x>/contracts package, plus
// its `.dlq` twin (broker auto-creation is off, so a missing topic makes consumers fail at boot).
// Needs the built contracts packages (`bun run build`):
//   node scripts/docker/check-kafka-topics.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deadLetterTopic, isEventContract } from '@platform/contracts';

const root = join(import.meta.dirname, '..', '..');
const topics = [];
for (const domain of readdirSync(join(root, 'domains'))) {
  const manifest = join(root, 'domains', domain, 'contracts', 'package.json');
  if (!existsSync(manifest)) continue;
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const value of Object.values(await import(name))) {
    if (isEventContract(value)) topics.push(value.topic);
  }
}

const file = join(root, 'docker', 'kafka', 'topics.txt');
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
