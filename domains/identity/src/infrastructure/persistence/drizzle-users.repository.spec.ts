import { generateId } from '@platform/common';
import { RowCountMismatchError } from '@platform/database';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import {
  affected,
  asPrincipal,
  createFakePostgres,
  type FakeQueryHandler,
  fakeTransactionHost,
  SPEC_CONTEXT,
} from '../../../test/fake-postgres.js';
import { NOW } from '../../../test/fixtures.js';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';

/** A users row as postgres.js returns it. */
const row = (id: string) => ({
  id,
  email: 'ada@example.com',
  display_name: 'Ada',
  is_platform_staff: false,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});

/** The runtime repository on a fake pool, every call as SPEC_PRINCIPAL (a unit of work each). */
function setup(handler?: FakeQueryHandler) {
  const fake = createFakePostgres(handler);
  const bare = new DrizzleUsersRepository(fakeTransactionHost(fake.db));
  return { ...fake, bare, repository: asPrincipal(bare) };
}

describe('DrizzleUsersRepository', () => {
  it('runs each call in its own transaction opened with the principal context (inUnitOfWork)', async () => {
    const id = generateId();
    const { repository, transactions, executed } = setup(() => [row(id)]);
    await repository.findById(id);
    await repository.isPlatformStaff(id);
    expect(transactions).toEqual([
      'begin',
      SPEC_CONTEXT,
      'commit',
      'begin',
      SPEC_CONTEXT,
      'commit',
    ]);
    expect(executed).toHaveLength(2);
  });

  it('refuses every method without a principal before any SQL (RLS_NO_PRINCIPAL)', async () => {
    const { bare, transactions, executed } = setup(() => []);
    const calls = [
      () => bare.findById(generateId()),
      () => bare.findByIds([generateId()]),
      () => bare.isPlatformStaff(generateId()),
      () => bare.insert(newUser()),
      () => bare.updatePasswordHash(generateId(), 'h', NOW),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'RLS_NO_PRINCIPAL' });
    }
    expect(transactions).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('builds no named prepared statement and holds no pool handle (constructor takes the host only)', () => {
    expect(DrizzleUsersRepository.length).toBe(1);
  });

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

  it('findById returns null when there is no row', async () => {
    const { repository } = setup(() => []);
    await expect(repository.findById(generateId())).resolves.toBeNull();
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

  const newUser = () =>
    UserAggregate.register({
      id: generateId(),
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: '$argon2id$h',
      now: NOW,
      personalTenantId: generateId(),
    });

  it('insert writes the snapshot; the email unique violation becomes EmailAlreadyTakenException', async () => {
    let fail: Error | undefined;
    const { repository, executed } = setup((sql) => {
      if (fail !== undefined && sql.startsWith('insert')) {
        const error = fail;
        fail = undefined;
        throw error;
      }
      return [];
    });
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
    fail = pgError;
    const taken = await repository.insert(newUser()).catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(EmailAlreadyTakenException);
    expect((taken as Error).cause).toBeInstanceOf(DrizzleQueryError);

    const other = new Error('connection reset');
    fail = other;
    const failure = await repository.insert(newUser()).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(EmailAlreadyTakenException);
    expect((failure as Error).cause).toBe(other);
  });

  it('updatePasswordHash touches only its column (+ updated_at) and needs exactly one row', async () => {
    const { repository, executed } = setup(() => affected(1));
    const id = generateId();
    await repository.updatePasswordHash(id, '$argon2id$new', NOW);

    expect(executed[0]?.sql).toBe(
      'update "identity"."users" set "password_hash" = $1, "updated_at" = $2 where "identity"."users"."id" = $3',
    );
  });

  it('updatePasswordHash of a row RLS hides (0 rows) throws RowCountMismatchError', async () => {
    const { repository } = setup(() => affected(0));
    const failure = await repository
      .updatePasswordHash(generateId(), '$argon2id$new', NOW)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RowCountMismatchError);
    expect(failure).toMatchObject({ expected: 1, actual: 0 });
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
