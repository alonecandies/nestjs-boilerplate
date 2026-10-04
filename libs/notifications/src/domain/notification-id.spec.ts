import { isUuidV7, uuidV7Timestamp } from '@app/common';
import { describe, expect, it } from 'vitest';
import { deriveNotificationId } from './notification-id.js';

const AT = new Date('2026-09-29T08:00:00.000Z');

describe('deriveNotificationId', () => {
  it('is a uuidv7 carrying the fact time (inbox order is preserved)', () => {
    const id = deriveNotificationId('welcome:u1', AT);
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Timestamp(id)).toEqual(AT);
  });

  it('is deterministic per (key, time) — redelivery upserts the same row', () => {
    expect(deriveNotificationId('welcome:u1', AT)).toBe(deriveNotificationId('welcome:u1', AT));
  });

  it('differs for different keys at the same instant', () => {
    expect(deriveNotificationId('welcome:u1', AT)).not.toBe(deriveNotificationId('welcome:u2', AT));
  });

  it('sorts by time like the clustering order expects', () => {
    const earlier = deriveNotificationId('zzz', AT);
    const later = deriveNotificationId('aaa', new Date(AT.getTime() + 1));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});
