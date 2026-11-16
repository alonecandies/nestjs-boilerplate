import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { PLATFORM_OWNER, stripeOwnerOf } from './stripe-owner.js';

describe('stripeOwnerOf', () => {
  const tenantId = generateId();
  const userId = generateId();

  it('reads the tenant and user we signed into the object metadata', () => {
    expect(stripeOwnerOf({ metadata: { tenantId, userId, paymentId: generateId() } })).toEqual({
      tenantId,
      userId,
    });
  });

  it('keeps the tenant and drops a user that is not a UUID', () => {
    expect(stripeOwnerOf({ metadata: { tenantId, userId: 'usr_1' } })).toEqual({
      tenantId,
      userId: null,
    });
  });

  it.each([
    ['the nil UUID', PLATFORM_TENANT_ID],
    ['the nil UUID in upper case', PLATFORM_TENANT_ID.toUpperCase()],
  ])('keeps the tenant and treats %s as no user (createPrincipal rejects it)', (_label, nil) => {
    expect(stripeOwnerOf({ metadata: { tenantId, userId: nil } })).toEqual({
      tenantId,
      userId: null,
    });
  });

  it.each([
    ['no metadata (payout.paid)', { object: 'payout' }],
    ['empty metadata (a session created before B2)', { metadata: {} }],
    ['a tenant that is not a UUID', { metadata: { tenantId: 'acme', userId } }],
    ['the nil UUID', { metadata: { tenantId: PLATFORM_TENANT_ID, userId } }],
    ['null', null],
  ])('falls back to the platform owner for %s', (_label, object) => {
    expect(stripeOwnerOf(object)).toBe(PLATFORM_OWNER);
    expect(PLATFORM_OWNER).toEqual({ tenantId: PLATFORM_TENANT_ID, userId: null });
  });
});
