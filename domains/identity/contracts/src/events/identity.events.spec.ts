import {
  createEventEnvelope,
  type EventContract,
  parseEventEnvelope,
  topicVersion,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  type MembershipCreatedPayload,
  type MembershipRemovedPayload,
  USER_REGISTERED_EVENT,
  type UserRegisteredPayload,
} from '../index.js';

const USER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TENANT_ID = '0199a1b2-c3d4-7e5f-8a9b-00000000000a';

const payload: UserRegisteredPayload = {
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  registeredAt: '2026-09-29T10:00:00.000Z',
};
const created: MembershipCreatedPayload = {
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  createdAt: '2026-09-29T10:00:00.000Z',
};
const removed: MembershipRemovedPayload = {
  userId: USER_ID,
  removedAt: '2026-09-29T10:00:00.000Z',
};

const envelope = (contract: EventContract<unknown>, value: unknown) => ({
  id: '0199a1b2-c3d4-7e5f-8a9b-000000000001',
  type: contract.topic,
  version: 1,
  occurredAt: '2026-09-29T10:00:00.123Z',
  source: 'identity-service',
  tenantId: TENANT_ID,
  payload: value,
});

/** The issue paths of the `ZodError` that `parseEventEnvelope` throws for `value` (fails otherwise). */
const rejectedPaths = (contract: EventContract<unknown>, value: unknown): PropertyKey[][] => {
  try {
    parseEventEnvelope(contract, envelope(contract, value));
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
    return (error as z.ZodError).issues.map((issue) => issue.path);
  }
  throw new Error('expected parseEventEnvelope to throw a ZodError');
};

const CASES: { contract: EventContract<unknown>; topic: string; valid: object }[] = [
  { contract: USER_REGISTERED_EVENT, topic: 'identity.user-registered.v1', valid: payload },
  { contract: MEMBERSHIP_CREATED_EVENT, topic: 'identity.membership-created.v1', valid: created },
  { contract: MEMBERSHIP_REMOVED_EVENT, topic: 'identity.membership-removed.v1', valid: removed },
];

describe.each(CASES)('$topic', ({ contract, topic, valid }) => {
  it('keeps its wire name (consumer offsets and docker/kafka/topics.txt depend on it)', () => {
    expect(contract.topic).toBe(topic);
    expect(topicVersion(contract.topic)).toBe(1);
  });

  it('is tenant-scoped: a producer without a tenantId is refused', () => {
    expect(contract.tenantScoped).toBe(true);
    const meta = { id: '0199a1b2-c3d4-7e5f-8a9b-000000000001', source: 'identity-service' };
    expect(() => createEventEnvelope(contract, valid, meta)).toThrow(z.ZodError);
    expect(createEventEnvelope(contract, valid, { ...meta, tenantId: TENANT_ID })).toMatchObject({
      tenantId: TENANT_ID,
      payload: valid,
    });
  });

  it('parses a valid payload', () => {
    expect(parseEventEnvelope(contract, envelope(contract, valid)).payload).toEqual(valid);
  });

  it('rejects a userId that is not a uuid', () => {
    expect(rejectedPaths(contract, { ...valid, userId: 'u1' })).toEqual([['payload', 'userId']]);
  });
});

describe('payloads that carry an email', () => {
  it.each([
    [USER_REGISTERED_EVENT, payload],
    [MEMBERSHIP_CREATED_EVENT, created],
  ] as const)('%# rejects a malformed email', (contract, valid) => {
    expect(rejectedPaths(contract, { ...valid, email: 'nope' })).toEqual([['payload', 'email']]);
  });
});
