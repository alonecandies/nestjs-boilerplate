import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateId, isUuidV7, sha256Hex } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import {
  type DatabaseMigrationSet,
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  platformMigrations,
} from '@platform/database';
import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { identityMigrations } from './identity.migrations.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';

/*
 * DrizzleUsersRepository / DrizzleSessionsRepository against a real PostgreSQL 18, through the
 * real DatabaseModule, which applies the platform set and identity's REAL generated history
 * (./migrations, schema `identity`) at boot, like identity-service. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project identity:int
 * Set INTEGRATION_DATABASE_URL to use an existing throwaway database instead of testcontainers.
 * The container is Citus 14.2 on PostgreSQL 18, single node (@platform/testing/postgres).
 * Rows use unique emails/search tokens, so reruns against the same database do not collide.
 */

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    DatabaseModule.forRootAsync({
      schema: identitySchema,
      migrations: [identityMigrations],
      runMigrations: true,
    }),
  ],
  providers: [DrizzleUsersRepository, DrizzleSessionsRepository, DrizzleTransactionRunner],
})
class IdentityPersistenceModule {}

/** Same wiring on a ONE-connection pool: per-connection state (prepared statements) is observable. */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    DatabaseModule.forRootAsync({
      schema: identitySchema,
      migrations: [identityMigrations],
      postgres: { max: 1 },
    }),
  ],
  providers: [DrizzleUsersRepository],
})
class SingleConnectionModule {}

/**
 * Boots IdentityPersistenceModule. `abortOnError: false`: a failing boot rejects with its own
 * error, where Nest's default calls process.abort() and kills the Vitest worker before afterAll.
 */
const boot = (): Promise<INestApplicationContext> =>
  NestFactory.createApplicationContext(IdentityPersistenceModule, {
    logger: false,
    abortOnError: false,
  });

/** Entries in a set's drizzle journal: once applied, its bookkeeping table holds one row each. */
const journalSize = (set: DatabaseMigrationSet): number => {
  const journal = JSON.parse(readFileSync(join(set.folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
};

const sleep = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/** A promise plus its resolver (hold a transaction open until the test says so). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const register = (email: string, displayName = 'Integration User'): UserAggregate =>
  UserAggregate.register({
    id: generateId(),
    email,
    displayName,
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    now: new Date(),
  });

describe.skipIf(process.env['INTEGRATION'] !== '1')('identity persistence on PostgreSQL 18', () => {
  let pg: TestPostgres | undefined;
  let app: INestApplicationContext | undefined;
  let db: DrizzleDB<IdentitySchema>;
  let usersRepo: DrizzleUsersRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  let transaction: DrizzleTransactionRunner;
  const run = generateId().slice(-12);
  const email = (name: string): string => `${name}.${run}@example.com`;

  /** Bookkeeping rows of the platform set (schema `app`) and of identity's set. */
  const bookkeeping = async (): Promise<{ app: number; identity: number }> => {
    const [counts] = await db.execute<{ app: number; identity: number }>(sql`
      select (select count(*)::int from app.__drizzle_migrations) as app,
        (select count(*)::int from identity.__drizzle_migrations) as identity`);
    return { app: counts?.app ?? -1, identity: counts?.identity ?? -1 };
  };

  beforeAll(async () => {
    pg = await startTestPostgres();
    vi.stubEnv('DATABASE_URL', pg.url);
    vi.stubEnv('SERVICE_NAME', 'identity-int');
    app = await boot();
    db = app.get(DRIZZLE);
    usersRepo = app.get(DrizzleUsersRepository);
    sessionsRepo = app.get(DrizzleSessionsRepository);
    transaction = app.get(DrizzleTransactionRunner);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    vi.unstubAllEnvs();
  });

  it("boot applied the platform set and identity's history only, into their own schemas", async () => {
    const tables = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('app', 'identity', 'billing')`);
    // identity-service never creates billing's tables: each app applies only its own sets.
    expect(tables.map((row) => row.name).toSorted()).toEqual([
      'app.__drizzle_migrations',
      'app.tenant_colocation',
      'identity.__drizzle_migrations',
      'identity.sessions',
      'identity.tenants',
      'identity.users',
    ]);
    const enums = await db.execute<{ name: string }>(sql`
      select n.nspname || '.' || t.typname as name
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typname in ('user_role', 'payment_status') and n.nspname <> 'public'`);
    expect(enums.map((row) => row.name)).toEqual(['identity.user_role']);
    const [trgm] = await db.execute<{ schema: string }>(sql`
      select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_trgm'`);
    expect(trgm?.schema).toBe('public');
  });

  it('puts no table and no user_role type in public', async () => {
    // The platform set's pg_trgm puts functions, operators and types in public, never tables.
    // Under this spec's role `app`, an unqualified table or enum lands in schema `app` instead
    // (search_path "$user", public), where the first test's lists catch it.
    // Citus adds its views (citus_tables, citus_shards, …) to public: views are not tables.
    const tables = await db.execute<{ name: string }>(sql`
      select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`);
    expect(tables.map((row) => row.name)).toEqual([]);
    const types = await db.execute<{ name: string }>(sql`
      select t.typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'user_role'`);
    expect(types.map((row) => row.name)).toEqual([]);
  });

  it("records one bookkeeping row per journal entry, in each set's own table", async () => {
    await expect(bookkeeping()).resolves.toEqual({
      app: journalSize(platformMigrations),
      identity: journalSize(identityMigrations),
    });
  });

  it('insert → findById (no hash) / findCredentialsByEmail (hash) / existsByEmail', async () => {
    const user = register(email('ada'), 'Ada Lovelace');
    await usersRepo.insert(user);

    const record = await usersRepo.findById(user.id);
    expect(record).toMatchObject({ id: user.id, email: email('ada'), roles: ['user'] });
    expect(record).not.toHaveProperty('passwordHash');
    expect(record?.createdAt).toBeInstanceOf(Date);

    const credentials = await usersRepo.findCredentialsByEmail(email('ada'));
    expect(credentials?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(usersRepo.existsByEmail(email('ada'))).resolves.toBe(true);
    await expect(usersRepo.existsByEmail(email('nobody'))).resolves.toBe(false);
    await expect(usersRepo.findById(generateId())).resolves.toBeNull();
  });

  it('maps the users_email_unique violation to EmailAlreadyTakenException', async () => {
    await usersRepo.insert(register(email('dup')));
    await expect(usersRepo.insert(register(email('dup')))).rejects.toBeInstanceOf(
      EmailAlreadyTakenException,
    );
  });

  it('findByIds: one query, unknown ids omitted', async () => {
    const [a, b] = [register(email('batch-a')), register(email('batch-b'))];
    await usersRepo.insert(a);
    await usersRepo.insert(b);
    const found = await usersRepo.findByIds([a.id, generateId(), b.id]);
    expect(found.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    await expect(usersRepo.findByIds([])).resolves.toEqual([]);
  });

  it('list: keyset pages newest first, search is a literal ILIKE', async () => {
    const token = `kst${run}`;
    const created: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      const user = register(email(`${token}-${name}`), `Keyset ${name}`);
      await usersRepo.insert(user);
      created.push(user.id);
    }
    const first = await usersRepo.list({ limit: 2, search: token.toUpperCase() });
    expect(first.items.map((row) => row.id)).toEqual([created[2], created[1]]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await usersRepo.list({
      limit: 2,
      search: token,
      cursor: first.nextCursor ?? '',
    });
    expect(second.items.map((row) => row.id)).toEqual([created[0]]);
    expect(second.nextCursor).toBeNull();

    // `%` is escaped: it must not act as a wildcard.
    await expect(usersRepo.list({ limit: 5, search: `${token}%` })).resolves.toMatchObject({
      items: [],
    });
  });

  it('updateRoles stores the user_role[] array', async () => {
    const user = register(email('roles'));
    await usersRepo.insert(user);
    await usersRepo.updateRoles(user.id, ['admin', 'user'], new Date());
    await expect(usersRepo.findById(user.id)).resolves.toMatchObject({ roles: ['admin', 'user'] });
  });

  it('findAggregate locks the row: a concurrent read-modify-write waits, then sees the committed roles', async () => {
    const user = register(email('locked'));
    await usersRepo.insert(user);
    const [locked, release] = [gate(), gate()];

    const first = transaction.run(async () => {
      await usersRepo.findAggregate(user.id);
      locked.open();
      await release.promise;
      await usersRepo.updateRoles(user.id, ['moderator', 'user'], new Date());
    });
    await locked.promise;
    const second = transaction.run(async () => (await usersRepo.findAggregate(user.id))?.roles);

    await expect(Promise.race([second, sleep(300)])).resolves.toBe('timeout');
    release.open();
    await first;
    // Not the stale ['user'] it would have read without the lock (lost update / wrong audit).
    await expect(second).resolves.toEqual(['moderator', 'user']);
  });

  it('countAdmins serialises demotions: a second caller waits for the first transaction', async () => {
    const [locked, release] = [gate(), gate()];
    const first = transaction.run(async () => {
      const admins = await usersRepo.countAdmins();
      locked.open();
      await release.promise;
      return admins;
    });
    await locked.promise;
    const second = transaction.run(() => usersRepo.countAdmins());

    await expect(Promise.race([second, sleep(300)])).resolves.toBe('timeout');
    release.open();
    await expect(first).resolves.toEqual(expect.any(Number));
    await expect(second).resolves.toEqual(expect.any(Number));
  });

  it('drizzle queries are server-side prepared statements (DATABASE_PREPARE=true)', async () => {
    const single = await NestFactory.createApplicationContext(SingleConnectionModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const repo = single.get(DrizzleUsersRepository);
      const singleDb = single.get<DrizzleDB<IdentitySchema>>(DRIZZLE);
      const user = register(email('prepared'));
      await usersRepo.insert(user);

      await repo.findById(user.id);
      await repo.findByIds([user.id, generateId()]);
      await repo.findByIds([user.id]);
      // One connection: this sees the statements the calls above prepared on it.
      const statements = await singleDb.execute<{ statement: string }>(sql`
        select statement from pg_prepared_statements where not from_sql`);
      const texts = statements.map((row) => row.statement);
      expect(texts).toEqual(
        expect.arrayContaining([expect.stringMatching(/"identity"\."users"\."id" = \$1/)]),
      );
      // Every batch size reuses ONE statement (`= any($1::uuid[])`), not one per `IN` arity.
      expect(texts.filter((text) => text.includes('any($1::uuid[])'))).toHaveLength(1);
    } finally {
      await single.close();
    }
  });

  it('search uses the pg_trgm GIN index (users_search_trgm_idx)', async () => {
    const [index] = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where schemaname = 'identity' and indexname = 'users_search_trgm_idx'`);
    expect(index?.indexdef).toMatch(/USING gin \(email gin_trgm_ops, display_name gin_trgm_ops\)/);

    const plan = await db.transaction(async (tx) => {
      // A handful of rows: force the planner off the sequential/PK scans it would rightly pick.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_indexscan = off`);
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select id from identity.users
        where email ilike '%zzq%' or display_name ilike '%zzq%'
        order by id desc limit 21`);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('Bitmap Index Scan on users_search_trgm_idx');
  });

  it('the DB defaults (uuidv7 id, roles) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; roles: string }>(sql`
      insert into identity.users (email, password_hash, display_name)
      values (${email('raw')}, 'x', 'Raw Insert') returning id, roles::text`);
    expect(isUuidV7(row?.id)).toBe(true);
    expect(row?.roles).toBe('{user}');
  });

  it('sessions: FK to users with ON DELETE CASCADE, rotation is compare-and-set', async () => {
    const user = register(email('sessions'));
    await usersRepo.insert(user);
    const now = new Date();
    const session = {
      id: generateId(),
      userId: user.id,
      refreshTokenHash: sha256Hex('refresh-token'),
      userAgent: 'vitest',
      ip: '127.0.0.1',
      expiresAt: new Date(now.getTime() + 60_000),
    };
    await sessionsRepo.create(session);

    const rotate = {
      id: session.id,
      userId: user.id,
      refreshTokenHash: session.refreshTokenHash,
      replacedById: generateId(),
      now,
    };
    await expect(sessionsRepo.revokeForRotation(rotate)).resolves.toBe(true);
    // A second rotation of the same token loses (reuse detection hinges on this).
    await expect(sessionsRepo.revokeForRotation(rotate)).resolves.toBe(false);

    // Orphan sessions are rejected by the FK...
    await expect(
      sessionsRepo.create({ ...session, id: generateId(), userId: generateId() }),
    ).rejects.toThrow();
    // ...and deleting the user cascades.
    await db.execute(sql`delete from identity.users where id = ${user.id}`);
    await expect(sessionsRepo.findById(session.id)).resolves.toBeNull();
  });

  // Last: it replaces the context (and the repositories) the tests above share.
  it('a second boot of the same wiring against the same database applies nothing', async () => {
    const before = await bookkeeping();
    // A restart: the first context and its pool are gone before the second one boots.
    const first = app;
    app = undefined; // afterAll then closes only what is open, even if the boot below throws
    await first?.close();
    // Rejects, failing this test, if the restart re-ran a migration (`CREATE TYPE` again).
    app = await boot();
    db = app.get(DRIZZLE);
    await expect(bookkeeping()).resolves.toEqual(before);
  });
});
