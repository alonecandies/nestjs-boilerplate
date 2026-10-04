import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEAD_LETTER_TOPIC_VALUES,
  type DeadLetterTopic,
  deadLetterTopic,
  isKafkaTopic,
  KAFKA_TOPIC_VALUES,
  KAFKA_TOPICS,
  topicVersion,
} from './topics.js';

describe('KAFKA_TOPICS', () => {
  it('follows <context>.<kebab-event>.v<major>', () => {
    for (const topic of KAFKA_TOPIC_VALUES) {
      expect(topic).toMatch(/^[a-z]+\.[a-z]+(?:-[a-z]+)*\.v\d+$/);
    }
    expect(new Set(KAFKA_TOPIC_VALUES).size).toBe(KAFKA_TOPIC_VALUES.length);
    expect(Object.isFrozen(KAFKA_TOPIC_VALUES)).toBe(true);
  });

  it('narrows topic names', () => {
    expect(isKafkaTopic('identity.user-registered.v1')).toBe(true);
    expect(isKafkaTopic('identity.user-registered.v1.dlq')).toBe(false);
    expect(isKafkaTopic(undefined)).toBe(false);
  });
});

describe('deadLetterTopic', () => {
  it('appends .dlq with a literal type', () => {
    const dlq = deadLetterTopic(KAFKA_TOPICS.PAYMENT_SUCCEEDED);
    expect(dlq).toBe('billing.payment-succeeded.v1.dlq');
    expectTypeOf(dlq).toEqualTypeOf<'billing.payment-succeeded.v1.dlq'>();
    expectTypeOf(dlq).toExtend<DeadLetterTopic>();
  });

  it('lists one dead-letter topic per topic', () => {
    expect(DEAD_LETTER_TOPIC_VALUES).toEqual(KAFKA_TOPIC_VALUES.map((topic) => `${topic}.dlq`));
  });
});

describe('topicVersion', () => {
  it('reads the major version from the topic suffix', () => {
    expect(topicVersion(KAFKA_TOPICS.USER_REGISTERED)).toBe(1);
  });
});
