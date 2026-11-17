import { generateId, runWithPrincipal, SystemContext } from '@platform/common';
import { encodeIdCursor, SystemDatabase } from '@platform/database';
import { describe, expect, it } from 'vitest';
import {
  affected,
  createFakePostgres,
  type FakeQueryHandler,
  SPEC_PRINCIPAL,
} from '../../../test/fake-postgres.js';
import { NOW } from '../../../test/fixtures.js';
import { DrizzleInvitationsSystemRepository } from './drizzle-invitations.system-repository.js';
import { DrizzleMembershipsSystemRepository } from './drizzle-memberships.system-repository.js';
import { DrizzleSessionsSystemRepository } from './drizzle-sessions.system-repository.js';
import { DrizzleUsersSystemRepository } from './drizzle-users.system-repository.js';

/** A users row (public columns) as postgres.js returns it. */
const row = (id: string) => ({
  id,
  email: 'ada@example.com',
  display_name: 'Ada',
  is_platform_staff: false,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});

/** `select()` of every column: drizzle maps positionally, in table column order. */
const fullRow = (id: string) => ({
  id,
  email: 'ada@example.com',
  password_hash: '$argon2id$h',
  display_name: 'Ada',
  is_platform_staff: false,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});

/** The system repositories over a `SystemDatabase` whose pool is a fake: no transaction, no context. */
function setup(handler?: FakeQueryHandler) {
  const fake = createFakePostgres(handler);
  const system = new SystemDatabase(fake.db);
  return {
    ...fake,
    users: new DrizzleUsersSystemRepository(system),
    memberships: new DrizzleMembershipsSystemRepository(system),
    invitations: new DrizzleInvitationsSystemRepository(system),
    sessions: new DrizzleSessionsSystemRepository(system),
  };
}

const inSystem = <T>(work: () => Promise<T>): Promise<T> =>
  SystemContext.run('identity.spec', work);

describe('DrizzleUsersSystemRepository', () => {
  it('findCredentialsByEmail (pre-auth) selects the hash, with no principal, outside SystemContext', async () => {
    const id = generateId();
    const { users, executed, transactions } = setup(() => [fullRow(id)]);
    const found = await users.findCredentialsByEmail('ada@example.com');
    expect(executed[0]?.sql).toContain('"password_hash"');
    expect(executed[0]?.sql).toContain('where "identity"."users"."email" = $1');
    expect(found).toMatchObject({ id, email: 'ada@example.com', passwordHash: '$argon2id$h' });
    // The system pool never opens a runtime transaction nor sends an RLS context.
    expect(transactions).toEqual([]);
    await expect(setup(() => []).users.findCredentialsByEmail('x@y.z')).resolves.toBeNull();
  });

  it('existsByEmail (pre-auth) selects only the id', async () => {
    const { users, executed } = setup(() => [{ id: generateId() }]);
    await expect(users.existsByEmail('ada@example.com')).resolves.toBe(true);
    expect(executed[0]?.sql).toBe(
      'select "id" from "identity"."users" where "identity"."users"."email" = $1 limit $2',
    );
    await expect(setup(() => []).users.existsByEmail('ada@example.com')).resolves.toBe(false);
  });

  it('listInTenant: keyset page on id DESC with limit+1 look-ahead and an escaped ILIKE search', async () => {
    const ids = [generateId(), generateId(), generateId()];
    const cursorId = generateId();
    const { users, executed } = setup(() => ids.map((id) => row(id)));

    const tenantId = generateId();
    const page = await inSystem(() =>
      users.listInTenant({
        tenantId,
        limit: 2,
        cursor: encodeIdCursor(cursorId),
        search: '50%_off\\',
      }),
    );

    const [query] = executed;
    expect(query?.sql).toContain(
      'from "identity"."users" inner join "identity"."memberships" on ("identity"."memberships"."user_id" = "identity"."users"."id" and "identity"."memberships"."tenant_id" = $1) where (("identity"."users"."email" ilike $2 or "identity"."users"."display_name" ilike $3) and "identity"."users"."id" < $4) order by "identity"."users"."id" desc limit $5',
    );
    expect(query?.params).toEqual([
      tenantId,
      '%50\\%\\_off\\\\%',
      '%50\\%\\_off\\\\%',
      cursorId,
      3,
    ]);
    expect(page.items.map((user) => user.id)).toEqual(ids.slice(0, 2));
    expect(page.nextCursor).toBe(encodeIdCursor(ids[1] ?? ''));
  });

  it('listInTenant without search/cursor has only the tenant join and no next cursor on the last page', async () => {
    const tenantId = generateId();
    const { users, executed } = setup(() => [row(generateId())]);
    const page = await inSystem(() => users.listInTenant({ tenantId, limit: 20 }));
    expect(executed[0]?.sql).toBe(
      'select "identity"."users"."id", "identity"."users"."email", "identity"."users"."display_name", "identity"."users"."is_platform_staff", "identity"."users"."created_at", "identity"."users"."updated_at" from "identity"."users" inner join "identity"."memberships" on ("identity"."memberships"."user_id" = "identity"."users"."id" and "identity"."memberships"."tenant_id" = $1) order by "identity"."users"."id" desc limit $2',
    );
    expect(executed[0]?.params).toEqual([tenantId, 21]);
    expect(page.nextCursor).toBeNull();
  });

  it('findByIdInTenant joins memberships on the asserted tenant; public columns only', async () => {
    const [id, tenantId] = [generateId(), generateId()];
    const { users, executed } = setup(() => [row(id)]);
    await expect(inSystem(() => users.findByIdInTenant(id, tenantId))).resolves.toMatchObject({
      id,
    });
    expect(executed[0]?.sql).not.toContain('password_hash');
    expect(executed[0]?.sql).toContain(
      'inner join "identity"."memberships" on ("identity"."memberships"."user_id" = "identity"."users"."id" and "identity"."memberships"."tenant_id" = $1) where "identity"."users"."id" = $2',
    );
    expect(executed[0]?.params).toEqual([tenantId, id, 1]);
  });

  it('the directory reads are `system` methods: refused outside SystemContext, even under a principal', async () => {
    const { users, executed } = setup(() => []);
    await expect(users.listInTenant({ tenantId: generateId(), limit: 1 })).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    await expect(
      runWithPrincipal(SPEC_PRINCIPAL, () => users.findByIdInTenant(generateId(), generateId())),
    ).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    expect(executed).toEqual([]);
  });
});

describe('DrizzleMembershipsSystemRepository', () => {
  const member = (userId: string) => ({
    user_id: userId,
    email: 'ada@example.com',
    display_name: 'Ada',
    roles: ['member'],
    created_at: NOW.toISOString(),
  });

  it('listMembers: memberships ⋈ users within the tenant, keyset on user_id DESC', async () => {
    const tenantId = generateId();
    const ids = [generateId(), generateId()];
    const { memberships, executed } = setup(() => ids.map(member));
    const page = await inSystem(() => memberships.listMembers(tenantId, { limit: 1 }));
    expect(executed[0]?.sql).toBe(
      'select "identity"."memberships"."user_id", "identity"."users"."email", "identity"."users"."display_name", "identity"."memberships"."roles", "identity"."memberships"."created_at" from "identity"."memberships" inner join "identity"."users" on "identity"."users"."id" = "identity"."memberships"."user_id" where "identity"."memberships"."tenant_id" = $1 order by "identity"."memberships"."user_id" desc limit $2',
    );
    expect(executed[0]?.params).toEqual([tenantId, 2]);
    expect(page.items.map((m) => m.userId)).toEqual([ids[0]]);
    expect(page.nextCursor).toBe(encodeIdCursor(ids[0] ?? ''));
  });

  it('findMember filters on (tenant_id, user_id)', async () => {
    const [tenantId, userId] = [generateId(), generateId()];
    const { memberships, executed } = setup(() => [member(userId)]);
    await expect(inSystem(() => memberships.findMember(tenantId, userId))).resolves.toMatchObject({
      userId,
      roles: ['member'],
    });
    expect(executed[0]?.sql).toContain(
      'where ("identity"."memberships"."tenant_id" = $1 and "identity"."memberships"."user_id" = $2) limit $3',
    );
  });

  it('listForUser joins tenants and filters on the user, most recent first', async () => {
    const userId = generateId();
    const { memberships, executed } = setup(() => []);
    await expect(inSystem(() => memberships.listForUser(userId))).resolves.toEqual([]);
    expect(executed[0]?.sql).toContain(
      'from "identity"."memberships" inner join "identity"."tenants" on "identity"."tenants"."id" = "identity"."memberships"."tenant_id" where "identity"."memberships"."user_id" = $1 order by "identity"."memberships"."last_active_at" desc nulls last, "identity"."memberships"."created_at" desc',
    );
  });

  it('every method is refused outside SystemContext', async () => {
    const { memberships, executed } = setup(() => []);
    for (const read of [
      () => memberships.listMembers(generateId(), { limit: 1 }),
      () => memberships.findMember(generateId(), generateId()),
      () => memberships.listForUser(generateId()),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    }
    expect(executed).toEqual([]);
  });
});

describe('DrizzleInvitationsSystemRepository', () => {
  it('findByTokenHash (pre-auth): the token hash only, no tenant (a multi-shard read)', async () => {
    const { invitations, executed } = setup(() => []);
    await expect(invitations.findByTokenHash('h'.repeat(64))).resolves.toBeNull();
    expect(executed[0]?.sql).toMatch(
      /from "identity"\."invitations" where "identity"\."invitations"\."token_hash" = \$1 limit \$2$/,
    );
  });
});

describe('DrizzleSessionsSystemRepository', () => {
  it('deleteExpired is ONE multi-shard DELETE on expires_at: no sub-select, no LIMIT, no row locks', async () => {
    const { sessions, executed } = setup(() => affected(12));
    await expect(inSystem(() => sessions.deleteExpired(NOW))).resolves.toBe(12);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toBe(
      'delete from "identity"."sessions" where "identity"."sessions"."expires_at" <= $1',
    );
    expect(executed[0]?.params).toEqual([NOW.toISOString()]);
  });

  it('deleteExpired is refused outside SystemContext', async () => {
    const { sessions, executed } = setup(() => affected(12));
    await expect(sessions.deleteExpired(NOW)).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    expect(executed).toEqual([]);
  });
});
