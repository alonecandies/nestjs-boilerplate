import { describe, expect, it } from 'vitest';
import {
  InvalidRolesException,
  MembershipAlreadyExistsException,
  TenantSlugTakenException,
} from '../index.js';
import { createInMemoryIdentityPersistence } from './in-memory-identity.js';

const USER = '0190f3b2-0000-7000-8000-000000000001';
const T1 = '0190f3b2-0000-7000-8000-0000000000a1';
const T2 = '0190f3b2-0000-7000-8000-0000000000a2';
const T3 = '0190f3b2-0000-7000-8000-0000000000a3';

describe('in-memory tenancy repositories', () => {
  it('tenants: unique slug, lookups, rename', async () => {
    const { tenants } = createInMemoryIdentityPersistence();
    await tenants.insert({ id: T1, slug: 'acme', name: 'Acme', personal: false });
    await expect(
      tenants.insert({ id: T2, slug: 'acme', name: 'x', personal: false }),
    ).rejects.toBeInstanceOf(TenantSlugTakenException);
    await expect(tenants.findByIds([T1, T2])).resolves.toMatchObject([{ id: T1 }]);
    await expect(tenants.existsBySlug('acme')).resolves.toBe(true);
    await expect(tenants.rename(T1, 'Acme Inc.')).resolves.toBe(true);
    await expect(tenants.rename(T2, 'x')).resolves.toBe(false);
  });

  it('memberships: normalized roles, duplicates refused, most recent first (NULLs last)', async () => {
    const { tenants, memberships } = createInMemoryIdentityPersistence();
    for (const id of [T1, T2, T3])
      await tenants.insert({ id, slug: id, name: id, personal: false });
    await expect(
      memberships.insert({ tenantId: T1, userId: USER, roles: [], lastActiveAt: null }),
    ).rejects.toBeInstanceOf(InvalidRolesException);
    await memberships.insert({
      tenantId: T1,
      userId: USER,
      roles: ['member', 'owner'],
      lastActiveAt: null,
    });
    await memberships.insert({
      tenantId: T2,
      userId: USER,
      roles: ['admin'],
      lastActiveAt: new Date(1_000),
    });
    await memberships.insert({
      tenantId: T3,
      userId: USER,
      roles: ['member'],
      lastActiveAt: new Date(2_000),
    });
    await expect(
      memberships.insert({ tenantId: T1, userId: USER, roles: ['member'], lastActiveAt: null }),
    ).rejects.toBeInstanceOf(MembershipAlreadyExistsException);
    await expect(memberships.find(T1, USER)).resolves.toMatchObject({ roles: ['owner', 'member'] });
    expect((await memberships.listForUser(USER)).map((m) => m.tenant.id)).toEqual([T3, T2, T1]);
    await memberships.touch(T1, USER, new Date(3_000));
    await expect(memberships.findMostRecentForUser(USER)).resolves.toMatchObject({ tenantId: T1 });
  });
});
