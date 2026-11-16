import { generateId } from '@platform/common';
import type { DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { encodeIdCursor } from '@platform/database';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { createFakePostgres, type FakeQueryHandler } from '../../../test/fake-postgres.js';
import { NOW } from '../../../test/fixtures.js';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import type { IdentitySchema } from './identity.schema.js';

/** A users row as postgres.js returns it. */
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

function setup(handler?: FakeQueryHandler) {
  const fake = createFakePostgres(handler);
  const txHost = { tx: fake.db } as unknown as TransactionHost<
    DrizzleTransactionalAdapter<IdentitySchema>
  >;
  return { ...fake, repository: new DrizzleUsersRepository(fake.db, txHost) };
}

describe('DrizzleUsersRepository', () => {
  it('findById: public columns only (no password_hash), mapped to a record', async () => {
    const id = generateId();
    const { repository, executed } = setup(() => [row(id)]);

    await expect(repository.findById(id)).resolves.toEqual({
      id,
      email: 'ada@example.com',
      displayName: 'Ada',
      isPlatformStaff: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(executed[0]?.sql).toBe(
      'select "id", "email", "display_name", "is_platform_staff", "created_at", "updated_at" from "identity"."users" where "identity"."users"."id" = $1 limit $2',
    );
    expect(executed[0]?.params).toEqual([id, 1]);
  });

  it('findById / findCredentialsByEmail return null when there is no row', async () => {
    const { repository } = setup(() => []);
    await expect(repository.findById(generateId())).resolves.toBeNull();
    await expect(repository.findCredentialsByEmail('x@y.z')).resolves.toBeNull();
  });

  it('findCredentialsByEmail selects the hash for login', async () => {
    const id = generateId();
    const { repository, executed } = setup(() => [fullRow(id)]);
    const found = await repository.findCredentialsByEmail('ada@example.com');
    expect(executed[0]?.sql).toContain('"password_hash"');
    expect(executed[0]?.sql).toContain('where "identity"."users"."email" = $1');
    expect(found).toMatchObject({ id, email: 'ada@example.com', passwordHash: '$argon2id$h' });
  });

  it('existsByEmail selects only the id', async () => {
    const { repository, executed } = setup(() => [{ id: generateId() }]);
    await expect(repository.existsByEmail('ada@example.com')).resolves.toBe(true);
    expect(executed[0]?.sql).toBe(
      'select "id" from "identity"."users" where "identity"."users"."email" = $1 limit $2',
    );
  });

  it('findByIds: ONE query with ONE array parameter (same SQL for any batch size); none for an empty batch', async () => {
    const [a, b] = [generateId(), generateId()];
    const { repository, executed } = setup(() => [row(a), row(b)]);

    await expect(repository.findByIds([])).resolves.toEqual([]);
    expect(executed).toHaveLength(0);

    const found = await repository.findByIds([a, b]);
    expect(found.map((user) => user.id)).toEqual([a, b]);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toMatch(/where "identity"\."users"\."id" = any\(\$1::uuid\[\]\)$/);
    expect(executed[0]?.params).toEqual([[a, b]]);

    await repository.findByIds([a, b, generateId()]);
    expect(executed[1]?.sql).toBe(executed[0]?.sql);
  });

  it('list: keyset page on id DESC with limit+1 look-ahead and an escaped ILIKE search', async () => {
    const ids = [generateId(), generateId(), generateId()];
    const cursorId = generateId();
    const { repository, executed } = setup(() => ids.map((id) => row(id)));

    const tenantId = generateId();
    const page = await repository.list({
      tenantId,
      limit: 2,
      cursor: encodeIdCursor(cursorId),
      search: '50%_off\\',
    });

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

  it('list without search/cursor has only the tenant join and no next cursor on the last page', async () => {
    const tenantId = generateId();
    const { repository, executed } = setup(() => [row(generateId())]);
    const page = await repository.list({ tenantId, limit: 20 });
    expect(executed[0]?.sql).toBe(
      'select "identity"."users"."id", "identity"."users"."email", "identity"."users"."display_name", "identity"."users"."is_platform_staff", "identity"."users"."created_at", "identity"."users"."updated_at" from "identity"."users" inner join "identity"."memberships" on ("identity"."memberships"."user_id" = "identity"."users"."id" and "identity"."memberships"."tenant_id" = $1) order by "identity"."users"."id" desc limit $2',
    );
    expect(executed[0]?.params).toEqual([tenantId, 21]);
    expect(page.nextCursor).toBeNull();
  });

  const newUser = () =>
    UserAggregate.register({
      id: generateId(),
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: '$argon2id$h',
      now: NOW,
    });

  it('insert writes the snapshot; the email unique violation becomes EmailAlreadyTakenException', async () => {
    const { repository, executed, unsafe } = setup(() => []);
    const user = newUser();
    await repository.insert(user);
    expect(executed[0]?.sql).toMatch(
      /^insert into "identity"\."users" \("id", "email", "password_hash", "display_name", "is_platform_staff", "created_at", "updated_at"\)/,
    );
    expect(executed[0]?.params).toContain(user.id);
    expect(executed[0]?.params).toContain(false);

    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'users_email_unique',
    });
    // drizzle 0.45 wraps driver errors in DrizzleQueryError (cause = the postgres.js error).
    unsafe.mockImplementationOnce(() => {
      throw pgError;
    });
    const taken = await repository.insert(newUser()).catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(EmailAlreadyTakenException);
    expect((taken as Error).cause).toBeInstanceOf(DrizzleQueryError);

    const other = new Error('connection reset');
    unsafe.mockImplementationOnce(() => {
      throw other;
    });
    const failure = await repository.insert(newUser()).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(EmailAlreadyTakenException);
    expect((failure as Error).cause).toBe(other);
  });

  it('updatePasswordHash touches only its column (+ updated_at)', async () => {
    const { repository, executed } = setup(() => []);
    const id = generateId();
    await repository.updatePasswordHash(id, '$argon2id$new', NOW);

    expect(executed[0]?.sql).toBe(
      'update "identity"."users" set "password_hash" = $1, "updated_at" = $2 where "identity"."users"."id" = $3',
    );
  });

  it('isPlatformStaff: a fresh single-column read; false when the row is missing', async () => {
    const id = generateId();
    const { repository, executed } = setup(() => [{ is_platform_staff: true }]);
    await expect(repository.isPlatformStaff(id)).resolves.toBe(true);
    expect(executed[0]?.sql).toBe(
      'select "is_platform_staff" from "identity"."users" where "identity"."users"."id" = $1 limit $2',
    );
    expect(executed[0]?.params).toEqual([id, 1]);

    const none = setup(() => []);
    await expect(none.repository.isPlatformStaff(id)).resolves.toBe(false);
  });
});
