import { generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { toActiveTenantModel, toMemberModel, toMyTenantModel } from './tenancy.mapper.js';

describe('tenancy GraphQL mapper', () => {
  const tenant = {
    id: generateId(),
    slug: 'acme-1234abcd',
    name: 'Acme',
    personal: false,
    createdAt: new Date(0),
  };

  it('maps MyTenant with canonical roles and a null lastActiveAt', () => {
    expect(toMyTenantModel({ tenant, roles: ['member', 'owner', 'root'] })).toEqual({
      tenant: { id: tenant.id, slug: tenant.slug, name: 'Acme', personal: false },
      roles: ['owner', 'member'],
      lastActiveAt: null,
    });
  });

  it('active tenant: the matching membership (its roles win over the token), or no tenant for staff', () => {
    const user = { tenantId: tenant.id, roles: ['admin' as const], staff: false };
    expect(toActiveTenantModel(user, [{ tenant, roles: ['member'] }])).toMatchObject({
      tenantId: tenant.id,
      tenant: { name: 'Acme' },
      roles: ['member'],
      staff: false,
    });
    expect(toActiveTenantModel({ ...user, staff: true }, [])).toEqual({
      tenantId: tenant.id,
      tenant: null,
      roles: ['admin'],
      staff: true,
    });
  });

  it('maps a member', () => {
    const joinedAt = new Date(1_000);
    expect(
      toMemberModel({ userId: 'u', email: 'a@b.io', displayName: 'A', roles: ['admin'], joinedAt }),
    ).toEqual({
      userId: 'u',
      email: 'a@b.io',
      displayName: 'A',
      roles: ['admin'],
      joinedAt,
    });
  });

  it('maps a withheld member (ARCH-4: "" and [] on the wire) to null email and roles', () => {
    const joinedAt = new Date(1_000);
    expect(
      toMemberModel({ userId: 'u', email: '', displayName: 'A', roles: [], joinedAt }),
    ).toEqual({ userId: 'u', email: null, displayName: 'A', roles: null, joinedAt });
  });

  it('mixed versions: a complete member from an old identity-service passes through unchanged', () => {
    const member = { userId: 'u', email: 'a@b.io', displayName: 'A', roles: ['owner'] };
    expect(toMemberModel(member)).toMatchObject({ email: 'a@b.io', roles: ['owner'] });
  });
});
