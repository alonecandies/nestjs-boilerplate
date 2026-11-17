import { createPrincipal, generateId, type Principal, runWithPrincipal } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { requireInboxActor } from './inbox-actor.js';

describe('requireInboxActor', () => {
  const [tenantA, tenantB, userU, userV] = [generateId(), generateId(), generateId(), generateId()];
  const as = <T>(principal: Principal, fn: () => T): T => runWithPrincipal(principal, fn);
  const member = (tenantId: string | null, userId = userU): Principal =>
    createPrincipal({ userId, tenantId, roles: tenantId === null ? [] : ['member'] });

  it('returns the principal acting as exactly this tenant and this user', () => {
    const principal = member(tenantA);
    expect(as(principal, () => requireInboxActor(tenantA, userU))).toBe(principal);
  });

  it('403 TENANT_MISMATCH for another tenant, another user and a tenant-less principal', () => {
    const mismatch = expect.objectContaining({ code: 'TENANT_MISMATCH', httpStatus: 403 });
    expect(() => as(member(tenantA), () => requireInboxActor(tenantB, userU))).toThrow(mismatch);
    expect(() => as(member(tenantA), () => requireInboxActor(tenantA, userV))).toThrow(mismatch);
    expect(() => as(member(null), () => requireInboxActor(tenantA, userU))).toThrow(mismatch);
  });

  it('401 PRINCIPAL_MISSING without a principal', () => {
    expect(() => requireInboxActor(tenantA, userU)).toThrow(
      expect.objectContaining({ code: 'PRINCIPAL_MISSING', httpStatus: 401 }),
    );
  });

  it('a staff switch-in principal passes only for its own (tenant, user) pair', () => {
    const staff = createPrincipal({ userId: userU, tenantId: tenantA, staff: true });
    expect(as(staff, () => requireInboxActor(tenantA, userU))).toBe(staff);
    const mismatch = expect.objectContaining({ code: 'TENANT_MISMATCH' });
    expect(() => as(staff, () => requireInboxActor(tenantB, userU))).toThrow(mismatch);
    expect(() => as(staff, () => requireInboxActor(tenantA, userV))).toThrow(mismatch);
  });
});
