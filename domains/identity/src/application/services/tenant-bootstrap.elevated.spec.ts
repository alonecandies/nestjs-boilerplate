import { createPrincipal, runWithPrincipal } from '@platform/common';
import type { RlsElevation } from '@platform/database';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockOf } from '../../../test/mocks.js';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import type { NewTenant } from '../persistence/tenants.repository.js';
import { TenantBootstrap } from './tenant-bootstrap.elevated.js';

const OWNER = '0190f3b2-0000-7000-8000-000000000001';
const TENANT: NewTenant = {
  id: '0190f3b2-0000-7000-8000-0000000000aa',
  slug: 'acme-000000aa',
  name: 'Acme',
  personal: false,
};
const NOW = new Date('2026-11-17T10:00:00.000Z');

describe('TenantBootstrap (justified: tenant-bootstrap)', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let elevation: ReturnType<typeof mockOf<RlsElevation>>;
  let bootstrap: TenantBootstrap;
  let insertedElevated: boolean[];

  beforeEach(() => {
    persistence = createInMemoryIdentityPersistence();
    insertedElevated = [];
    let elevated = false;
    elevation = mockOf<RlsElevation>({
      justified: async (_reason: string, work: () => Promise<unknown>) => {
        elevated = true;
        try {
          return await work();
        } finally {
          elevated = false;
        }
      },
    });
    const memberships = persistence.memberships;
    const insert = memberships.insert.bind(memberships);
    memberships.insert = async (membership) => {
      insertedElevated.push(elevated);
      await insert(membership);
    };
    const tenantInsert = persistence.tenants.insert.bind(persistence.tenants);
    persistence.tenants.insert = async (tenant) => {
      insertedElevated.push(elevated);
      await tenantInsert(tenant);
    };
    bootstrap = new TenantBootstrap(persistence.tenants, memberships, elevation);
  });

  const asOwner = createPrincipal({ userId: OWNER, tenantId: TENANT.id, roles: ['owner'] });

  it('inserts the tenant, then the owner membership under the tenant-bootstrap elevation only', async () => {
    await runWithPrincipal(asOwner, () => bootstrap.create(TENANT, OWNER, NOW));
    expect(elevation.justified).toHaveBeenCalledExactlyOnceWith(
      'tenant-bootstrap',
      expect.any(Function),
    );
    // tenant row: own policy, not elevated; membership: elevated.
    expect(insertedElevated).toEqual([false, true]);
    expect(persistence.store.tenants.get(TENANT.id)).toMatchObject({ name: 'Acme' });
    await expect(persistence.memberships.find(TENANT.id, OWNER)).resolves.toMatchObject({
      roles: ['owner'],
      lastActiveAt: NOW,
    });
  });

  it.each([
    [
      'another user',
      createPrincipal({
        userId: '0190f3b2-0000-7000-8000-000000000002',
        tenantId: TENANT.id,
        roles: ['owner'],
      }),
    ],
    [
      'another tenant',
      createPrincipal({
        userId: OWNER,
        tenantId: '0190f3b2-0000-7000-8000-0000000000bb',
        roles: ['owner'],
      }),
    ],
    [
      'a non-owner principal',
      createPrincipal({ userId: OWNER, tenantId: TENANT.id, roles: ['admin'] }),
    ],
    [
      'a staff switch-in',
      createPrincipal({ userId: OWNER, tenantId: TENANT.id, roles: ['owner'], staff: true }),
    ],
  ])('refuses %s before writing anything', async (_name, principal) => {
    await expect(
      runWithPrincipal(principal, () => bootstrap.create(TENANT, OWNER, null)),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(elevation.justified).not.toHaveBeenCalled();
    expect(persistence.store.tenants.size).toBe(0);
  });
});
