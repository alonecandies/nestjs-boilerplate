import { generateId, isUuidV7, sha256Hex } from '@app/common';
import { AppConfigModule } from '@app/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@app/database';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';

/*
 * DrizzleUsersRepository / DrizzleSessionsRepository against a real PostgreSQL 18, through the
 * real DatabaseModule, which applies the REAL generated migrations (@app/database
 * src/migrations) at boot. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project identity:int
 * Set INTEGRATION_DATABASE_URL to use an existing throwaway database instead of testcontainers.
 * Rows use unique emails/search tokens, so reruns against the same database do not collide.
 */

const IMAGE = 'postgres:18.6-alpine3.24';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    DatabaseModule.forRootAsync({ schema: identitySchema, runMigrations: true }),
  ],
  providers: [DrizzleUsersRepository, DrizzleSessionsRepository],
})
class IdentityPersistenceModule {}

const register = (email: string, displayName = 'Integration User'): UserAggregate =>
  UserAggregate.register({
    id: generateId(),
    email,
    displayName,
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    now: new Date(),
  });

describe.skipIf(process.env['INTEGRATION'] !== '1')('identity persistence on PostgreSQL 18', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplicationContext;
  let db: DrizzleDB<IdentitySchema>;
  let usersRepo: DrizzleUsersRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  const run = generateId().slice(-12);
  const email = (name: string): string => `${name}.${run}@example.com`;

  beforeAll(async () => {
    let url = process.env['INTEGRATION_DATABASE_URL'];
    if (url === undefined) {
      container = await new PostgreSqlContainer(IMAGE)
        .withDatabase('app')
        .withUsername('app')
        .withPassword('app')
        .start();
      url = container.getConnectionUri();
    }
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('SERVICE_NAME', 'identity-int');
    app = await NestFactory.createApplicationContext(IdentityPersistenceModule, { logger: false });
    db = app.get(DRIZZLE);
    usersRepo = app.get(DrizzleUsersRepository);
    sessionsRepo = app.get(DrizzleSessionsRepository);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('boot applied the initial migration (identity + billing tables, enums)', async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['users', 'sessions', 'payments', 'stripe_events']),
    );
    const enums = await db.execute<{ typname: string }>(sql`
      select typname from pg_type where typname in ('user_role', 'payment_status') order by 1`);
    expect(enums.map((row) => row.typname)).toEqual(['payment_status', 'user_role']);
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

  it('the DB defaults (uuidv7 id, roles) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; roles: string }>(sql`
      insert into users (email, password_hash, display_name)
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
    await db.execute(sql`delete from users where id = ${user.id}`);
    await expect(sessionsRepo.findById(session.id)).resolves.toBeNull();
  });
});
