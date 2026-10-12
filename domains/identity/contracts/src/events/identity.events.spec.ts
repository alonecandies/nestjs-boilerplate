import { parseEventEnvelope, topicVersion } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { USER_REGISTERED_EVENT, type UserRegisteredPayload } from '../index.js';

const payload: UserRegisteredPayload = {
  userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  email: 'ada@example.com',
  displayName: 'Ada',
  registeredAt: '2026-09-29T10:00:00.000Z',
};

const envelope = (value: unknown) => ({
  id: '0199a1b2-c3d4-7e5f-8a9b-000000000001',
  type: USER_REGISTERED_EVENT.topic,
  version: 1,
  occurredAt: '2026-09-29T10:00:00.123Z',
  source: 'identity-service',
  payload: value,
});

describe('USER_REGISTERED_EVENT', () => {
  it('keeps its wire name (consumer offsets and docker/kafka/topics.txt depend on it)', () => {
    expect(USER_REGISTERED_EVENT.topic).toBe('identity.user-registered.v1');
    expect(topicVersion(USER_REGISTERED_EVENT.topic)).toBe(1);
  });

  it('parses a valid payload', () => {
    expect(parseEventEnvelope(USER_REGISTERED_EVENT, envelope(payload)).payload).toEqual(payload);
  });

  it('rejects a payload that is not an email or not a uuid', () => {
    expect(() =>
      parseEventEnvelope(USER_REGISTERED_EVENT, envelope({ ...payload, email: 'nope' })),
    ).toThrow();
    expect(() =>
      parseEventEnvelope(USER_REGISTERED_EVENT, envelope({ ...payload, userId: 'u1' })),
    ).toThrow();
  });
});
