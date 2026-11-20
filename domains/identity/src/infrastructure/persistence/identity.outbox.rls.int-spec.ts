import type { LoggerService } from '@nestjs/common';
import { generateId, SystemContext } from '@platform/common';
import {
  buildRlsContextSql,
  runMigrations,
  SystemDatabase,
  withPlatformMigrations,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityOutboxSystemRepository } from './drizzle-outbox.system-repository.js';
import { identityMigrations } from './identity.migrations.js';
import { identitySchema } from './identity.schema.js';

/*
 * identity.outbox (0000_init, outbox plan Task 5) on Citus 14.2, single node, local execution off
 * (startRlsTestPostgres): distributed by tenant_id and colocated with app.tenant_colocation, RLS
 * enabled and forced, insert-only for app_runtime (its own tenant's rows), poll, mark and purge for
 * app_system. The real identity migration set runs as app_owner; every runtime case is raw
 * postgres.js on app_runtime in its own transaction opened with buildRlsContextSql (the adapter's
 * exact SET LOCAL string); the system repository runs on the app_system pool inside SystemContext.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int identity.outbox.rls
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const id = (suffix: string): string => `0197c000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
const USER_A = id('1a1');
const TOPIC = 'identity.user-registered.v1';

interface SqlFailure {
  readonly code: string | undefined;
  readonly message: string;
}

/** How `work` fails, or undefined when it succeeds. */
async function failure(work: Promise<unknown>): Promise<SqlFailure | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message };
  }
}

/** The insert policy's refusal (on Citus the message may name the shard: `outbox_<digits>`). */
const RLS_VIOLATION: SqlFailure = {
  code: '42501',
  message: expect.stringMatching(
    /^new row violates row-level security policy (".+" )?for table "outbox(_\d+)?"$/,
  ),
};
/** The missing grant, before any policy runs. */
const PERMISSION_DENIED: SqlFailure = {
  code: '42501',
  message: expect.stringMatching(/^permission denied for table outbox(_\d+)?$/),
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity.outbox on Citus, local execution off',
  () => {
    let pg: RlsTestPostgres | undefined;
    let admin: Sql;
    let runtime: Sql;
    let systemClient: Sql;
    let repository: IdentityOutboxSystemRepository;

    const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: () => undefined });

    /** One transaction as app_runtime with the RLS context of `user` in `tenant`. */
    const asRuntime = <T>(
      context: { user: string; tenant: string | null },
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> =>
      runtime.begin(async (tx) => {
        await tx
          .unsafe(buildRlsContextSql({ userId: context.user, tenantId: context.tenant }))
          .simple();
        return work(tx);
      }) as Promise<T>;

    /** A plain INSERT as the writer sends it (no RETURNING: the runtime role cannot read). */
    const insertRow = (tx: TransactionSql, tenantId: string, rowId: string) =>
      tx`insert into identity.outbox (tenant_id, id, topic, key, envelope)
        values (${tenantId}, ${rowId}, ${TOPIC}, ${USER_A}, ${tx.json({ id: rowId, tenantId })})`;

    /** Every outbox row, through the superuser. */
    const rows = () =>
      admin<{ tenant_id: string; id: string; published: boolean }[]>`
        select tenant_id::text, id::text, published_at is not null as published
        from identity.outbox order by id`;

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, {
        migrations: withPlatformMigrations([identityMigrations]),
        logger: silent,
        applicationName: 'identity-outbox-rls-int',
      });
      admin = connect(pg.url);
      runtime = connect(pg.runtimeUrl);
      systemClient = postgres(pg.systemUrl, { max: 2, onnotice: () => undefined });
      repository = new IdentityOutboxSystemRepository(
        new SystemDatabase(
          drizzle({ client: systemClient, schema: identitySchema, casing: 'snake_case' }),
        ),
      );
    }, 360_000);

    afterAll(async () => {
      await systemClient?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('runs as app_runtime with local execution off (as on a cluster)', async () => {
      const [row] = await asRuntime(
        { user: USER_A, tenant: TENANT_A },
        (tx) =>
          tx<{ role: string; local: string }[]>`
            select current_user as role, current_setting('citus.enable_local_execution') as local`,
      );
      expect(row).toEqual({ role: 'app_runtime', local: 'off' });
    });

    it('distributes identity.outbox by tenant_id, colocated with app.tenant_colocation', async () => {
      const distribution = await admin<{ table: string; kind: string; colocation: number }[]>`
        select t.name as "table", app.citus_table_kind(t.name::regclass) as kind,
          p.colocationid::int as colocation
        from unnest(${['identity.outbox', 'app.tenant_colocation']}::text[]) as t(name)
        join pg_dist_partition p on p.logicalrelid = t.name::regclass
        order by t.name`;
      const [anchor, outbox] = distribution;
      expect(anchor).toMatchObject({ table: 'app.tenant_colocation', kind: 'hash:tenant_id' });
      expect(outbox).toEqual({
        table: 'identity.outbox',
        kind: 'hash:tenant_id',
        colocation: anchor?.colocation,
      });
      const [column] = await admin<{ column: string }[]>`
        select column_to_column_name(logicalrelid, partkey) as column
        from pg_dist_partition where logicalrelid = 'identity.outbox'::regclass`;
      expect(column?.column).toBe('tenant_id');
    });

    it('enables and forces row-level security', async () => {
      const [row] = await admin<{ enabled: boolean; forced: boolean }[]>`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'identity' and c.relname = 'outbox'`;
      expect(row).toEqual({ enabled: true, forced: true });
    });

    it('grants exactly INSERT to app_runtime and SELECT, INSERT, UPDATE, DELETE to app_system', async () => {
      const grants = await admin<{ grantee: string; privileges: string[] }[]>`
        select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
        from information_schema.role_table_grants
        where table_schema = 'identity' and table_name = 'outbox'
          and grantee in ('app_runtime', 'app_system')
        group by grantee order by grantee`;
      expect(grants).toEqual([
        { grantee: 'app_runtime', privileges: ['INSERT'] },
        { grantee: 'app_system', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
      ]);
    });

    it('has exactly one policy: outbox_insert, FOR INSERT TO app_runtime, tenant_id = app.tenant_id()', async () => {
      // pg_policies deparses the expressions against the search_path: with only pg_catalog on it,
      // every function comes back schema-qualified, as the migration wrote it.
      const policies = await admin.begin(async (tx) => {
        await tx`set local search_path = pg_catalog`;
        return tx<
          { name: string; command: string; roles: string[]; using: string | null; check: string }[]
        >`
          select policyname::text as name, cmd::text as command, roles::text[] as roles,
            qual as using, with_check as check
          from pg_policies where schemaname = 'identity' and tablename = 'outbox'`;
      });
      expect(policies).toEqual([
        {
          name: 'outbox_insert',
          command: 'INSERT',
          roles: ['app_runtime'],
          using: null,
          check: '(tenant_id = app.tenant_id())',
        },
      ]);
    });

    it("a principal of tenant A inserts its own row; B's row and a principal without a tenant are refused", async () => {
      const own = generateId();
      await asRuntime({ user: USER_A, tenant: TENANT_A }, (tx) => insertRow(tx, TENANT_A, own));
      expect(
        await failure(
          asRuntime({ user: USER_A, tenant: TENANT_A }, (tx) =>
            insertRow(tx, TENANT_B, generateId()),
          ),
        ),
      ).toEqual(RLS_VIOLATION);
      const noTenant = await failure(
        asRuntime({ user: USER_A, tenant: null }, (tx) => insertRow(tx, TENANT_A, generateId())),
      );
      expect(noTenant?.code).toBe('42501');
      expect((await rows()).map((row) => [row.tenant_id, row.id])).toEqual([[TENANT_A, own]]);
    });

    it('runtime SELECT, UPDATE and DELETE raise 42501 (no grant), even on its own rows', async () => {
      const context = { user: USER_A, tenant: TENANT_A };
      const attempts = [
        asRuntime(context, (tx) => tx`select id from identity.outbox`),
        asRuntime(
          context,
          (tx) => tx`select count(*) from identity.outbox where tenant_id = ${TENANT_A}`,
        ),
        asRuntime(
          context,
          (tx) => tx`update identity.outbox set published_at = now() where tenant_id = ${TENANT_A}`,
        ),
        asRuntime(context, (tx) => tx`delete from identity.outbox where tenant_id = ${TENANT_A}`),
      ];
      for (const attempt of attempts) expect(await failure(attempt)).toEqual(PERMISSION_DENIED);
      expect((await rows()).every((row) => !row.published)).toBe(true);
    });

    it('the system repository polls the unpublished row and marks it, once', async () => {
      const before = await rows();
      expect(before).toHaveLength(1);
      const [row] = before;

      const poll = await SystemContext.run('identity.outbox-int', () =>
        repository.pollUnpublished(10),
      );
      expect(poll.rows.map((r) => [r.tenantId, r.id, r.topic, r.key])).toEqual([
        [TENANT_A, row?.id, TOPIC, USER_A],
      ]);
      expect(poll.backlog).toBe(1);
      expect(poll.oldestCreatedAt).toBeInstanceOf(Date);

      const marked = await SystemContext.run('identity.outbox-int', () =>
        repository.markPublished(poll.rows),
      );
      expect(marked).toBe(1);
      await expect(
        SystemContext.run('identity.outbox-int', () => repository.markPublished(poll.rows)),
      ).resolves.toBe(0);
      expect((await rows()).map((r) => r.published)).toEqual([true]);
      await expect(
        SystemContext.run('identity.outbox-int', () => repository.pollUnpublished(10)),
      ).resolves.toEqual({ rows: [], backlog: 0, oldestCreatedAt: null });
    });

    it('outside SystemContext the system repository refuses (SYSTEM_CONTEXT_REQUIRED)', async () => {
      await expect(repository.pollUnpublished(1)).rejects.toMatchObject({
        code: 'SYSTEM_CONTEXT_REQUIRED',
      });
    });
  },
);
