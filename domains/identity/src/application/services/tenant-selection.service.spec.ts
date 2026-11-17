import { PLATFORM_TENANT_ID } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../test/fixtures.js';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { createInMemoryIdentityPersistence } from '../../testing/in-memory-identity.js';
import { PersonalWorkspaces } from './personal-workspaces.service.js';
import { TenantSelection } from './tenant-selection.service.js';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const OTHER = '0190f3b2-0000-7000-8000-0000000000bb';

describe('TenantSelection.forLogin', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let selection: TenantSelection;
  const user = makeUserRecord();

  beforeEach(() => {
    persistence = createInMemoryIdentityPersistence();
    const workspaces = new PersonalWorkspaces(persistence.tenants, persistence.memberships);
    selection = new TenantSelection(persistence.memberships, workspaces);
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

  it('without a tenantId: the most recently active membership, touched', async () => {
    await member('0190f3b2-0000-7000-8000-0000000000a1', new Date(1_000));
    await member('0190f3b2-0000-7000-8000-0000000000a2', new Date(2_000), ['admin']);
    const picked = await selection.forLogin(user, undefined, NOW);
    expect(picked).toMatchObject({
      tenantId: '0190f3b2-0000-7000-8000-0000000000a2',
      roles: ['admin'],
      lastActiveAt: NOW,
    });
    expect(picked.workspaceCreated).toBeUndefined();
    await expect(persistence.memberships.find(picked.tenantId, user.id)).resolves.toMatchObject({
      lastActiveAt: NOW,
    });
  });

  it('with a tenantId the user belongs to: that membership, touched', async () => {
    await member('0190f3b2-0000-7000-8000-0000000000a1', new Date(1_000), ['owner']);
    await member('0190f3b2-0000-7000-8000-0000000000a2', new Date(2_000));
    await expect(
      selection.forLogin(user, '0190f3b2-0000-7000-8000-0000000000a1', NOW),
    ).resolves.toMatchObject({
      tenantId: '0190f3b2-0000-7000-8000-0000000000a1',
      roles: ['owner'],
      lastActiveAt: NOW,
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
      await expect(selection.forLogin(user, tenantId, NOW)).rejects.toBeInstanceOf(
        TenantAccessDeniedException,
      );
    },
  );

  it('a pre-tenancy account without any membership gets its personal workspace', async () => {
    const picked = await selection.forLogin(user, undefined, NOW);
    expect(picked).toMatchObject({ userId: user.id, roles: ['owner'], lastActiveAt: NOW });
    expect(persistence.store.tenants.get(picked.tenantId)).toMatchObject({ personal: true });
    // The login handler publishes this membership once its unit of work committed.
    expect(picked.workspaceCreated).toBe(true);
  });
});
