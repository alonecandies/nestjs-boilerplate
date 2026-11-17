import { PLATFORM_TENANT_ID } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../test/fixtures.js';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import { TenantSelection } from './tenant-selection.service.js';

const OTHER = '0190f3b2-0000-7000-8000-0000000000bb';

describe('TenantSelection.forLogin', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let selection: TenantSelection;
  const user = makeUserRecord();

  beforeEach(() => {
    persistence = createInMemoryIdentityPersistence();
    selection = new TenantSelection(persistence.memberships);
  });

  const member = async (
    tenantId: string,
    lastActiveAt: Date | null,
    roles: ('owner' | 'admin' | 'member')[] = ['member'],
  ) => {
    await persistence.tenants.insert({
      id: tenantId,
      slug: tenantId,
      name: tenantId,
      personal: false,
    });
    await persistence.memberships.insert({ tenantId, userId: user.id, roles, lastActiveAt });
  };

  it('without a tenantId: the most recently active membership, read only (the login touches it)', async () => {
    await member('0190f3b2-0000-7000-8000-0000000000a1', new Date(1_000));
    await member('0190f3b2-0000-7000-8000-0000000000a2', new Date(2_000), ['admin']);
    const picked = await selection.forLogin(user, undefined);
    expect(picked).toMatchObject({
      tenantId: '0190f3b2-0000-7000-8000-0000000000a2',
      roles: ['admin'],
      lastActiveAt: new Date(2_000),
    });
    await expect(
      persistence.memberships.find('0190f3b2-0000-7000-8000-0000000000a2', user.id),
    ).resolves.toMatchObject({ lastActiveAt: new Date(2_000) });
  });

  it('with a tenantId the user belongs to: that membership', async () => {
    await member('0190f3b2-0000-7000-8000-0000000000a1', new Date(1_000), ['owner']);
    await member('0190f3b2-0000-7000-8000-0000000000a2', new Date(2_000));
    await expect(
      selection.forLogin(user, '0190f3b2-0000-7000-8000-0000000000a1'),
    ).resolves.toMatchObject({
      tenantId: '0190f3b2-0000-7000-8000-0000000000a1',
      roles: ['owner'],
      lastActiveAt: new Date(1_000),
    });
  });

  it.each([
    ['a tenant the user is not a member of', OTHER],
    ['an unknown tenant', '0190f3b2-0000-7000-8000-00000000dead'],
    ['the platform tenant (nil UUID)', PLATFORM_TENANT_ID],
    ['a malformed id', "x'; drop table identity.users; --"],
  ])(
    'refuses %s with the same 403 TENANT_ACCESS_DENIED (Review Focus 1)',
    async (_name, tenantId) => {
      await member('0190f3b2-0000-7000-8000-0000000000a1', null);
      await persistence.tenants.insert({
        id: OTHER,
        slug: 'other',
        name: 'Other',
        personal: false,
      });
      await expect(selection.forLogin(user, tenantId)).rejects.toBeInstanceOf(
        TenantAccessDeniedException,
      );
    },
  );

  it('a pre-tenancy account without any membership: null (the login bootstraps its workspace)', async () => {
    await expect(selection.forLogin(user, undefined)).resolves.toBeNull();
    expect(persistence.store.tenants.size).toBe(0);
  });
});
