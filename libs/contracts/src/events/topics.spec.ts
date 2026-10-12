import { describe, expect, expectTypeOf, it } from 'vitest';
import { type DeadLetterTopic, deadLetterTopic, isEventTopic, topicVersion } from './topics.js';

describe('isEventTopic', () => {
  it.each(['orders.order-placed.v1', 'orders.placed.v12'])('accepts %s', (topic) => {
    expect(isEventTopic(topic)).toBe(true);
  });

  it.each([
    'orders.order-placed',
    'orders.order-placed.v1.dlq',
    'Orders.order-placed.v1',
    'orders.order_placed.v1',
    undefined,
    42,
  ])('rejects %s', (value) => {
    expect(isEventTopic(value)).toBe(false);
  });
});

describe('deadLetterTopic', () => {
  it('appends .dlq with a literal type', () => {
    const dlq = deadLetterTopic('orders.order-placed.v1');
    expect(dlq).toBe('orders.order-placed.v1.dlq');
    expectTypeOf(dlq).toEqualTypeOf<'orders.order-placed.v1.dlq'>();
    expectTypeOf(dlq).toExtend<DeadLetterTopic>();
  });
});

describe('topicVersion', () => {
  it('reads the major version from the topic suffix', () => {
    expect(topicVersion('orders.order-placed.v1')).toBe(1);
    expect(topicVersion('orders.order-placed.v12')).toBe(12);
  });

  it('throws for a topic without a version suffix', () => {
    expect(() => topicVersion('orders.order-placed')).toThrow(/no "\.v<major>" suffix/);
  });
});
