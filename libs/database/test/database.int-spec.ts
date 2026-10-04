import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateId, isUuidV7 } from '@app/common';
import { AppConfigModule } from '@app/config';
import { type INestApplicationContext, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { noop, sumBy } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseHealthIndicator,
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetWhere,
  MIGRATIONS_ADVISORY_LOCK_ID,
  runMigrations,
} from '../src/index.js';
import { type NewWidget, type Widget, widgets } from './fixtures/widgets.schema.js';

/*
 * Real Postgres 18 (uuidv7() is PG18-native) via testcontainers. Opt-in:
 *   INTEGRATION=1 bunx vitest run --project database:int
 */

const IMAGE = 'postgres:18.6-alpine3.24';
const PACKAGE_ROOT = join(import.meta.dirname, '..');
const FIXTURE_MIGRATIONS = join(import.meta.dirname, 'fixtures', 'migrations');
const schema = { widgets };
type Adapter = DrizzleTransactionalAdapter<typeof schema>;

const execFileAsync = promisify(execFile);
const silent = { log: noop, warn: noop, error: noop, debug: noop };

@Injectable()
class WidgetsRepository {
  constructor(private readonly txHost: TransactionHost<Adapter>) {}

  async insert(row: NewWidget): Promise<Widget> {
    const [created] = await this.txHost.tx.insert(widgets).values(row).returning();
    if (created === undefined) throw new Error('insert returned no row');
    return created;
  }

  countFor(ownerId: string): Promise<number> {
    return this.txHost.tx.$count(widgets, eq(widgets.ownerId, ownerId));
  }

  async page(ownerId: string, limit: number, cursor?: string | null) {
    const rows = await this.txHost.tx
      .select()
      .from(widgets)
      .where(and(eq(widgets.ownerId, ownerId), keysetWhere(widgets.id, cursor)))
      .orderBy(keysetOrder(widgets.id))
      .limit(keysetFetchLimit(limit));
    return keysetPage(rows, limit);
  }
}

@Injectable()
class WidgetsService {
  constructor(
    private readonly repo: WidgetsRepository,
    private readonly txHost: TransactionHost<Adapter>,
  ) {}

  /** All-or-nothing: throws after `failAfter` inserts when given. */
  @Transactional()
  async createMany(ownerId: string, names: string[], failAfter?: number): Promise<void> {
    for (const [index, name] of names.entries()) {
      if (index === failAfter) throw new Error('business rule violated');
      await this.repo.insert({ ownerId, name });
    }
  }

  isolationInsideSerializable(): Promise<string | undefined> {
    return this.txHost.withTransaction({ isolationLevel: 'serializable' }, async () => {
      const rows = await this.txHost.tx.execute<{ transaction_isolation: string }>(
        sql`show transaction_isolation`,
      );
      return rows[0]?.transaction_isolation;
    });
  }
}

describe('@app/database against PostgreSQL 18', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Sql;
  const urlFor = (database: string): string => {
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${database}`;
    return url.toString();
  };
  const createDatabase = async (name: string): Promise<string> => {
    await admin.unsafe(`create database ${name}`);
    return urlFor(name);
  };
  const migrationRows = async (url: string): Promise<number> => {
    const client = postgres(url, { max: 1, onnotice: noop });
    try {
      const [row] = await client<{ count: number }[]>`
        select count(*)::int as count from public.__drizzle_migrations`;
      return row?.count ?? -1;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('app')
      .withUsername('app')
      .withPassword('app')
      .start();
    admin = postgres(container.getConnectionUri(), { max: 1, onnotice: noop });
  });

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await container?.stop();
  });

  describe('runMigrations()', () => {
    it('applies each migration exactly once when replicas race, then releases the lock', async () => {
      const url = await createDatabase('race');
      const runs = await Promise.all(
        [1, 2, 3].map(() =>
          runMigrations(url, {
            migrationsFolder: FIXTURE_MIGRATIONS,
            lockPollIntervalMs: 50,
            logger: silent,
          }),
        ),
      );
      expect(sumBy(runs, 'applied')).toBe(2);
      expect(runs.every((run) => run.total === 2)).toBe(true);
      expect(await migrationRows(url)).toBe(2);
      const [locks] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_locks
        where locktype = 'advisory' and objid = ${MIGRATIONS_ADVISORY_LOCK_ID}`;
      expect(locks?.count).toBe(0);

      const rerun = await runMigrations(url, {
        migrationsFolder: FIXTURE_MIGRATIONS,
        logger: silent,
      });
      expect(rerun).toMatchObject({ applied: 0, total: 2 });
    });
  });

  describe('migrate.ts CLI', () => {
    const cli = (url: string, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [
          '--conditions=@app/source',
          '--import',
          '@swc-node/register/esm-register',
          'src/migrate.ts',
          ...args,
        ],
        { cwd: PACKAGE_ROOT, env: { ...process.env, DATABASE_URL: url }, timeout: 90_000 },
      );

    it('migrates a database and exits 0; a second run is a no-op', async () => {
      const url = await createDatabase('cli');
      const first = await cli(url, '--migrations-folder', 'test/fixtures/migrations');
      expect(first.stdout).toContain('Done: 2 applied, 2 total');
      const second = await cli(url, '--migrations-folder', 'test/fixtures/migrations');
      expect(second.stdout).toContain('Done: 0 applied, 2 total');
      expect(await migrationRows(url)).toBe(2);
    });

    it('exits 1 with the config error for an invalid DATABASE_URL', async () => {
      await expect(cli('mysql://nope')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_URL') as unknown,
      });
    });
  });

  describe('DatabaseModule (booted Nest application context)', () => {
    let app: INestApplicationContext;
    let db: DrizzleDB<typeof schema>;
    let service: WidgetsService;
    let repo: WidgetsRepository;

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', await createDatabase('boot'));
      vi.stubEnv('SERVICE_NAME', 'db-int');

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({
            schema,
            runMigrations: true,
            migrationsFolder: FIXTURE_MIGRATIONS,
          }),
        ],
        providers: [WidgetsRepository, WidgetsService],
      })
      class IntegrationModule {}

      app = await NestFactory.createApplicationContext(IntegrationModule, { logger: false });
      db = app.get(DRIZZLE);
      service = app.get(WidgetsService);
      repo = app.get(WidgetsRepository);
    });

    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('applied the migrations at boot, before the pool served queries', async () => {
      const rows = await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_name = 'widgets' order by ordinal_position`);
      expect(rows.map((row) => row.column_name)).toEqual([
        'id',
        'owner_id',
        'name',
        'quantity',
        'created_at',
        'sku',
      ]);
    });

    it('sends the startup GUCs (application_name, timeouts, UTC)', async () => {
      const [row] = await db.$client<Record<string, string>[]>`
        select current_setting('application_name') as app,
               current_setting('statement_timeout') as statement_timeout,
               current_setting('idle_in_transaction_session_timeout') as idle_tx,
               current_setting('TimeZone') as tz`;
      expect(row).toEqual({ app: 'db-int', statement_timeout: '15s', idle_tx: '1min', tz: 'UTC' });
    });

    it('generates uuidv7 ids in the database (PG18 default)', async () => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into widgets (owner_id, name) values (${generateId()}, 'db-default') returning id`);
      expect(isUuidV7(row?.id)).toBe(true);
    });

    it('@Transactional() commits all statements together', async () => {
      const ownerId = generateId();
      await service.createMany(ownerId, ['a', 'b', 'c']);
      expect(await repo.countFor(ownerId)).toBe(3);
    });

    it('@Transactional() rolls back every statement when the method throws', async () => {
      const ownerId = generateId();
      await expect(service.createMany(ownerId, ['x', 'y', 'z'], 2)).rejects.toThrow(
        'business rule violated',
      );
      expect(await repo.countFor(ownerId)).toBe(0);
    });

    it('applies per-call transaction options', async () => {
      await expect(service.isolationInsideSerializable()).resolves.toBe('serializable');
    });

    it('why the adapter normalizes options: drizzle renders {} as an invalid SET TRANSACTION', async () => {
      // drizzle wraps it as "Failed query: set transaction"; the cause is 42601 syntax_error.
      await expect(db.transaction(async () => undefined, {})).rejects.toMatchObject({
        message: expect.stringContaining('set transaction') as unknown,
        cause: { code: '42601' },
      });
    });

    it('pages newest-first with uuidv7 keyset cursors until nextCursor is null', async () => {
      const ownerId = generateId();
      // App-side uuidv7 (monotonic within the process) → insertion order = id order.
      for (const name of ['w1', 'w2', 'w3', 'w4', 'w5']) {
        await repo.insert({ id: generateId(), ownerId, name });
      }
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const page = await repo.page(ownerId, 2, cursor);
        pages.push(page.items.map((item) => item.name));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(pages).toEqual([['w5', 'w4'], ['w3', 'w2'], ['w1']]);
    });

    it('reports the pool healthy', async () => {
      await expect(app.get(DatabaseHealthIndicator).check()).resolves.toMatchObject({
        postgres: { status: 'up' },
      });
    });

    it('drains the pool on shutdown', async () => {
      await app.close();
      await expect(db.$client`select 1`).rejects.toThrow();
    });
  });
});
