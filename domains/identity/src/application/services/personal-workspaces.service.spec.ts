import { isUuidV7 } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { TENANT_SLUG_PATTERN } from '../../domain/tenant-slug.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import { PersonalWorkspaces } from './personal-workspaces.service.js';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const ada = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'ada.lovelace+test@example.com',
  displayName: 'Ada',
};

describe('PersonalWorkspaces', () => {
  it('creates a personal tenant slugged from the email and an owner membership active now', async () => {
    const persistence = createInMemoryIdentityPersistence();
    const membership = await new PersonalWorkspaces(
      persistence.tenants,
      persistence.memberships,
    ).create(ada, NOW);

    expect(membership).toEqual({
      tenantId: expect.any(String),
      userId: ada.id,
      roles: ['owner'],
      lastActiveAt: NOW,
      createdAt: NOW,
    });
    expect(isUuidV7(membership.tenantId)).toBe(true);
    const tenant = persistence.store.tenants.get(membership.tenantId);
    expect(tenant).toMatchObject({ name: "Ada's workspace", personal: true });
    expect(tenant?.slug).toMatch(/^ada-lovelace-test-[0-9a-f]{8}$/);
    await expect(persistence.memberships.find(membership.tenantId, ada.id)).resolves.toMatchObject({
      roles: ['owner'],
    });
  });

  it('uses the tenant id the caller chose (register hands it to UserRegisteredEvent too)', async () => {
    const persistence = createInMemoryIdentityPersistence();
    const tenantId = '0190f3b2-0000-7000-8000-0000000000a1';
    const membership = await new PersonalWorkspaces(
      persistence.tenants,
      persistence.memberships,
    ).create(ada, NOW, tenantId);

    expect(membership.tenantId).toBe(tenantId);
    expect(persistence.store.tenants.get(tenantId)).toMatchObject({ personal: true });
    await expect(persistence.memberships.find(tenantId, ada.id)).resolves.not.toBeNull();
  });

  it('gives the same local part on two domains two slugs, and slug-less local parts a valid one', async () => {
    const persistence = createInMemoryIdentityPersistence();
    const workspaces = new PersonalWorkspaces(persistence.tenants, persistence.memberships);
    const first = await workspaces.create({ ...ada, email: 'ada@a.io' }, NOW);
    const second = await workspaces.create(
      { ...ada, id: '0190f3b2-0000-7000-8000-000000000002', email: 'ada@b.io' },
      NOW,
    );
    const third = await workspaces.create(
      { ...ada, id: '0190f3b2-0000-7000-8000-000000000003', email: '+++@x.io' },
      NOW,
    );
    const slugs = [first, second, third].map(
      (m) => persistence.store.tenants.get(m.tenantId)?.slug,
    );
    expect(new Set(slugs).size).toBe(3);
    for (const slug of slugs) expect(slug).toMatch(TENANT_SLUG_PATTERN);
    expect(slugs[2]).toMatch(/^workspace-[0-9a-f]{8}$/);
  });
});
