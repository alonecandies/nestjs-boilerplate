import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import { actorTenantRoles, requireSelf, requireTenantActor } from './tenant-actor.js';

describe('tenant actor', () => {
  const userId = generateId();
  const tenantId = generateId();
  const as = <T>(roles: ('owner' | 'admin' | 'member')[], staff: boolean, fn: () => T) =>
    runWithPrincipal(createPrincipal({ userId, tenantId, roles, staff }), fn);

  it('requireTenantActor returns the principal acting in the tenant as the actor', () => {
    expect(as(['member'], false, () => requireTenantActor(tenantId, userId))).toMatchObject({
      userId,
      tenantId,
    });
  });

  it.each([
    ['another tenant', () => requireTenantActor(generateId(), userId)],
    ['another actor', () => requireTenantActor(tenantId, generateId())],
  ])('403 TENANT_ACCESS_DENIED for %s', (_label, call) => {
    expect(() => as(['owner'], false, call)).toThrow(
      expect.objectContaining({ code: 'TENANT_ACCESS_DENIED' }),
    );
  });

  it('requireSelf accepts only the principal itself; 401 without one', () => {
    expect(as(['member'], false, () => requireSelf(userId))).toMatchObject({ userId });
    expect(() => as(['owner'], false, () => requireSelf(generateId()))).toThrow(
      expect.objectContaining({ code: 'TENANT_ACCESS_DENIED' }),
    );
    expect(() => requireSelf(userId)).toThrow(
      expect.objectContaining({ code: 'PRINCIPAL_MISSING' }),
    );
  });

  it('actorTenantRoles reads the membership, not the (possibly stale) token roles', async () => {
    const { memberships } = createInMemoryIdentityPersistence();
    await memberships.insert({ tenantId, userId, roles: ['member'], lastActiveAt: null });
    const principal = createPrincipal({ userId, tenantId, roles: ['owner'] });
    await expect(actorTenantRoles(principal, memberships)).resolves.toEqual(['member']);
  });

  it('actorTenantRoles uses the token roles for staff (no membership) and 403s a non-member', async () => {
    const { memberships } = createInMemoryIdentityPersistence();
    const staff = createPrincipal({ userId, tenantId, roles: ['admin'], staff: true });
    await expect(actorTenantRoles(staff, memberships)).resolves.toEqual(['admin']);
    const stranger = createPrincipal({ userId, tenantId, roles: ['owner'] });
    await expect(actorTenantRoles(stranger, memberships)).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
    });
  });
});
