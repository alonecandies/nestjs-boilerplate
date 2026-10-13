import { parseEventEnvelope, topicVersion } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATION_TYPES,
  type NotificationCreatedPayload,
} from '../index.js';

const payload: NotificationCreatedPayload = {
  notificationId: '0199a1b2-c3d4-7e5f-8a9b-000000000003',
  userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  type: 'payment_receipt',
  title: 'Receipt',
  body: 'Thanks!',
  data: { paymentId: '0199a1b2-c3d4-7e5f-8a9b-000000000002' },
  createdAt: '2026-09-29T10:00:00.000Z',
};

const envelope = (value: unknown) => ({
  id: '0199a1b2-c3d4-7e5f-8a9b-000000000001',
  type: NOTIFICATION_CREATED_EVENT.topic,
  version: 1,
  occurredAt: '2026-09-29T10:00:00.123Z',
  source: 'notifications-service',
  payload: value,
});

/** The issue paths of the `ZodError` that `parseEventEnvelope` throws for `value` (fails otherwise). */
const rejectedPaths = (value: unknown): PropertyKey[][] => {
  try {
    parseEventEnvelope(NOTIFICATION_CREATED_EVENT, envelope(value));
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
    return (error as z.ZodError).issues.map((issue) => issue.path);
  }
  throw new Error('expected parseEventEnvelope to throw a ZodError');
};

describe('NOTIFICATION_CREATED_EVENT', () => {
  it('keeps its wire name (consumer offsets and docker/kafka/topics.txt depend on it)', () => {
    expect(NOTIFICATION_CREATED_EVENT.topic).toBe('notifications.notification-created.v1');
    expect(topicVersion(NOTIFICATION_CREATED_EVENT.topic)).toBe(1);
  });

  it('parses every notification type', () => {
    for (const type of NOTIFICATION_TYPES) {
      const parsed = parseEventEnvelope(NOTIFICATION_CREATED_EVENT, envelope({ ...payload, type }));
      expect(parsed.payload.type).toBe(type);
    }
  });

  it('rejects an unknown notification type', () => {
    expect(rejectedPaths({ ...payload, type: 'marketing' })).toEqual([['payload', 'type']]);
  });
});
