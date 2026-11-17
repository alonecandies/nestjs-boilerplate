import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import { createPrincipal, generateId, type Principal, runWithPrincipal } from '@platform/common';
import { parseEventEnvelope } from '@platform/contracts';
import { InMemoryOutbox } from '@platform/outbox/testing';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MembershipCreatedEvent } from '../../domain/events/membership-created.event.js';
import { MembershipRemovedEvent } from '../../domain/events/membership-removed.event.js';
import { UserRegisteredEvent } from '../../domain/events/user-registered.event.js';
import { IDENTITY_OUTBOX } from '../../infrastructure/persistence/identity-outbox.js';
import { IdentityIntegrationEvents } from './identity-integration-events.service.js';

describe('IdentityIntegrationEvents (domain event → identity outbox record)', () => {
  const occurredAt = new Date('2026-09-29T12:00:00.000Z');
  const tenantId = generateId();
  const userId = generateId();
  const actorId = generateId();
  const registered = new UserRegisteredEvent(
    generateId(),
    userId,
    'ada@example.com',
    'Ada',
    occurredAt,
    tenantId,
  );
  const created = new MembershipCreatedEvent({
    tenantId,
    userId,
    email: 'ada@example.com',
    displayName: 'Ada',
    actorId: userId,
    occurredAt,
  });
  const removed = new MembershipRemovedEvent({ tenantId, userId, actorId, occurredAt });
  /** The unit of work's principal: some user acting in the event's tenant. */
  const inTenant = (user = actorId): Principal =>
    createPrincipal({ userId: user, tenantId, roles: ['owner'] });

  let kafka: FakeKafkaProducer;
  let outbox: InMemoryOutbox;
  let events: IdentityIntegrationEvents;

  beforeEach(() => {
    kafka = new FakeKafkaProducer({ source: 'identity-service' });
    outbox = new InMemoryOutbox(IDENTITY_OUTBOX, { kafka });
    events = new IdentityIntegrationEvents(outbox);
  });

  it('enqueues identity.user-registered.v1: key = user id, id and occurredAt = the domain event, tenant = the workspace, actor = the user', async () => {
    await runWithPrincipal(inTenant(userId), () => events.userRegistered(registered));

    expect(outbox.records).toHaveLength(1);
    const [row] = outbox.records;
    expect(row).toMatchObject({
      tenantId,
      id: registered.eventId,
      topic: USER_REGISTERED_EVENT.topic,
      key: userId,
      publishedAt: null,
    });
    expect(row?.envelope).toMatchObject({
      id: registered.eventId,
      type: USER_REGISTERED_EVENT.topic,
      version: 1,
      source: 'identity-service',
      occurredAt: occurredAt.toISOString(),
      tenantId,
      actorId: userId,
      payload: {
        userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: occurredAt.toISOString(),
      },
    });
    expect(parseEventEnvelope(USER_REGISTERED_EVENT, row?.envelope)).toEqual(row?.envelope);
    // Nothing goes to Kafka from the request path: the relay publishes the row later.
    expect(kafka.records).toEqual([]);
  });

  it('enqueues identity.membership-created.v1 with the membership tenant and the actor', async () => {
    await runWithPrincipal(inTenant(userId), () => events.membershipCreated(created));

    const [row] = outbox.records;
    expect(row).toMatchObject({
      tenantId,
      id: created.eventId,
      topic: MEMBERSHIP_CREATED_EVENT.topic,
      key: userId,
    });
    expect(row?.envelope).toMatchObject({
      id: created.eventId,
      occurredAt: occurredAt.toISOString(),
      tenantId,
      actorId: userId,
      payload: {
        userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        createdAt: occurredAt.toISOString(),
      },
    });
    expect(kafka.records).toEqual([]);
  });

  it('enqueues identity.membership-removed.v1 with the remover as actor', async () => {
    await runWithPrincipal(inTenant(), () => events.membershipRemoved(removed));

    const [row] = outbox.records;
    expect(row).toMatchObject({
      tenantId,
      id: removed.eventId,
      topic: MEMBERSHIP_REMOVED_EVENT.topic,
      key: userId,
    });
    expect(row?.envelope).toMatchObject({
      id: removed.eventId,
      occurredAt: occurredAt.toISOString(),
      tenantId,
      actorId,
      payload: { userId, removedAt: occurredAt.toISOString() },
    });
  });

  it('a null actor stays null, not the principal', async () => {
    const system = new MembershipRemovedEvent({ tenantId, userId, actorId: null, occurredAt });
    await runWithPrincipal(inTenant(), () => events.membershipRemoved(system));
    expect(outbox.records[0]?.envelope).toMatchObject({ tenantId, actorId: null });
  });

  it("refuses an event of another tenant than the unit of work's principal (no row)", async () => {
    const elsewhere = createPrincipal({ userId, tenantId: generateId(), roles: ['owner'] });
    for (const enqueue of [
      () => events.userRegistered(registered),
      () => events.membershipCreated(created),
      () => events.membershipRemoved(removed),
    ]) {
      await expect(runWithPrincipal(elsewhere, enqueue)).rejects.toMatchObject({
        code: 'OUTBOX_TENANT_MISMATCH',
      });
    }
    expect(outbox.records).toEqual([]);
  });

  it('the same domain event twice fails like the primary key (never deduped)', async () => {
    await runWithPrincipal(inTenant(userId), () => events.userRegistered(registered));
    await expect(
      runWithPrincipal(inTenant(userId), () => events.userRegistered(registered)),
    ).rejects.toMatchObject({ code: '23505' });
    expect(outbox.records).toHaveLength(1);
  });
});
