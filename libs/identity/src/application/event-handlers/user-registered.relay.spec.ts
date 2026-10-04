import { generateId } from '@app/common';
import { KAFKA_TOPICS } from '@app/contracts';
import { FakeKafkaProducer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRegisteredEvent } from '../../domain/events/user-registered.event.js';
import { UserRegisteredRelay } from './user-registered.relay.js';

describe('UserRegisteredRelay', () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const event = new UserRegisteredEvent(
    generateId(),
    generateId(),
    'ada@example.com',
    'Ada',
    occurredAt,
  );
  let kafka: FakeKafkaProducer;
  let relay: UserRegisteredRelay;

  beforeEach(() => {
    kafka = new FakeKafkaProducer({ source: 'identity-service' });
    relay = new UserRegisteredRelay(kafka);
  });

  it('publishes identity.user-registered.v1 keyed by user id, envelope id = domain event id', async () => {
    await relay.handle(event);

    const [record] = kafka.published(KAFKA_TOPICS.USER_REGISTERED);
    expect(record?.key).toBe(event.userId);
    expect(record?.value).toMatchObject({
      id: event.eventId,
      type: KAFKA_TOPICS.USER_REGISTERED,
      version: 1,
      source: 'identity-service',
      occurredAt: occurredAt.toISOString(),
      payload: {
        userId: event.userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: occurredAt.toISOString(),
      },
    });
  });

  it('logs a broker failure instead of throwing into the event bus', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    kafka.failNextWith(new Error('broker down'));

    await expect(relay.handle(event)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: event.userId, eventId: event.eventId }),
      expect.stringContaining(KAFKA_TOPICS.USER_REGISTERED),
    );
    expect(kafka.records).toEqual([]);
  });
});
