/**
 * Kafka topics carrying integration events are named `<context>.<event-name>.v<major>` (major ≥ 1,
 * no leading zero: `.v0` and `.v01` are rejected when the contract is defined). A breaking payload
 * change ships as a NEW topic (`.v2`) consumed side by side; additive changes stay on the same
 * topic because payload schemas are tolerant readers (unknown keys are stripped, not rejected).
 */
export const EVENT_TOPIC_PATTERN = /^[a-z]+\.[a-z]+(?:-[a-z]+)*\.v[1-9]\d*$/;

/** Narrows an untrusted value (a CLI argument, `KafkaContext.getTopic()`) to a topic name. */
export function isEventTopic(value: unknown): value is string {
  return typeof value === 'string' && EVENT_TOPIC_PATTERN.test(value);
}

/** Dead-letter twin of a topic: poison messages land there instead of blocking the partition. */
export type DeadLetterTopic<T extends string = string> = `${T}.dlq`;

/** `orders.order-placed.v1` -> `orders.order-placed.v1.dlq`. */
export const deadLetterTopic = <T extends string>(topic: T): DeadLetterTopic<T> => `${topic}.dlq`;

/**
 * Major schema version encoded in the topic name (`….v1` -> 1); producers stamp it on the
 * envelope so consumers can assert what they parse.
 */
export function topicVersion(topic: string): number {
  const match = /\.v(\d+)$/.exec(topic);
  if (!match?.[1]) {
    throw new Error(`Kafka topic "${topic}" has no ".v<major>" suffix`);
  }
  return Number(match[1]);
}
