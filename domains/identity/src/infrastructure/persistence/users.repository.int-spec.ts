import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  createPrincipal,
  generateId,
  isUuidV7,
  runWithPrincipal,
  SystemContext,
  sha256Hex,
} from '@platform/common';
import { AppConfigModule } from '@platform/config';
import {
  type DatabaseMigrationSet,
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  platformMigrations,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { DrizzleUsersSystemRepository } from './drizzle-users.system-repository.js';
import { identityMigrations } from './identity.migrations.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';

/*
 * DrizzleUsersRepository / DrizzleUsersSystemRepository / DrizzleSessionsRepository against a real
 * PostgreSQL 18, through the real DatabaseModule, which applies the platform set and identity's REAL
 * generated history (./migrations, schema `identity`) at boot as app_owner, like identity-service,
 * and then runs as app_runtime (runtime pool) and app_system (system pool). Every runtime call runs
 * as a principal; catalog checks, seeding and the "what is really there" reads use the superuser.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project identity:int
 * The container is Citus 14.2 on PostgreSQL 18, single node, local execution off
 * (startRlsTestPostgres). Rows use unique emails/search tokens, so reruns do not collide.
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
  providers: [
    DrizzleUsersRepository,
    DrizzleUsersSystemRepository,
    DrizzleSessionsRepository,
    DrizzleTransactionRunner,
  ],
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

const register = (email: string, displayName = 'Integration User'): UserAggregate =>
  UserAggregate.register({
    id: generateId(),
    email,
    displayName,
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    now: new Date(),
    personalTenantId: generateId(),
  });

describe.skipIf(process.env['INTEGRATION'] !== '1')('identity persistence on PostgreSQL 18', () => {
  let pg: RlsTestPostgres | undefined;
  let app: INestApplicationContext | undefined;
  /** The superuser: catalog checks, seeding and raw reads (never the app's pools). */
  let adminClient: Sql | undefined;
  let db: DrizzleDB<IdentitySchema>;
  let usersRepo: DrizzleUsersRepository;
  let usersSystem: DrizzleUsersSystemRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  const run = generateId().slice(-12);
  const email = (name: string): string => `${name}.${run}@example.com`;
  /** `work` as `userId` (in `tenantId`): one runtime unit of work per repository call. */
  const as = <T>(userId: string, work: () => Promise<T>, tenantId: string | null = null) =>
    runWithPrincipal(createPrincipal({ userId, tenantId }), work);
  const directory = <T>(work: () => Promise<T>): Promise<T> =>
    SystemContext.run('identity.user-directory', work);
  /** A user inserted through the runtime repository, as itself (`users_insert`). */
  const insertUser = (user: UserAggregate): Promise<void> =>
    as(user.id, () => usersRepo.insert(user));

  /** Bookkeeping rows of the platform set (schema `app`) and of identity's set. */
  const bookkeeping = async (): Promise<{ app: number; identity: number }> => {
    const [counts] = await db.execute<{ app: number; identity: number }>(sql`
      select (select count(*)::int from app.__drizzle_migrations) as app,
        (select count(*)::int from identity.__drizzle_migrations) as identity`);
    return { app: counts?.app ?? -1, identity: counts?.identity ?? -1 };
  };

  beforeAll(async () => {
    pg = await startRlsTestPostgres();
    vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
    vi.stubEnv('DATABASE_MIGRATION_URL', pg.migrationUrl);
    vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
    vi.stubEnv('SERVICE_NAME', 'identity-int');
    adminClient = postgres(pg.url, { max: 2, onnotice: () => undefined });
    db = drizzle({ client: adminClient, schema: identitySchema, casing: 'snake_case' });
    app = await boot();
    usersRepo = app.get(DrizzleUsersRepository);
    usersSystem = app.get(DrizzleUsersSystemRepository);
    sessionsRepo = app.get(DrizzleSessionsRepository);
  }, 360_000);

  afterAll(async () => {
    await app?.close();
    await adminClient?.end({ timeout: 5 });
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
      'identity.audit_events',
      'identity.invitations',
      'identity.memberships',
      // identity.outbox (the outbox plan, Task 5).
      'identity.outbox',
      'identity.sessions',
      'identity.tenants',
      'identity.users',
    ]);
    const enums = await db.execute<{ name: string }>(sql`
      select n.nspname || '.' || t.typname as name
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typname in ('user_role', 'tenant_role', 'payment_status') and n.nspname <> 'public'`);
    expect(enums.map((row) => row.name)).toEqual(['identity.tenant_role']);
    const [trgm] = await db.execute<{ schema: string }>(sql`
      select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_trgm'`);
    expect(trgm?.schema).toBe('public');
  });

  it('puts no table and no user_role type in public', async () => {
    // The platform set's pg_trgm puts functions, operators and types in public, never tables.
    // The migrator runs as `app_owner`: an unqualified table or enum would land in public.
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

  it('insert → findById (no hash, as itself) / findCredentialsByEmail (hash) / existsByEmail (system)', async () => {
    const user = register(email('ada'), 'Ada Lovelace');
    await insertUser(user);

    const record = await as(user.id, () => usersRepo.findById(user.id));
    expect(record).toMatchObject({
      id: user.id,
      email: email('ada'),
      isPlatformStaff: false,
    });
    expect(record).not.toHaveProperty('passwordHash');
    expect(record?.createdAt).toBeInstanceOf(Date);

    // pre-auth system methods: no principal needed.
    const credentials = await usersSystem.findCredentialsByEmail(email('ada'));
    expect(credentials?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(usersSystem.existsByEmail(email('ada'))).resolves.toBe(true);
    await expect(usersSystem.existsByEmail(email('nobody'))).resolves.toBe(false);
    await expect(as(user.id, () => usersRepo.findById(generateId()))).resolves.toBeNull();
  });

  it('maps the users_email_unique violation to EmailAlreadyTakenException', async () => {
    await insertUser(register(email('dup')));
    await expect(insertUser(register(email('dup')))).rejects.toBeInstanceOf(
      EmailAlreadyTakenException,
    );
  });

  it('findByIds: one query, unknown ids omitted, other users hidden (row-local)', async () => {
    const [a, b] = [register(email('batch-a')), register(email('batch-b'))];
    await insertUser(a);
    await insertUser(b);
    const found = await as(a.id, () => usersRepo.findByIds([a.id, generateId(), b.id]));
    expect(found.map((row) => row.id)).toEqual([a.id]);
    const foundByB = await as(b.id, () => usersRepo.findByIds([a.id, b.id]));
    expect(foundByB.map((row) => row.id)).toEqual([b.id]);
    await expect(as(a.id, () => usersRepo.findByIds([]))).resolves.toEqual([]);
  });

  it('listInTenant (system): keyset pages newest first, search is a literal ILIKE', async () => {
    const token = `kst${run}`;
    const [tenant] = await db.execute<{ id: string }>(
      sql`insert into identity.tenants (slug, name) values (${`dir-k-${run}`}, 'K') returning id`,
    );
    const tenantId = tenant?.id ?? '';
    const created: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      const user = register(email(`${token}-${name}`), `Keyset ${name}`);
      await insertUser(user);
      await db.execute(
        sql`insert into identity.memberships (tenant_id, user_id, roles) values (${tenantId}, ${user.id}, '{member}')`,
      );
      created.push(user.id);
    }
    const first = await directory(() =>
      usersSystem.listInTenant({ tenantId, limit: 2, search: token.toUpperCase() }),
    );
    expect(first.items.map((row) => row.id)).toEqual([created[2], created[1]]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await directory(() =>
      usersSystem.listInTenant({
        tenantId,
        limit: 2,
        search: token,
        cursor: first.nextCursor ?? '',
      }),
    );
    expect(second.items.map((row) => row.id)).toEqual([created[0]]);
    expect(second.nextCursor).toBeNull();

    // `%` is escaped: it must not act as a wildcard.
    await expect(
      directory(() => usersSystem.listInTenant({ tenantId, limit: 5, search: `${token}%` })),
    ).resolves.toMatchObject({ items: [] });
  });

  it('listInTenant, findByIdInTenant and findByIdsInTenant (system) see only the members of the asserted tenant', async () => {
    const [tenantA] = await db.execute<{ id: string }>(
      sql`insert into identity.tenants (slug, name) values (${`dir-a-${run}`}, 'A') returning id`,
    );
    const [tenantB] = await db.execute<{ id: string }>(
      sql`insert into identity.tenants (slug, name) values (${`dir-b-${run}`}, 'B') returning id`,
    );
    const inA = register(email('dir-a'));
    const inB = register(email('dir-b'));
    await insertUser(inA);
    await insertUser(inB);
    await db.execute(sql`insert into identity.memberships (tenant_id, user_id, roles) values
      (${tenantA?.id}, ${inA.id}, '{member}'), (${tenantB?.id}, ${inB.id}, '{owner}')`);

    const page = await directory(() =>
      usersSystem.listInTenant({ tenantId: tenantA?.id ?? '', limit: 50 }),
    );
    expect(page.items.map((user) => user.id)).toEqual([inA.id]);
    await expect(
      directory(() => usersSystem.findByIdInTenant(inA.id, tenantA?.id ?? '')),
    ).resolves.toMatchObject({ id: inA.id });
    await expect(
      directory(() => usersSystem.findByIdInTenant(inB.id, tenantA?.id ?? '')),
    ).resolves.toBeNull();
    const batch = await directory(() =>
      usersSystem.findByIdsInTenant([inB.id, inA.id, generateId()], tenantA?.id ?? ''),
    );
    expect(batch.map((user) => user.id)).toEqual([inA.id]);
    expect(batch[0]).not.toHaveProperty('passwordHash');
  });

  it('isPlatformStaff: false by default, true once flagged, false for an unknown id', async () => {
    const user = register(email('staff'));
    await insertUser(user);
    const self = <T>(work: () => Promise<T>) => as(user.id, work);
    await expect(self(() => usersRepo.isPlatformStaff(user.id))).resolves.toBe(false);
    await db.execute(sql`update identity.users set is_platform_staff = true where id = ${user.id}`);
    await expect(self(() => usersRepo.isPlatformStaff(user.id))).resolves.toBe(true);
    await expect(self(() => usersRepo.findById(user.id))).resolves.toMatchObject({
      isPlatformStaff: true,
    });
    await expect(
      self(() => usersRepo.isPlatformStaff('0190f3b2-0000-7000-8000-00000000dead')),
    ).resolves.toBe(false);
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
      await insertUser(user);

      await as(user.id, () => repo.findById(user.id));
      await as(user.id, () => repo.findByIds([user.id, generateId()]));
      await as(user.id, () => repo.findByIds([user.id]));
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
      // users is a Citus reference table: the plan is the shard's, so the settings must reach it.
      await tx.execute(sql`set local citus.propagate_set_commands = 'local'`);
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

  it('the DB defaults (uuidv7 id, is_platform_staff false) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; is_platform_staff: boolean }>(sql`
      insert into identity.users (email, password_hash, display_name)
      values (${email('raw')}, 'x', 'Raw Insert') returning id, is_platform_staff`);
    expect(isUuidV7(row?.id)).toBe(true);
    expect(row?.is_platform_staff).toBe(false);
  });

  it('sessions: FK to users with ON DELETE CASCADE, rotation is compare-and-set', async () => {
    const user = register(email('sessions'));
    await insertUser(user);
    const now = new Date();
    const [tenant] = await db.execute<{ id: string }>(
      sql`insert into identity.tenants (slug, name) values (${`s-${run}`}, 'S') returning id`,
    );
    const inTenant = <T>(userId: string, work: () => Promise<T>) =>
      as(userId, work, tenant?.id ?? null);
    const session = {
      id: generateId(),
      userId: user.id,
      tenantId: tenant?.id ?? '',
      refreshTokenHash: sha256Hex('refresh-token'),
      userAgent: 'vitest',
      ip: '127.0.0.1',
      expiresAt: new Date(now.getTime() + 60_000),
    };
    await inTenant(user.id, () => sessionsRepo.create(session));

    const rotate = {
      id: session.id,
      userId: user.id,
      refreshTokenHash: session.refreshTokenHash,
      replacedById: generateId(),
      now,
    };
    await expect(inTenant(user.id, () => sessionsRepo.revokeForRotation(rotate))).resolves.toBe(
      true,
    );
    // A second rotation of the same token loses (reuse detection hinges on this).
    await expect(inTenant(user.id, () => sessionsRepo.revokeForRotation(rotate))).resolves.toBe(
      false,
    );

    // Orphan sessions are rejected by the FK (the policy lets the orphan's own principal try)...
    const orphan = generateId();
    await expect(
      inTenant(orphan, () => sessionsRepo.create({ ...session, id: generateId(), userId: orphan })),
    ).rejects.toThrow();
    // ...and deleting the user cascades.
    await db.execute(sql`delete from identity.users where id = ${user.id}`);
    const [left] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from identity.sessions where id = ${session.id}`,
    );
    expect(left?.n).toBe(0);
    await expect(
      inTenant(user.id, () => sessionsRepo.findById(user.id, session.id)),
    ).resolves.toBeNull();
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
    await expect(bookkeeping()).resolves.toEqual(before);
  });
});
