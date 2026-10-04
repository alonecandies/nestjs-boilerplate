/**
 * Kafka topics carrying integration events: `<context>.<event-name>.v<major>`. A breaking payload
 * change ships as a NEW topic (`.v2`) consumed side by side; additive changes stay on the same
 * topic because payload schemas are tolerant readers (unknown keys are stripped, not rejected).
 */
export const KAFKA_TOPICS = {
  USER_REGISTERED: 'identity.user-registered.v1',
  PAYMENT_SUCCEEDED: 'billing.payment-succeeded.v1',
  NOTIFICATION_CREATED: 'notifications.notification-created.v1',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

/** Dead-letter topic of a source topic (poison messages land here instead of blocking the partition). */
export type DeadLetterTopic<T extends KafkaTopic = KafkaTopic> = `${T}.dlq`;

/** Every integration-event topic, e.g. for topic provisioning and health checks. */
export const KAFKA_TOPIC_VALUES: readonly KafkaTopic[] = Object.freeze(Object.values(KAFKA_TOPICS));

const TOPIC_SET: ReadonlySet<string> = new Set(KAFKA_TOPIC_VALUES);

/** Narrows an untrusted topic name (e.g. `KafkaContext.getTopic()`) to a known topic. */
export function isKafkaTopic(value: unknown): value is KafkaTopic {
  return typeof value === 'string' && TOPIC_SET.has(value);
}

/** `identity.user-registered.v1` -> `identity.user-registered.v1.dlq`. */
export const deadLetterTopic = <T extends KafkaTopic>(topic: T): DeadLetterTopic<T> =>
  `${topic}.dlq`;

/** Every dead-letter topic; they must exist too when broker auto-creation is off. */
export const DEAD_LETTER_TOPIC_VALUES: readonly DeadLetterTopic[] = Object.freeze(
  KAFKA_TOPIC_VALUES.map((topic) => deadLetterTopic(topic)),
);

/**
 * Major schema version encoded in the topic name (`….v1` -> 1); producers stamp it on the
 * envelope so consumers can assert what they parse.
 */
export function topicVersion(topic: KafkaTopic): number {
  const match = /\.v(\d+)$/.exec(topic);
  if (!match?.[1]) {
    throw new Error(`Kafka topic "${topic}" has no ".v<major>" suffix`);
  }
  return Number(match[1]);
}
