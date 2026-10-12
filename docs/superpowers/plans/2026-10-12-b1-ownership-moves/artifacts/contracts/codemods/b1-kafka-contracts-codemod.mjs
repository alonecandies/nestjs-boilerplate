// One-off codemod (B1, Task contracts-2): KAFKA_TOPICS.<X> -> the <X>_EVENT contract objects.
//   node kafka-contracts-codemod.mjs <file>...
// - contract positions (published/envelopes/publish/createEventEnvelope/parseEventEnvelope/
//   KafkaEventPattern/ParseEventEnvelopePipe arguments) get the contract itself;
// - EventEnvelopeFor<typeof KAFKA_TOPICS.X> becomes EventEnvelopeOf<typeof X_EVENT>;
// - every other use is a topic string and becomes X_EVENT.topic;
// - the `KAFKA_TOPICS` import specifier is replaced by the contracts the file now uses.
import { readFileSync, writeFileSync } from 'node:fs';

const CONTRACTS = {
  USER_REGISTERED: 'USER_REGISTERED_EVENT',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED_EVENT',
  NOTIFICATION_CREATED: 'NOTIFICATION_CREATED_EVENT',
};
const contractOf = (key) => {
  const name = CONTRACTS[key];
  if (name === undefined) throw new Error(`unknown KAFKA_TOPICS.${key}`);
  return name;
};
const CONTRACT_ARGUMENT =
  /(\.published\(|\.envelopes\(|\.publish\(\s*|createEventEnvelope\(\s*|parseEventEnvelope\(\s*|KafkaEventPattern\(|ParseEventEnvelopePipe\()KAFKA_TOPICS\.(\w+)/g;

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  const used = new Set();
  const track = (key) => {
    const name = contractOf(key);
    used.add(name);
    return name;
  };
  let output = source
    .replace(
      /EventEnvelopeFor<typeof KAFKA_TOPICS\.(\w+)>/g,
      (_m, key) => `EventEnvelopeOf<typeof ${track(key)}>`,
    )
    .replace(CONTRACT_ARGUMENT, (_m, call, key) => `${call}${track(key)}`)
    .replace(/KAFKA_TOPICS\.(\w+)/g, (_m, key) => `${track(key)}.topic`)
    .replace(/\bEventEnvelopeFor\b/g, 'EventEnvelopeOf');
  output = output.replace(/\bKAFKA_TOPICS\b(,?)/, (_m, comma) => `${[...used].join(', ')}${comma}`);
  if (/\bKAFKA_TOPICS\b/.test(output)) throw new Error(`${file}: KAFKA_TOPICS left over`);
  if (output !== source) {
    writeFileSync(file, output);
    console.info(`rewrote ${file}`);
  }
}
