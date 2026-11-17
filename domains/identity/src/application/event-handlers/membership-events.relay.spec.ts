import { MEMBERSHIP_CREATED_EVENT, MEMBERSHIP_REMOVED_EVENT } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCreatedEvent } from '../../domain/events/membership-created.event.js';
import { MembershipRemovedEvent } from '../../domain/events/membership-removed.event.js';
import { MembershipEventsRelay } from './membership-events.relay.js';

describe('MembershipEventsRelay', () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const tenantId = generateId();
  const userId = generateId();
  const actorId = generateId();
  const created = new MembershipCreatedEvent({
    tenantId,
    userId,
    email: 'bob@example.com',
    displayName: 'Bob',
    actorId: userId,
    occurredAt,
  });
  const removed = new MembershipRemovedEvent({ tenantId, userId, actorId, occurredAt });
  let kafka: FakeKafkaProducer;
  let relay: MembershipEventsRelay;

  beforeEach(() => {
    // The process ClsService: the producer would fill tenantId/actorId from an active principal.
    kafka = new FakeKafkaProducer(
      { source: 'identity-service' },
      ClsServiceManager.getClsService(),
    );
    relay = new MembershipEventsRelay(kafka);
  });

  it('gives each domain event its own uuid id', () => {
    expect(created.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(removed.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.eventId).not.toBe(removed.eventId);
  });

  it('publishes identity.membership-created.v1: tenant, key = user id, id = domain event id', async () => {
    await relay.handle(created);

    const [record] = kafka.published(MEMBERSHIP_CREATED_EVENT);
    expect(kafka.records).toHaveLength(1);
    expect(record?.key).toBe(userId);
    expect(record?.value).toMatchObject({
      id: created.eventId,
      type: MEMBERSHIP_CREATED_EVENT.topic,
      source: 'identity-service',
      occurredAt: occurredAt.toISOString(),
      tenantId,
      actorId: userId,
      payload: {
        userId,
        email: 'bob@example.com',
        displayName: 'Bob',
        createdAt: occurredAt.toISOString(),
      },
    });
  });

  it('publishes identity.membership-removed.v1: tenant, key = user id, id = domain event id', async () => {
    await relay.handle(removed);

    const [record] = kafka.published(MEMBERSHIP_REMOVED_EVENT);
    expect(kafka.records).toHaveLength(1);
    expect(record?.key).toBe(userId);
    expect(record?.value).toMatchObject({
      id: removed.eventId,
      type: MEMBERSHIP_REMOVED_EVENT.topic,
      occurredAt: occurredAt.toISOString(),
      tenantId,
      actorId,
      payload: { userId, removedAt: occurredAt.toISOString() },
    });
  });

  it('a null actor stays null (system work), not the CLS principal', async () => {
    const system = new MembershipRemovedEvent({ tenantId, userId, actorId: null, occurredAt });
    const other = createPrincipal({
      userId: generateId(),
      tenantId: generateId(),
      roles: ['owner'],
    });

    await runWithPrincipal(other, () => relay.handle(system));

    expect(kafka.envelopes(MEMBERSHIP_REMOVED_EVENT)[0]).toMatchObject({ tenantId, actorId: null });
  });

  it('an active principal of another tenant does not change the envelope tenant or actor', async () => {
    const other = createPrincipal({
      userId: generateId(),
      tenantId: generateId(),
      roles: ['owner'],
    });

    await runWithPrincipal(other, async () => {
      await relay.handle(created);
      await relay.handle(removed);
    });

    expect(kafka.envelopes(MEMBERSHIP_CREATED_EVENT)[0]).toMatchObject({
      tenantId,
      actorId: userId,
    });
    expect(kafka.envelopes(MEMBERSHIP_REMOVED_EVENT)[0]).toMatchObject({ tenantId, actorId });
  });

  it.each([
    ['created', created, MEMBERSHIP_CREATED_EVENT.topic],
    ['removed', removed, MEMBERSHIP_REMOVED_EVENT.topic],
  ] as const)(
    'logs a broker failure (%s) instead of throwing into the event bus',
    async (_name, event, topic) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      kafka.failNextWith(new Error('broker down'));

      await expect(relay.handle(event)).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, userId, eventId: event.eventId }),
        expect.stringContaining(topic),
      );
      expect(kafka.records).toEqual([]);
    },
  );
});
