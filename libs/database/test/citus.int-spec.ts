import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformMigrations, runMigrations } from '../src/index.js';
import { catalogMigrations } from './fixtures/fixture-sets.js';

/*
 * The platform set's Citus helpers (0001_citus_helpers.sql) and the runner's sequential mode on
 * citusdata/citus:14.2.0 (single node, 4 shards). Database `app` has the citus extension; database
 * `plain`, created here, has not, so it behaves as plain Postgres. The tests build on each other in
 * file order. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project database:int
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const HELPER_TABLES = [
  'app.tenant_colocation',
  'helpers.regions',
  'helpers.orders',
  'helpers.shipments',
  'helpers.devices',
  'helpers.alerts',
];
const CREATE_HELPER_TABLES = `
  create schema helpers;
  create table helpers.regions (id uuid primary key);
  create table helpers.orders (tenant_id uuid not null, id uuid not null, primary key (tenant_id, id));
  create table helpers.shipments (tenant_id uuid not null, id uuid not null, primary key (tenant_id, id));
  create table helpers.devices (user_id uuid not null, id uuid not null, primary key (user_id, id));
  create table helpers.alerts (user_id uuid not null, id uuid not null, primary key (user_id, id));`;

interface Placement {
  kind: string;
  colocation: number;
  shards: number;
}

describe('Citus helpers and sequential migrations on Citus 14.2 (single node)', () => {
  let pg: TestPostgres;
  let citus: Sql;
  let plain: Sql;
  let plainUrl: string;

  const call = (sql: Sql, helper: string, table: string) =>
    sql.unsafe(`select app.${helper}('${table}')`);

  /** The calls a domain's distribute migration makes, in its order. */
  const distributeAll = async (sql: Sql): Promise<void> => {
    await call(sql, 'make_reference', 'helpers.regions');
    await call(sql, 'distribute_by_tenant', 'helpers.orders');
    await call(sql, 'distribute_by_tenant', 'helpers.shipments');
    await call(sql, 'distribute_by_user', 'helpers.devices');
    await call(sql, 'distribute_by_user', 'helpers.alerts');
  };

  /** How Citus placed `table`, or undefined when it is not a Citus table. */
  const placement = async (table: string): Promise<Placement | undefined> => {
    const [row] = await citus<Placement[]>`
      select case when p.partmethod = 'h'
                    then 'hash:' || column_to_column_name(p.logicalrelid, p.partkey)
                  when p.repmodel = 't' then 'reference' else 'other' end as kind,
        p.colocationid::int as colocation,
        (select count(*)::int from pg_dist_shard s where s.logicalrelid = p.logicalrelid) as shards
      from pg_dist_partition p where p.logicalrelid = ${table}::regclass`;
    return row;
  };

  const foreignKeys = async (sql: Sql): Promise<string[]> => {
    const rows = await sql<{ name: string }[]>`
      select conname as name from pg_constraint
      where conrelid = 'catalog.order_lines'::regclass and contype = 'f' order by conname`;
    return rows.map((row) => row.name);
  };

  beforeAll(async () => {
    pg = await startTestPostgres({ allowExternalUrl: false });
    citus = postgres(pg.url, { max: 1, onnotice: noop });
    await citus`create database plain`;
    const url = new URL(pg.url);
    url.pathname = '/plain';
    plainUrl = url.toString();
    plain = postgres(plainUrl, { max: 1, onnotice: noop });
    for (const target of [pg.url, plainUrl]) {
      await runMigrations(target, { migrations: [platformMigrations], logger: silent });
    }
    await citus.unsafe(CREATE_HELPER_TABLES).simple();
    await plain.unsafe(CREATE_HELPER_TABLES).simple();
  });

  afterAll(async () => {
    await plain?.end({ timeout: 5 });
    await citus?.end({ timeout: 5 });
    await pg?.stop();
  });

  it('app.citus_enabled() is true only in the database that has the citus extension', async () => {
    const [onCitus] = await citus<{ enabled: boolean }[]>`select app.citus_enabled() as enabled`;
    const [onPlain] = await plain<{ enabled: boolean }[]>`select app.citus_enabled() as enabled`;
    expect(onCitus?.enabled).toBe(true);
    expect(onPlain?.enabled).toBe(false);
  });

  it('places reference, tenant and user tables; every tenant table joins the anchor group', async () => {
    await distributeAll(citus);
    const anchor = await placement('app.tenant_colocation');
    expect(anchor).toEqual({
      kind: 'hash:tenant_id',
      colocation: expect.any(Number),
      shards: 4,
    });
    expect(await placement('helpers.regions')).toMatchObject({ kind: 'reference', shards: 1 });
    for (const table of ['helpers.orders', 'helpers.shipments']) {
      expect(await placement(table)).toEqual({
        kind: 'hash:tenant_id',
        colocation: anchor?.colocation,
        shards: 4,
      });
    }
    const devices = await placement('helpers.devices');
    expect(devices).toMatchObject({ kind: 'hash:user_id', shards: 4 });
    expect(devices?.colocation).not.toBe(anchor?.colocation);
    expect(await placement('helpers.alerts')).toEqual(devices);
  });

  it('is idempotent: running every helper again changes nothing', async () => {
    const before = await Promise.all(HELPER_TABLES.map((table) => placement(table)));
    await distributeAll(citus);
    const after = await Promise.all(HELPER_TABLES.map((table) => placement(table)));
    expect(after).toEqual(before);
  });

  it('refuses to turn a Citus table of one kind into another', async () => {
    await expect(call(citus, 'make_reference', 'helpers.orders')).rejects.toThrow(
      /already distributed \(hash:tenant_id\)/,
    );
    await expect(call(citus, 'distribute_by_tenant', 'helpers.regions')).rejects.toThrow(
      /another kind \(reference\)/,
    );
    await expect(call(citus, 'distribute_by_tenant', 'helpers.devices')).rejects.toThrow(
      /another kind \(hash:user_id\)/,
    );
    await expect(call(citus, 'distribute_by_user', 'helpers.orders')).rejects.toThrow(
      /another kind \(hash:tenant_id\)/,
    );
  });

  it('is a no-op on plain Postgres: the tables stay ordinary tables', async () => {
    await distributeAll(plain);
    await distributeAll(plain);
    const [row] = await plain<{ citus: number; partition: string | null }[]>`
      select (select count(*)::int from pg_extension where extname = 'citus') as citus,
        to_regclass('pg_catalog.pg_dist_partition')::text as partition`;
    expect(row).toEqual({ citus: 0, partition: null });
    await plain`insert into helpers.orders (tenant_id, id) values (uuidv7(), uuidv7())`;
    const [count] = await plain<{ count: number }[]>`
      select count(*)::int as count from helpers.orders`;
    expect(count?.count).toBe(1);
  });

  it('rejects a misspelt table even on plain Postgres (the regclass cast runs first)', async () => {
    await expect(call(plain, 'make_reference', 'helpers.nope')).rejects.toThrow(
      /relation "helpers\.nope" does not exist/,
    );
  });

  describe('runMigrations()', () => {
    it('creates an enum, distributes tables and adds their foreign keys in one transaction, even when sessions default to remote execution', async () => {
      // Like a startTestPostgres({ localExecution: false }) server: new sessions of role app start
      // with local execution off. The runner turns it back on for its own session; without that,
      // the shard connection cannot see catalog.order_status, created in the same transaction.
      await citus`alter role app in database app set citus.enable_local_execution = off`;
      const summary = await runMigrations(pg.url, {
        migrations: [platformMigrations, catalogMigrations],
        logger: silent,
      }).finally(async () => {
        await citus`alter role app in database app reset citus.enable_local_execution`;
      });
      expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
        { name: 'platform', applied: 0 },
        { name: 'catalog', applied: 1 },
      ]);
      const anchor = await placement('app.tenant_colocation');
      expect(await placement('catalog.regions')).toMatchObject({ kind: 'reference' });
      for (const table of ['catalog.orders', 'catalog.order_lines']) {
        expect(await placement(table)).toMatchObject({
          kind: 'hash:tenant_id',
          colocation: anchor?.colocation,
        });
      }
      expect(await foreignKeys(citus)).toEqual([
        'order_lines_order_fk',
        'order_lines_region_id_regions_id_fk',
      ]);
    });

    it('needs sequential mode once shard commands go over connections, as on a cluster', async () => {
      // On one node with local execution on (this container) Citus runs every shard command in
      // this backend, so parallel mode cannot fail here. With local execution off, shard commands
      // go over connections, as they go to workers on a cluster: the fixture's foreign keys then
      // fail after the parallel distribution unless the transaction is sequential. The schema and
      // enum are committed first, because a loopback connection cannot see uncommitted ones.
      const statements = readFileSync(
        join(catalogMigrations.folder, '0000_create_catalog.sql'),
        'utf8',
      ).split('--> statement-breakpoint');
      const applyInOneTransaction = async (schema: string, sequential: boolean): Promise<void> => {
        const renamed = statements.map((statement) =>
          statement.replaceAll('"catalog"', `"${schema}"`).replaceAll("'catalog.", `'${schema}.`),
        );
        const setup = renamed.filter((statement) => /^\s*CREATE (SCHEMA|TYPE)/.test(statement));
        const body = renamed.filter((statement) => !setup.includes(statement));
        for (const statement of setup) await citus.unsafe(statement);
        await citus.begin(async (tx) => {
          await tx`set local citus.enable_local_execution = off`;
          if (sequential) await tx`set local citus.multi_shard_modify_mode = 'sequential'`;
          for (const statement of body) await tx.unsafe(statement);
        });
      };
      await expect(applyInOneTransaction('parallel_probe', false)).rejects.toThrow(
        /because there was a parallel operation on a distributed table in the transaction/,
      );
      await applyInOneTransaction('sequential_probe', true);
      const [row] = await citus<{ parallel: number; sequential: number }[]>`
        select count(*) filter (where logicalrelid::text like 'parallel_probe.%')::int as parallel,
          count(*) filter (where logicalrelid::text like 'sequential_probe.%')::int as sequential
        from pg_dist_partition`;
      expect(row).toEqual({ parallel: 0, sequential: 3 });
    });

    it('applies the same set on plain Postgres, where every table stays local', async () => {
      const summary = await runMigrations(plainUrl, {
        migrations: [platformMigrations, catalogMigrations],
        logger: silent,
      });
      expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
        { name: 'platform', applied: 0 },
        { name: 'catalog', applied: 1 },
      ]);
      expect(await foreignKeys(plain)).toEqual([
        'order_lines_order_fk',
        'order_lines_region_id_regions_id_fk',
      ]);
    });
  });
});
