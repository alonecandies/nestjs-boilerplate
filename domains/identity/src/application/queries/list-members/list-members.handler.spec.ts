import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { ListMembersHandler } from './list-members.handler.js';
import { ListMembersQuery } from './list-members.query.js';

describe('ListMembersHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: ListMembersHandler;
  const tenantId = generateId();
  let ids: string[];

  const member = async (userId: string, roles: TenantRole[]) => {
    await p.users.insert(
      UserAggregate.register({
        id: userId,
        email: `${userId}@example.com`,
        displayName: `user ${userId.slice(-4)}`,
        passwordHash: 'x',
        now: new Date(),
      }),
    );
    await p.memberships.insert({ tenantId, userId, roles, lastActiveAt: null });
  };
  const as = (
    userId: string,
    query: ListMembersQuery,
    opts: { tenant?: string; staff?: boolean } = {},
  ) =>
    runWithPrincipal(
      createPrincipal({
        userId,
        tenantId: opts.tenant ?? tenantId,
        roles: opts.staff ? ['admin'] : ['member'],
        staff: opts.staff ?? false,
      }),
      () => handler.execute(query),
    );

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    ids = [generateId(), generateId(), generateId()];
    await member(ids[0] as string, ['owner']);
    await member(ids[1] as string, ['admin']);
    await member(ids[2] as string, ['member']);
    handler = new ListMembersHandler(p.memberships, p.membershipsSystem);
  });

  it('pages newest user id first via nextCursor', async () => {
    const newestFirst = [...ids].sort().reverse();
    const first = await as(ids[0] as string, new ListMembersQuery(tenantId, 2));
    expect(first.items.map((m) => m.userId)).toEqual(newestFirst.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items[0]).toMatchObject({ email: expect.stringContaining('@') });
    const rest = await as(ids[0] as string, new ListMembersQuery(tenantId, 2, first.nextCursor));
    expect(rest.items.map((m) => m.userId)).toEqual(newestFirst.slice(2));
    expect(rest.nextCursor).toBeUndefined();
  });

  it('limit 0 means the default page', async () => {
    const page = await as(ids[2] as string, new ListMembersQuery(tenantId, 0));
    expect(page.items).toHaveLength(3);
  });

  it('403 TENANT_ACCESS_DENIED when the principal acts in another tenant', async () => {
    await expect(
      as(ids[0] as string, new ListMembersQuery(tenantId, 0), { tenant: generateId() }),
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });

  it('403 TENANT_ACCESS_DENIED once the membership row is gone', async () => {
    await p.memberships.delete(tenantId, ids[2] as string);
    await expect(as(ids[2] as string, new ListMembersQuery(tenantId, 0))).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
    });
  });

  it('staff switch-in may list without a membership', async () => {
    const staff = generateId();
    const page = await as(staff, new ListMembersQuery(tenantId, 0), { staff: true });
    expect(page.items).toHaveLength(3);
  });
});
