import type { LoggerService } from '@nestjs/common';
import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { buildRlsContextSql, runMigrations, withPlatformMigrations } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingMigrations } from './billing.migrations.js';

/*
 * The five ledger tables (0005_ledger_tables, outbox plan Task 10, "Ledger tables") on Citus 14.2,
 * single node, local execution off (startRlsTestPostgres): ledger_accounts, ledger_entry_refs and
 * ledger_discrepancies distributed by tenant_id and colocated with app.tenant_colocation;
 * ledger_reconciliation_runs and ledger_trusted_state coordinator-local and system-only. All five
 * have forced RLS and no FK. The runtime role inserts its own tenant's rows and reads them only when
 * elevated; refs and discrepancies are append-only for both application roles. The real billing
 * migration set runs as app_owner; every runtime case is raw postgres.js on app_runtime in its own
 * transaction opened with buildRlsContextSql (plus app.elevated = 'on' where a case is elevated);
 * platform rows and the local tables' rows go through the app_system pool.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int billing.ledger.rls
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const id = (suffix: string): string => `0197c310-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
const USER_A1 = id('1a1');
const USER_B1 = id('1b1');

const TENANT_TABLES = ['ledger_accounts', 'ledger_entry_refs', 'ledger_discrepancies'] as const;
const LOCAL_TABLES = ['ledger_reconciliation_runs', 'ledger_trusted_state'] as const;
const ALL_TABLES = [...TENANT_TABLES, ...LOCAL_TABLES] as const;
type TenantTable = (typeof TENANT_TABLES)[number];
type LocalTable = (typeof LOCAL_TABLES)[number];

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

/** A policy's refusal (on Citus the message may name the shard: `<table>_<digits>`). */
const rlsViolation = (table: string): SqlFailure => ({
  code: '42501',
  message: expect.stringMatching(
    new RegExp(`^new row violates row-level security policy (".+" )?for table "${table}(_\\d+)?"$`),
  ),
});
/** The missing grant, before any policy runs. */
const permissionDenied = (table: string): SqlFailure => ({
  code: '42501',
  message: expect.stringMatching(new RegExp(`^permission denied for table ${table}(_\\d+)?$`)),
});

interface RuntimeContext {
  readonly user: string;
  readonly tenant: string | null;
  readonly elevated?: boolean;
}

/** One plain INSERT of a fresh row of `table` for `tenantId` (no RETURNING: as the runtime sends it). */
const insertInto: Record<TenantTable, (tx: TransactionSql, tenantId: string) => Promise<unknown>> =
  {
    ledger_accounts: (tx, tenantId) =>
      tx`insert into billing.ledger_accounts (tenant_id, code, currency, immudb_account_id)
        values (${tenantId}, ${`cash:${generateId()}`}, 'usd', ${generateId()})`,
    ledger_entry_refs: (tx, tenantId) =>
      tx`insert into billing.ledger_entry_refs
          (tenant_id, entry_id, source_key, payload_hash, immudb_tx_id, payment_id, kind, posted_at)
        values (${tenantId}, ${generateId()}, ${`stripe:txn:${generateId()}`}, 'hash', 7, null,
          'charge', now())`,
    ledger_discrepancies: (tx, tenantId) =>
      tx`insert into billing.ledger_discrepancies
          (tenant_id, id, kind, source_key, expected, actual, detected_by, run_id, resolves_id)
        values (${tenantId}, ${generateId()}, 'missing_entry', 'stripe:txn:x',
          ${tx.json({ amount: '100' })}, ${tx.json({ amount: null })}, 'R3', null, null)`,
  };

/** One plain INSERT of a fresh row of a coordinator-local table. */
const insertLocal: Record<LocalTable, (tx: TransactionSql, key: string) => Promise<unknown>> = {
  ledger_reconciliation_runs: (tx, key) =>
    tx`insert into billing.ledger_reconciliation_runs (id, from_ts, to_ts, status, counts)
      values (${key}, now() - interval '1 hour', now(), 'running', ${tx.json({})})`,
  ledger_trusted_state: (tx, key) =>
    tx`insert into billing.ledger_trusted_state (database, tx_id, tx_hash, verified_at)
      values (${key}, 1, ${Buffer.from('00ff', 'hex')}, now())`,
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing ledger tables (0005_ledger_tables) on Citus, local execution off',
  () => {
    let pg: RlsTestPostgres | undefined;
    let admin: Sql;
    let runtime: Sql;
    let system: Sql;

    const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: () => undefined });

    /** One transaction as app_runtime with the RLS context of `user` in `tenant`. */
    const asRuntime = <T>(
      context: RuntimeContext,
      work: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> =>
      runtime.begin(async (tx) => {
        await tx
          .unsafe(buildRlsContextSql({ userId: context.user, tenantId: context.tenant }))
          .simple();
        if (context.elevated === true) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
        return work(tx);
      }) as Promise<T>;

    /** One transaction as app_system (BYPASSRLS), as the system repositories run. */
    const asSystem = <T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> =>
      system.begin(work) as Promise<T>;

    /** The tenant of every row of `table` that `tx` can read, sorted. */
    const tenantsVisible = async (tx: TransactionSql, table: string): Promise<string[]> =>
      (await tx.unsafe<{ tenant_id: string }[]>(`select tenant_id::text from billing.${table}`))
        .map((row) => row.tenant_id)
        .toSorted();

    /** Every row of `table`, through the superuser (a snapshot that proves nothing changed). */
    const snapshot = async (table: string): Promise<unknown[]> =>
      [...(await admin.unsafe(`select * from billing.${table}`))]
        .map((row) => JSON.stringify(row))
        .toSorted();

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, {
        migrations: withPlatformMigrations([billingMigrations]),
        logger: silent,
        applicationName: 'billing-ledger-rls-int',
      });
      admin = connect(pg.url);
      runtime = connect(pg.runtimeUrl);
      system = connect(pg.systemUrl);
    }, 360_000);

    afterAll(async () => {
      await system?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('runs as app_runtime with local execution off (as on a cluster)', async () => {
      const [row] = await asRuntime(
        { user: USER_A1, tenant: TENANT_A },
        (tx) =>
          tx<{ role: string; local: string }[]>`
            select current_user as role, current_setting('citus.enable_local_execution') as local`,
      );
      expect(row).toEqual({ role: 'app_runtime', local: 'off' });
    });

    describe('shape', () => {
      it('pg_dist_partition lists the three tenant tables by tenant_id, colocated with app.tenant_colocation, and neither local table', async () => {
        const names = ['app.tenant_colocation', ...ALL_TABLES.map((table) => `billing.${table}`)];
        const kinds = await admin<{ table: string; kind: string; colocation: number | null }[]>`
          select t.name as "table", app.citus_table_kind(t.name::regclass) as kind,
            p.colocationid::int as colocation
          from unnest(${names}::text[]) with ordinality as t(name, position)
          left join pg_dist_partition p on p.logicalrelid = t.name::regclass
          order by t.position`;
        const [anchor, ...ledger] = kinds;
        expect(anchor).toMatchObject({ table: 'app.tenant_colocation', kind: 'hash:tenant_id' });
        expect(anchor?.colocation).toEqual(expect.any(Number));
        expect(ledger).toEqual([
          ...TENANT_TABLES.map((table) => ({
            table: `billing.${table}`,
            kind: 'hash:tenant_id',
            colocation: anchor?.colocation,
          })),
          ...LOCAL_TABLES.map((table) => ({
            table: `billing.${table}`,
            kind: 'local',
            colocation: null,
          })),
        ]);
      });

      it('all five have RLS enabled and forced, and no foreign key', async () => {
        const tables = await admin<
          { table: string; enabled: boolean; forced: boolean; fks: number }[]
        >`
          select c.relname::text as "table", c.relrowsecurity as enabled,
            c.relforcerowsecurity as forced,
            (select count(*)::int from pg_constraint k
              where k.contype = 'f' and (k.conrelid = c.oid or k.confrelid = c.oid)) as fks
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'billing' and c.relname like 'ledger\\_%' and c.relkind = 'r'
          order by c.relname`;
        expect([...tables]).toEqual(
          [...ALL_TABLES]
            .toSorted()
            .map((table) => ({ table, enabled: true, forced: true, fks: 0 })),
        );
      });

      it("grants exactly the contract's privileges: S, I / S, I on tenant tables; none / S, I, U on local ones", async () => {
        const grants = await admin<{ table: string; grantee: string; privileges: string }[]>`
          select table_name::text as "table", grantee::text,
            string_agg(privilege_type::text, ',' order by privilege_type) as privileges
          from information_schema.role_table_grants
          where table_schema = 'billing' and table_name like 'ledger\\_%'
            and grantee in ('app_runtime', 'app_system', 'PUBLIC')
          group by table_name, grantee order by table_name, grantee`;
        expect([...grants]).toEqual([
          { table: 'ledger_accounts', grantee: 'app_runtime', privileges: 'INSERT,SELECT' },
          { table: 'ledger_accounts', grantee: 'app_system', privileges: 'INSERT,SELECT' },
          { table: 'ledger_discrepancies', grantee: 'app_runtime', privileges: 'INSERT,SELECT' },
          { table: 'ledger_discrepancies', grantee: 'app_system', privileges: 'INSERT,SELECT' },
          { table: 'ledger_entry_refs', grantee: 'app_runtime', privileges: 'INSERT,SELECT' },
          { table: 'ledger_entry_refs', grantee: 'app_system', privileges: 'INSERT,SELECT' },
          {
            table: 'ledger_reconciliation_runs',
            grantee: 'app_system',
            privileges: 'INSERT,SELECT,UPDATE',
          },
          {
            table: 'ledger_trusted_state',
            grantee: 'app_system',
            privileges: 'INSERT,SELECT,UPDATE',
          },
        ]);
      });

      it('has exactly <table>_select and <table>_insert TO app_runtime on each tenant table, and no policy on the local ones', async () => {
        // pg_policies deparses the expressions against the search_path: with only pg_catalog on it,
        // every function comes back schema-qualified, as the migration wrote it.
        const policies = await admin.begin(async (tx) => {
          await tx`set local search_path = pg_catalog`;
          return tx<
            {
              table: string;
              name: string;
              command: string;
              roles: string[];
              using: string | null;
              check: string | null;
            }[]
          >`
            select tablename::text as "table", policyname::text as name, cmd::text as command,
              roles::text[] as roles, qual as using, with_check as check
            from pg_policies where schemaname = 'billing' and tablename like 'ledger\\_%'
            order by tablename, policyname`;
        });
        expect([...policies]).toEqual(
          [...TENANT_TABLES].toSorted().flatMap((table) => [
            {
              table,
              name: `${table}_insert`,
              command: 'INSERT',
              roles: ['app_runtime'],
              using: null,
              check: '(tenant_id = app.tenant_id())',
            },
            {
              table,
              name: `${table}_select`,
              command: 'SELECT',
              roles: ['app_runtime'],
              using: '((tenant_id = app.tenant_id()) AND app.elevated())',
              check: null,
            },
          ]),
        );
      });
    });

    describe.each(TENANT_TABLES)('%s (tenant table), both paths', (table) => {
      const insert = insertInto[table];

      beforeAll(async () => {
        // B's row as b1 in tenant B, and a platform row through the system pool.
        await asRuntime({ user: USER_B1, tenant: TENANT_B }, (tx) => insert(tx, TENANT_B));
        await asSystem((tx) => insert(tx, PLATFORM_TENANT_ID));
      });

      it("a1 inserts an own-tenant row without elevation; B's row and the nil tenant's are rejected", async () => {
        await asRuntime({ user: USER_A1, tenant: TENANT_A }, (tx) => insert(tx, TENANT_A));
        const before = await snapshot(table);
        for (const elevated of [false, true]) {
          const context = { user: USER_A1, tenant: TENANT_A, elevated };
          expect(await failure(asRuntime(context, (tx) => insert(tx, TENANT_B)))).toEqual(
            rlsViolation(table),
          );
          expect(await failure(asRuntime(context, (tx) => insert(tx, PLATFORM_TENANT_ID)))).toEqual(
            rlsViolation(table),
          );
        }
        // A principal without a tenant writes no row at all.
        const noTenant = await failure(
          asRuntime({ user: USER_A1, tenant: null }, (tx) => insert(tx, TENANT_A)),
        );
        expect(noTenant?.code).toBe('42501');
        expect(await snapshot(table)).toEqual(before);
      });

      it("SELECT returns nothing without elevation, A's rows with it, never B's or the platform's", async () => {
        const plain = await asRuntime({ user: USER_A1, tenant: TENANT_A }, (tx) =>
          tenantsVisible(tx, table),
        );
        expect(plain).toEqual([]);
        // Even a filter on the own tenant (the router path) reads nothing without elevation.
        const routed = await asRuntime(
          { user: USER_A1, tenant: TENANT_A },
          (tx) =>
            tx.unsafe(`select 1 from billing.${table} where tenant_id = $1`, [TENANT_A]) as Promise<
              unknown[]
            >,
        );
        expect([...routed]).toEqual([]);

        const elevated = await asRuntime(
          { user: USER_A1, tenant: TENANT_A, elevated: true },
          (tx) => tenantsVisible(tx, table),
        );
        expect(elevated).toEqual([TENANT_A]);
        for (const other of [TENANT_B, PLATFORM_TENANT_ID]) {
          const routedOther = await asRuntime(
            { user: USER_A1, tenant: TENANT_A, elevated: true },
            (tx) =>
              tx.unsafe(`select 1 from billing.${table} where tenant_id = $1`, [other]) as Promise<
                unknown[]
              >,
          );
          expect([...routedOther]).toEqual([]);
        }
        // The rows are there: the system role reads every tenant's, the platform's included.
        expect(await asSystem((tx) => tenantsVisible(tx, table))).toEqual(
          [PLATFORM_TENANT_ID, TENANT_A, TENANT_B].toSorted(),
        );
      });

      it('UPDATE and DELETE raise 42501 for the runtime role, elevated or not, and for app_system', async () => {
        const before = await snapshot(table);
        const attempts: [string, () => Promise<unknown>][] = [];
        for (const elevated of [false, true]) {
          const context = { user: USER_A1, tenant: TENANT_A, elevated };
          attempts.push(
            [
              `runtime update (elevated: ${elevated})`,
              () =>
                asRuntime(context, (tx) =>
                  tx.unsafe(`update billing.${table} set created_at = now() where tenant_id = $1`, [
                    TENANT_A,
                  ]),
                ),
            ],
            [
              `runtime delete (elevated: ${elevated})`,
              () =>
                asRuntime(context, (tx) =>
                  tx.unsafe(`delete from billing.${table} where tenant_id = $1`, [TENANT_A]),
                ),
            ],
          );
        }
        attempts.push(
          [
            'system update',
            () =>
              asSystem((tx) =>
                tx.unsafe(`update billing.${table} set created_at = now() where tenant_id = $1`, [
                  TENANT_A,
                ]),
              ),
          ],
          [
            'system delete',
            () =>
              asSystem((tx) =>
                tx.unsafe(`delete from billing.${table} where tenant_id = $1`, [TENANT_A]),
              ),
          ],
        );
        for (const [label, attempt] of attempts) {
          expect(await failure(attempt()), label).toEqual(permissionDenied(table));
        }
        expect(await snapshot(table)).toEqual(before);
      });
    });

    describe.each(LOCAL_TABLES)('%s (coordinator-local, system only)', (table) => {
      it('runtime SELECT and INSERT raise 42501, elevated or not', async () => {
        for (const elevated of [false, true]) {
          const context = { user: USER_A1, tenant: TENANT_A, elevated };
          expect(
            await failure(asRuntime(context, (tx) => tx.unsafe(`select * from billing.${table}`))),
          ).toEqual(permissionDenied(table));
          expect(
            await failure(asRuntime(context, (tx) => insertLocal[table](tx, generateId()))),
          ).toEqual(permissionDenied(table));
        }
        expect(await snapshot(table)).toEqual([]);
      });

      it('the system role inserts, reads and updates its rows', async () => {
        const key = generateId();
        await asSystem((tx) => insertLocal[table](tx, key));
        const keyColumn = table === 'ledger_trusted_state' ? 'database' : 'id';
        const updated = await asSystem((tx) =>
          tx.unsafe(`update billing.${table} set created_at = now() where ${keyColumn} = $1`, [
            key,
          ]),
        );
        expect(updated.count).toBe(1);
        const rows = await asSystem((tx) =>
          tx.unsafe<{ key: string }[]>(
            `select ${keyColumn}::text as key from billing.${table} where ${keyColumn} = $1`,
            [key],
          ),
        );
        expect([...rows]).toEqual([{ key }]);
      });
    });

    it('ledger_trusted_state keeps tx_id as int8 and tx_hash as bytea', async () => {
      const database = `db-${generateId()}`;
      await asSystem(
        (tx) =>
          tx`insert into billing.ledger_trusted_state (database, tx_id, tx_hash, verified_at)
            values (${database}, ${'9007199254740993'}, ${Buffer.from('deadbeef', 'hex')}, now())`,
      );
      const [row] = await asSystem(
        (tx) =>
          tx<{ txId: string; txHash: Buffer }[]>`
            select tx_id::text as "txId", tx_hash as "txHash"
            from billing.ledger_trusted_state where database = ${database}`,
      );
      expect(row?.txId).toBe('9007199254740993');
      expect(Buffer.from(row?.txHash ?? []).toString('hex')).toBe('deadbeef');
    });

    it('probe for Task 11: as non-elevated a1, INSERT … ON CONFLICT DO NOTHING (no target, no RETURNING) on ledger_entry_refs reports 1 row, then 0', async () => {
      const entryId = generateId();
      const insertRef = (tx: TransactionSql) =>
        tx`insert into billing.ledger_entry_refs
            (tenant_id, entry_id, source_key, payload_hash, immudb_tx_id, payment_id, kind, posted_at)
          values (${TENANT_A}, ${entryId}, 'stripe:txn:probe', 'hash', null, null, 'charge', now())
          on conflict do nothing`;
      const context = { user: USER_A1, tenant: TENANT_A };
      const first = await asRuntime(context, insertRef);
      const second = await asRuntime(context, insertRef);
      expect([first.count, second.count]).toEqual([1, 0]);
      const stored = await admin<{ n: number }[]>`
        select count(*)::int as n from billing.ledger_entry_refs
        where tenant_id = ${TENANT_A} and entry_id = ${entryId}`;
      expect(stored[0]?.n).toBe(1);
    });

    it('with no context nothing is readable, even with app.elevated on', async () => {
      for (const elevated of [false, true]) {
        const rows = await runtime.begin(async (tx) => {
          if (elevated) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
          const visible: string[] = [];
          for (const table of TENANT_TABLES) visible.push(...(await tenantsVisible(tx, table)));
          return visible;
        });
        expect(rows).toEqual([]);
      }
    });
  },
);
