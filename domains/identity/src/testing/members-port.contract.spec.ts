import type { MemberPage } from '@domain/identity-contracts';
import { createTestRbacRegistry } from '@platform/auth/testing';
import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { ListMembersHandler } from '../application/queries/list-members/list-members.handler.js';
import { ListMembersQuery } from '../application/queries/list-members/list-members.query.js';
import { UserAggregate } from '../domain/user.aggregate.js';
import { IDENTITY_RBAC } from '../identity.permissions.js';
import { FakeIdentityState } from './fake-identity-ports.js';
import { FakeMembersPort, FakeTenancyState } from './fake-tenancy-ports.js';
import { createInMemoryIdentityPersistence } from './in-memory-identity.js';

/*
 * The gateway e2e binds `FakeMembersPort` where identity-service runs `ListMembersHandler`. The
 * same cases run against both, so a gateway e2e that passes against the fake would pass against
 * the real service: the missing principal, the refusals, the users:read gate and the staff
 * switch-in (its roles come from the token, never from a membership row).
 */

interface Seed {
  userId: string;
  roles: TenantRole[];
}

interface Harness {
  /** Seeds the tenant's members; each display name differs from the email. */
  seed(tenantId: string, members: Seed[]): Promise<void>;
  list(tenantId: string): Promise<MemberPage>;
}

const emailOf = (userId: string) => `${userId}@example.com`;
const nameOf = (userId: string) => `User ${userId.slice(-4)}`;

function handlerHarness(): Harness {
  const p = createInMemoryIdentityPersistence();
  const handler = new ListMembersHandler(
    p.memberships,
    p.membershipsSystem,
    createTestRbacRegistry(IDENTITY_RBAC),
  );
  return {
    async seed(tenantId, members) {
      for (const { userId, roles } of members) {
        await p.users.insert(
          UserAggregate.register({
            id: userId,
            email: emailOf(userId),
            displayName: nameOf(userId),
            passwordHash: 'x',
            now: new Date(),
            personalTenantId: generateId(),
          }),
        );
        await p.memberships.insert({ tenantId, userId, roles, lastActiveAt: null });
      }
    },
    list: (tenantId) => handler.execute(new ListMembersQuery(tenantId, 0)),
  };
}

function fakeHarness(): Harness {
  const identity = new FakeIdentityState();
  const port = new FakeMembersPort(new FakeTenancyState(identity));
  return {
    async seed(tenantId, members) {
      identity.tenants.set(tenantId, { id: tenantId, name: 'Acme', personal: false });
      for (const { userId, roles } of members) {
        identity.users.set(userId, {
          user: {
            id: userId,
            email: emailOf(userId),
            displayName: nameOf(userId),
            roles: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          password: 'x',
        });
        identity.addMembership(tenantId, userId, roles);
      }
    },
    list: (tenantId) => port.listMembers({ tenantId, limit: 0 }),
  };
}

describe.each([
  ['ListMembersHandler (in-memory tenancy)', handlerHarness],
  ['FakeMembersPort', fakeHarness],
])('MembersPort.listMembers contract: %s', (_name, make) => {
  const tenantId = generateId();
  const owner = generateId();
  const member = generateId();
  let harness: Harness;

  beforeEach(async () => {
    harness = make();
    await harness.seed(tenantId, [
      { userId: owner, roles: ['owner'] },
      { userId: member, roles: ['member'] },
    ]);
  });

  const as = (
    userId: string,
    opts: { tenant?: string; roles?: TenantRole[]; staff?: boolean } = {},
  ) =>
    runWithPrincipal(
      createPrincipal({
        userId,
        tenantId: opts.tenant ?? tenantId,
        roles: opts.roles ?? ['member'],
        staff: opts.staff ?? false,
      }),
      () => harness.list(tenantId),
    );
  const byId = (page: MemberPage) => new Map(page.items.map((m) => [m.userId, m]));
  const complete = (userId: string, roles: TenantRole[]) => ({
    userId,
    email: emailOf(userId),
    displayName: nameOf(userId),
    roles,
  });
  const withheld = (userId: string) => ({
    userId,
    email: '',
    displayName: nameOf(userId),
    roles: [],
  });

  it('401 PRINCIPAL_MISSING without a principal', async () => {
    await expect(harness.list(tenantId)).rejects.toMatchObject({
      code: 'PRINCIPAL_MISSING',
      httpStatus: 401,
    });
  });

  it('403 TENANT_ACCESS_DENIED for a principal acting in another tenant', async () => {
    await expect(as(owner, { tenant: generateId(), roles: ['owner'] })).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
      httpStatus: 403,
    });
  });

  it('403 TENANT_ACCESS_DENIED for a principal of the tenant without a membership', async () => {
    await expect(as(generateId(), { roles: ['admin'] })).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
      httpStatus: 403,
    });
  });

  it('a member (token claiming admin) gets co-members without email and roles, own row complete', async () => {
    const page = byId(await as(member, { roles: ['admin'] }));
    expect(page.get(owner)).toMatchObject(withheld(owner));
    expect(JSON.stringify(page.get(owner))).not.toContain(emailOf(owner));
    expect(page.get(member)).toMatchObject(complete(member, ['member']));
  });

  it('an owner (users:read) gets every field of every member', async () => {
    const page = byId(await as(owner, { roles: ['owner'] }));
    expect(page.get(owner)).toMatchObject(complete(owner, ['owner']));
    expect(page.get(member)).toMatchObject(complete(member, ['member']));
  });

  it('a staff switch-in without a membership lists with its token roles (admin: the directory)', async () => {
    const page = byId(await as(generateId(), { staff: true, roles: ['admin'] }));
    expect(page.size).toBe(2);
    expect(page.get(owner)).toMatchObject(complete(owner, ['owner']));
    expect(page.get(member)).toMatchObject(complete(member, ['member']));
  });

  it('a staff switch-in takes its roles from the token, not from a membership row', async () => {
    // The member row says member; the staff token says admin: the token decides.
    const page = byId(await as(member, { staff: true, roles: ['admin'] }));
    expect(page.get(owner)).toMatchObject(complete(owner, ['owner']));
    // And the other way round: a staff token without users:read over an owner row is withheld.
    const narrow = byId(await as(owner, { staff: true, roles: ['member'] }));
    expect(narrow.get(member)).toMatchObject(withheld(member));
    expect(narrow.get(owner)).toMatchObject(complete(owner, ['owner']));
  });
});
