import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { ListMyTenantsHandler } from './list-my-tenants.handler.js';
import { ListMyTenantsQuery } from './list-my-tenants.query.js';

describe('ListMyTenantsHandler', () => {
  it("lists the caller's tenants with roles, most recently active first", async () => {
    const persistence = createInMemoryIdentityPersistence();
    const userId = generateId();
    const [a, b] = [generateId(), generateId()];
    await persistence.tenants.insert({
      id: a,
      slug: `a-${a.slice(-8)}`,
      name: 'A',
      personal: true,
    });
    await persistence.tenants.insert({
      id: b,
      slug: `b-${b.slice(-8)}`,
      name: 'B',
      personal: false,
    });
    await persistence.memberships.insert({
      tenantId: a,
      userId,
      roles: ['owner'],
      lastActiveAt: new Date(1_000),
    });
    await persistence.memberships.insert({
      tenantId: b,
      userId,
      roles: ['member'],
      lastActiveAt: new Date(2_000),
    });

    const handler = new ListMyTenantsHandler(persistence.membershipsSystem);
    const as = (principalId: string) =>
      runWithPrincipal(
        createPrincipal({ userId: principalId, tenantId: a, roles: ['owner'] }),
        () => handler.execute(new ListMyTenantsQuery(userId)),
      );

    const list = await as(userId);

    expect(list.items.map((t) => [t.tenant?.name, t.roles])).toEqual([
      ['B', ['member']],
      ['A', ['owner']],
    ]);
    // Another user's tenants are never listed (identity-service trusts no request user id).
    await expect(as(generateId())).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });
});
