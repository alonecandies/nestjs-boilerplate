import { USER_REGISTERED_EVENT } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRegisteredEvent } from '../../domain/events/user-registered.event.js';
import { UserRegisteredRelay } from './user-registered.relay.js';

describe('UserRegisteredRelay', () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const workspaceId = generateId();
  const event = new UserRegisteredEvent(
    generateId(),
    generateId(),
    'ada@example.com',
    'Ada',
    occurredAt,
    workspaceId,
  );
  let kafka: FakeKafkaProducer;
  let relay: UserRegisteredRelay;

  beforeEach(() => {
    // The process ClsService: the producer would fill tenantId/actorId from an active principal.
    kafka = new FakeKafkaProducer(
      { source: 'identity-service' },
      ClsServiceManager.getClsService(),
    );
    relay = new UserRegisteredRelay(kafka);
  });

  it('publishes identity.user-registered.v1 keyed by user id, envelope id = domain event id', async () => {
    await relay.handle(event);

    const [record] = kafka.published(USER_REGISTERED_EVENT);
    expect(record?.key).toBe(event.userId);
    expect(record?.value).toMatchObject({
      id: event.eventId,
      type: USER_REGISTERED_EVENT.topic,
      version: 1,
      source: 'identity-service',
      occurredAt: occurredAt.toISOString(),
      tenantId: workspaceId,
      actorId: event.userId,
      payload: {
        userId: event.userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: occurredAt.toISOString(),
      },
    });
  });

  it('an active principal of another tenant does not change the envelope tenant or actor', async () => {
    const other = createPrincipal({
      userId: generateId(),
      tenantId: generateId(),
      roles: ['owner'],
    });

    await runWithPrincipal(other, () => relay.handle(event));

    const [envelope] = kafka.envelopes(USER_REGISTERED_EVENT);
    expect(envelope).toMatchObject({ tenantId: workspaceId, actorId: event.userId });
  });

  it('logs a broker failure instead of throwing into the event bus', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    kafka.failNextWith(new Error('broker down'));

    await expect(relay.handle(event)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: event.userId, eventId: event.eventId }),
      expect.stringContaining(USER_REGISTERED_EVENT.topic),
    );
    expect(kafka.records).toEqual([]);
  });
});
