import { PLATFORM_TENANT_ID } from '@platform/common';
import {
  buildRlsContextSql,
  platformMigrations,
  RlsContextError,
  runMigrations,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { noop } from 'lodash-es';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { billingMigrations } from './billing.migrations.js';

/*
 * Billing's row-level security (0003_rls, B3-5/B3-6, program spec §8.2) on citusdata/citus:14.2.0
 * with the three roles and local execution off (startRlsTestPostgres): every shard query goes over a
 * remote connection, so a context that did not reach the shards fails here as on a cluster.
 * The real runner applies the platform set and billing's history as app_owner; the fixture is seeded
 * as the superuser; every case runs as raw postgres.js in one transaction opened with
 * buildRlsContextSql (what the adapter sends on BEGIN), plus `SET LOCAL app.elevated = 'on'` where a
 * case is elevated (what elevate() sends). An allowed case asserts the exact rows; a forbidden read
 * asserts none; a forbidden write asserts the RLS error or zero rows, and is committed, so the
 * superuser snapshot after every case proves that nothing changed.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int billing.rls
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };

const TENANT_A = '0197c000-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c000-0000-7000-8000-0000000000b0';
const A1 = '0197c000-0000-7000-8000-00000000a001'; // in tenant A
const A2 = '0197c000-0000-7000-8000-00000000a002'; // in tenant A
const B1 = '0197c000-0000-7000-8000-00000000b001'; // in tenant B

const PAY_A1 = '0197c000-0000-7000-8000-0000000a1001';
const PAY_A2 = '0197c000-0000-7000-8000-0000000a2001';
const PAY_B1 = '0197c000-0000-7000-8000-0000000b1001';
/** A platform-tenant payment that names a1 as its user: matching the user must not be enough. */
const PAY_PLATFORM = '0197c000-0000-7000-8000-0000000f0001';
const NEW_PAYMENT = '0197c000-0000-7000-8000-0000000e0001';

const PAYMENTS = [
  { tenant: TENANT_A, id: PAY_A1, user: A1 },
  { tenant: TENANT_A, id: PAY_A2, user: A2 },
  { tenant: TENANT_B, id: PAY_B1, user: B1 },
  { tenant: PLATFORM_TENANT_ID, id: PAY_PLATFORM, user: A1 },
] as const;
const EVENTS = [
  { tenant: TENANT_A, id: 'evt_a1', user: A1 },
  { tenant: TENANT_A, id: 'evt_a2', user: A2 },
  { tenant: TENANT_B, id: 'evt_b1', user: B1 },
  { tenant: PLATFORM_TENANT_ID, id: 'evt_platform', user: null },
] as const;

interface Context {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly elevated?: boolean;
}

const a1InA: Context = { userId: A1, tenantId: TENANT_A };
const a1InAElevated: Context = { ...a1InA, elevated: true };
const a2InA: Context = { userId: A2, tenantId: TENANT_A };
const b1InB: Context = { userId: B1, tenantId: TENANT_B };
const b1InBElevated: Context = { ...b1InB, elevated: true };

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

/** A forbidden write: the RLS error (`new row violates row-level security policy …`). */
const RLS_VIOLATION = expect.objectContaining({
  code: '42501',
  message: expect.stringContaining('row-level security'),
});
/** No privilege on the table at all. */
const NO_PRIVILEGE = expect.objectContaining({
  code: '42501',
  message: expect.stringContaining('permission denied for table'),
});

class Rollback extends Error {}

const connect = (url: string): Sql => postgres(url, { max: 1, onnotice: noop });

/**
 * Runs `work` in one transaction on `client`, after `prelude` (the RLS context). Rolled back unless
 * `commit`: forbidden writes commit, so a write that slipped through would show in the snapshot.
 */
async function inTransaction<T>(
  client: Sql,
  prelude: (tx: TransactionSql) => Promise<void>,
  work: (tx: TransactionSql) => Promise<T>,
  commit: boolean,
): Promise<T> {
  let result: T | undefined;
  try {
    await client.begin(async (tx) => {
      await prelude(tx);
      result = await work(tx);
      if (!commit) throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

/** No SET LOCAL at all: the connection's defaults (every app.* setting unset). */
const noContext = (): Promise<void> => Promise.resolve();

/** The context as the adapter sends it on BEGIN, then elevation as elevate() sends it. */
async function applyContext(tx: TransactionSql, context: Context): Promise<void> {
  await tx.unsafe(buildRlsContextSql(context)).simple();
  if (context.elevated) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing RLS on Citus 14.2 (app_runtime, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let owner: Sql;
    let runtime: Sql;
    let system: Sql;
    let seeded: unknown[];

    /** Both tables, every column, in a fixed order, as the superuser sees them. */
    const snapshot = async (): Promise<unknown[]> => [
      ...(await admin`select * from billing.payments order by tenant_id, id`),
      ...(await admin`select * from billing.stripe_events order by tenant_id, id`),
    ];

    /** As app_runtime under `context`; rolled back unless `commit`. */
    const as = <T>(
      context: Context,
      work: (tx: TransactionSql) => Promise<T>,
      options: { commit?: boolean } = {},
    ): Promise<T> =>
      inTransaction(runtime, (tx) => applyContext(tx, context), work, options.commit ?? false);

    /** As app_runtime with no context at all (no SET LOCAL); committed. */
    const withoutContext = <T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> =>
      inTransaction(runtime, noContext, work, true);

    /** As `client` without a context; rolled back unless `commit`. */
    const plain = <T>(
      client: Sql,
      work: (tx: TransactionSql) => Promise<T>,
      options: { commit?: boolean } = {},
    ): Promise<T> => inTransaction(client, noContext, work, options.commit ?? false);

    const paymentIds = async (tx: TransactionSql): Promise<string[]> =>
      (await tx<{ id: string }[]>`select id from billing.payments order by id`).map((r) => r.id);
    const eventIds = async (tx: TransactionSql): Promise<string[]> =>
      (await tx<{ id: string }[]>`select id from billing.stripe_events order by id`).map(
        (r) => r.id,
      );

    const insertPayment = (tx: TransactionSql, tenant: string, user: string) =>
      tx`insert into billing.payments (tenant_id, id, user_id, price_id, quantity)
         values (${tenant}, ${NEW_PAYMENT}, ${user}, 'price_rls', 1) returning id`;
    const insertEvent = (tx: TransactionSql, tenant: string, user: string | null) =>
      tx`insert into billing.stripe_events (tenant_id, id, user_id, type)
         values (${tenant}, 'evt_new', ${user}, 't')
         on conflict (tenant_id, id) do nothing returning id`;

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      const summary = await runMigrations(pg.migrationUrl, {
        migrations: [platformMigrations, billingMigrations],
        logger: silent,
      });
      expect(summary.sets.map((set) => set.name)).toEqual(['platform', 'billing']);
      admin = connect(pg.url);
      owner = connect(pg.migrationUrl);
      runtime = connect(pg.runtimeUrl);
      system = connect(pg.systemUrl);
      for (const p of PAYMENTS) {
        await admin`insert into billing.payments (tenant_id, id, user_id, price_id, quantity)
          values (${p.tenant}, ${p.id}, ${p.user}, 'price_rls', 1)`;
      }
      for (const e of EVENTS) {
        await admin`insert into billing.stripe_events (tenant_id, id, user_id, type)
          values (${e.tenant}, ${e.id}, ${e.user}, 't')`;
      }
      seeded = await snapshot();
      expect(seeded).toHaveLength(PAYMENTS.length + EVENTS.length);
    });

    afterEach(async () => {
      // Every forbidden write committed; every allowed one rolled back: nothing ever changes.
      await expect(snapshot()).resolves.toEqual(seeded);
    });

    afterAll(async () => {
      await system?.end({ timeout: 5 });
      await runtime?.end({ timeout: 5 });
      await owner?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    describe('forced RLS and grants (deny by default)', () => {
      it('enables and forces RLS on both tables, and on neither billing.__drizzle_migrations', async () => {
        const rows = await admin<{ name: string; enabled: boolean; forced: boolean }[]>`
          select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'billing'
            and c.relname in ('payments', 'stripe_events', '__drizzle_migrations')
          order by c.relname`;
        expect([...rows]).toEqual([
          { name: '__drizzle_migrations', enabled: false, forced: false },
          { name: 'payments', enabled: true, forced: true },
          { name: 'stripe_events', enabled: true, forced: true },
        ]);
      });

      it('grants app_runtime S, I, U on payments and S, I on stripe_events; app_system S, I, D on stripe_events only', async () => {
        const rows = await admin<{ grantee: string; name: string; privileges: string }[]>`
          select a.grantee::regrole::text as grantee, c.relname as name,
            string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
          from pg_class c join pg_namespace n on n.oid = c.relnamespace,
            aclexplode(c.relacl) a
          where n.nspname = 'billing'
            and c.relname in ('payments', 'stripe_events', '__drizzle_migrations')
            and a.grantee <> c.relowner
          group by 1, 2 order by 1, 2`;
        expect([...rows]).toEqual([
          { grantee: 'app_runtime', name: 'payments', privileges: 'INSERT,SELECT,UPDATE' },
          { grantee: 'app_runtime', name: 'stripe_events', privileges: 'INSERT,SELECT' },
          { grantee: 'app_system', name: 'stripe_events', privileges: 'DELETE,INSERT,SELECT' },
        ]);
      });

      it('has exactly the five app_runtime policies, the outbox and ledger policies, none for any other role', async () => {
        const rows = await admin<{ name: string; command: string; roles: string }[]>`
          select tablename || '.' || policyname as name, cmd as command,
            array_to_string(roles, ',') as roles
          from pg_policies where schemaname = 'billing' order by 1`;
        expect([...rows]).toEqual([
          // 0004_outbox (outbox plan Task 6); billing.outbox.rls.int-spec.ts covers it.
          // 0005_ledger_tables (outbox plan Task 10); billing.ledger.rls.int-spec.ts covers them.
          ...['ledger_accounts', 'ledger_discrepancies', 'ledger_entry_refs'].flatMap((table) => [
            { name: `${table}.${table}_insert`, command: 'INSERT', roles: 'app_runtime' },
            { name: `${table}.${table}_select`, command: 'SELECT', roles: 'app_runtime' },
          ]),
          { name: 'outbox.outbox_insert', command: 'INSERT', roles: 'app_runtime' },
          { name: 'payments.payments_insert', command: 'INSERT', roles: 'app_runtime' },
          { name: 'payments.payments_select', command: 'SELECT', roles: 'app_runtime' },
          { name: 'payments.payments_update', command: 'UPDATE', roles: 'app_runtime' },
          { name: 'stripe_events.stripe_events_insert', command: 'INSERT', roles: 'app_runtime' },
          { name: 'stripe_events.stripe_events_select', command: 'SELECT', roles: 'app_runtime' },
        ]);
      });

      it('app_runtime and app_system cannot read billing.__drizzle_migrations', async () => {
        for (const client of [runtime, system]) {
          expect(
            await failure(plain(client, (tx) => tx`select * from billing.__drizzle_migrations`)),
          ).toEqual(NO_PRIVILEGE);
        }
        expect(
          await failure(as(a1InAElevated, (tx) => tx`select * from billing.__drizzle_migrations`)),
        ).toEqual(NO_PRIVILEGE);
      });

      it('FORCE: app_owner, the table owner, reads zero rows and cannot insert', async () => {
        await expect(plain(owner, paymentIds)).resolves.toEqual([]);
        await expect(plain(owner, eventIds)).resolves.toEqual([]);
        expect(
          await failure(plain(owner, (tx) => insertPayment(tx, TENANT_A, A1), { commit: true })),
        ).toEqual(RLS_VIOLATION);
        expect(
          await failure(plain(owner, (tx) => insertEvent(tx, TENANT_A, A1), { commit: true })),
        ).toEqual(RLS_VIOLATION);
      });
    });

    describe('payments', () => {
      it('a member reads only its own payments in the tenant', async () => {
        await expect(as(a2InA, paymentIds)).resolves.toEqual([PAY_A2]);
        await expect(as(a1InA, paymentIds)).resolves.toEqual([PAY_A1]);
        await expect(as(b1InB, paymentIds)).resolves.toEqual([PAY_B1]);
      });

      it("elevated a1 reads all of A's payments and none of B's", async () => {
        await expect(as(a1InAElevated, paymentIds)).resolves.toEqual([PAY_A1, PAY_A2]);
        await expect(
          as(
            a1InAElevated,
            (tx) => tx`select id from billing.payments where tenant_id = ${TENANT_B}`,
          ),
        ).resolves.toHaveLength(0);
        await expect(as(b1InBElevated, paymentIds)).resolves.toEqual([PAY_B1]);
      });

      it('a tenant-less principal reads no payment, elevated or not', async () => {
        await expect(as({ userId: A1, tenantId: null }, paymentIds)).resolves.toEqual([]);
        await expect(
          as({ userId: A1, tenantId: null, elevated: true }, paymentIds),
        ).resolves.toEqual([]);
      });

      it('the owner updates its own payment', async () => {
        const updated = await as(
          a2InA,
          (tx) => tx`update billing.payments set quantity = 2
            where tenant_id = ${TENANT_A} and id = ${PAY_A2} returning id`,
        );
        expect(updated.map((row) => row.id)).toEqual([PAY_A2]);
      });

      it("elevated a1 cannot update a2's payment, nor b1 a payment of A", async () => {
        const viaA1 = await as(
          a1InAElevated,
          (tx) => tx`update billing.payments set quantity = 9
            where tenant_id = ${TENANT_A} and id = ${PAY_A2}`,
          { commit: true },
        );
        expect(viaA1.count).toBe(0);
        const viaB1 = await as(
          b1InBElevated,
          (tx) => tx`update billing.payments set quantity = 9 where tenant_id = ${TENANT_A}`,
          { commit: true },
        );
        expect(viaB1.count).toBe(0);
      });

      it('an update that hands the payment to another user is rejected', async () => {
        expect(
          await failure(
            as(
              a2InA,
              (tx) => tx`update billing.payments set user_id = ${A1}
                where tenant_id = ${TENANT_A} and id = ${PAY_A2}`,
              { commit: true },
            ),
          ),
        ).toEqual(RLS_VIOLATION);
      });

      it('an update that moves the payment to another tenant is rejected', async () => {
        // Citus refuses to change the distribution column before RLS sees the row: any refusal.
        const moved = await failure(
          as(
            a2InA,
            (tx) => tx`update billing.payments set tenant_id = ${TENANT_B}
              where tenant_id = ${TENANT_A} and id = ${PAY_A2}`,
            { commit: true },
          ),
        );
        expect(moved).toBeDefined();
      });

      it('inserts only for the current tenant and user', async () => {
        const own = await as(a2InA, (tx) => insertPayment(tx, TENANT_A, A2));
        expect(own.map((row) => row.id)).toEqual([NEW_PAYMENT]);
        for (const [tenant, user] of [
          [TENANT_A, A1], // another user of the tenant
          [TENANT_B, A2], // another tenant
          [TENANT_B, B1], // another tenant and user
          [PLATFORM_TENANT_ID, A2], // the platform tenant
        ] as const) {
          expect(
            await failure(as(a2InA, (tx) => insertPayment(tx, tenant, user), { commit: true })),
          ).toEqual(RLS_VIOLATION);
        }
        expect(
          await failure(
            as(a1InAElevated, (tx) => insertPayment(tx, TENANT_A, A2), { commit: true }),
          ),
        ).toEqual(RLS_VIOLATION);
      });

      it('SELECT … FOR UPDATE by (tenant_id, id) locks for the owner and returns nothing for others', async () => {
        const lock = (tx: TransactionSql) =>
          tx<{ id: string }[]>`select id from billing.payments
            where tenant_id = ${TENANT_A} and id = ${PAY_A2} for update`;
        await expect(as(a2InA, lock)).resolves.toEqual([{ id: PAY_A2 }]);
        await expect(as(a1InA, lock)).resolves.toEqual([]);
        // Elevation reads, it never writes: FOR UPDATE also needs the UPDATE policy.
        await expect(as(a1InAElevated, lock)).resolves.toEqual([]);
        await expect(as(b1InBElevated, lock)).resolves.toEqual([]);
      });

      it('nobody deletes a payment: no DELETE grant, elevated or not', async () => {
        for (const context of [a2InA, a1InAElevated]) {
          expect(
            await failure(
              as(
                context,
                (tx) => tx`delete from billing.payments
                  where tenant_id = ${TENANT_A} and id = ${PAY_A2}`,
                { commit: true },
              ),
            ),
          ).toEqual(NO_PRIVILEGE);
        }
      });
    });

    describe('stripe_events', () => {
      it('a member reads only its own events, and elevation does not widen that', async () => {
        await expect(as(a2InA, eventIds)).resolves.toEqual(['evt_a2']);
        await expect(as(a1InA, eventIds)).resolves.toEqual(['evt_a1']);
        await expect(as(a1InAElevated, eventIds)).resolves.toEqual(['evt_a1']);
        await expect(as(b1InBElevated, eventIds)).resolves.toEqual(['evt_b1']);
        await expect(as({ userId: A1, tenantId: null }, eventIds)).resolves.toEqual([]);
      });

      it('records an event for the current tenant and user (markProcessed, once)', async () => {
        const first = await as(a2InA, async (tx) => {
          const inserted = await insertEvent(tx, TENANT_A, A2);
          const replay = await insertEvent(tx, TENANT_A, A2);
          return [inserted.length, replay.length];
        });
        expect(first).toEqual([1, 0]);
      });

      it('rejects an event for another user, another tenant, no user or the platform tenant', async () => {
        for (const [tenant, user] of [
          [TENANT_A, A1],
          [TENANT_B, A2],
          [TENANT_A, null],
          [PLATFORM_TENANT_ID, null],
          [PLATFORM_TENANT_ID, A2],
        ] as const) {
          expect(
            await failure(as(a2InA, (tx) => insertEvent(tx, tenant, user), { commit: true })),
          ).toEqual(RLS_VIOLATION);
        }
      });

      it('UPDATE and DELETE fail with 42501, even elevated and on own rows', async () => {
        for (const context of [a2InA, { ...a2InA, elevated: true }]) {
          expect(
            await failure(
              as(
                context,
                (tx) => tx`update billing.stripe_events set type = 'x'
                  where tenant_id = ${TENANT_A} and id = 'evt_a2'`,
                { commit: true },
              ),
            ),
          ).toEqual(NO_PRIVILEGE);
          expect(
            await failure(
              as(
                context,
                (tx) => tx`delete from billing.stripe_events
                  where tenant_id = ${TENANT_A} and id = 'evt_a2'`,
                { commit: true },
              ),
            ),
          ).toEqual(NO_PRIVILEGE);
        }
      });
    });

    describe('platform rows (PLATFORM_TENANT_ID)', () => {
      it('no runtime principal can carry the platform tenant', () => {
        let refused: unknown;
        try {
          buildRlsContextSql({ userId: A1, tenantId: PLATFORM_TENANT_ID });
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(RlsContextError);
        expect(refused).toMatchObject({ code: 'RLS_PLATFORM_TENANT' });
      });

      it('are invisible to every runtime principal, elevated or not', async () => {
        const contexts: Context[] = [
          a1InA,
          a1InAElevated,
          b1InBElevated,
          { userId: A1, tenantId: null },
          { userId: A1, tenantId: null, elevated: true },
        ];
        for (const context of contexts) {
          await expect(
            as(
              context,
              (
                tx,
              ) => tx`select id::text from billing.payments where tenant_id = ${PLATFORM_TENANT_ID}
                union all
                select id from billing.stripe_events where tenant_id = ${PLATFORM_TENANT_ID}`,
            ),
          ).resolves.toHaveLength(0);
        }
      });

      it('app_system reads every stripe_events row, platform rows included, and can insert and purge', async () => {
        await expect(plain(system, eventIds)).resolves.toEqual([
          'evt_a1',
          'evt_a2',
          'evt_b1',
          'evt_platform',
        ]);
        const changed = await plain(system, async (tx) => {
          const inserted = await insertEvent(tx, PLATFORM_TENANT_ID, null);
          const purged = await tx`delete from billing.stripe_events`;
          return [inserted.length, purged.count];
        });
        expect(changed).toEqual([1, EVENTS.length + 1]);
      });

      it('app_system has no grant on payments, and cannot update stripe_events', async () => {
        expect(await failure(plain(system, paymentIds))).toEqual(NO_PRIVILEGE);
        expect(
          await failure(
            plain(system, (tx) => insertPayment(tx, PLATFORM_TENANT_ID, A1), { commit: true }),
          ),
        ).toEqual(NO_PRIVILEGE);
        expect(
          await failure(
            plain(system, (tx) => tx`update billing.stripe_events set type = 'x'`, {
              commit: true,
            }),
          ),
        ).toEqual(NO_PRIVILEGE);
      });
    });

    describe('no context', () => {
      /** Zero rows, or the 42501 `app.user_id is not set` raise: both deny. */
      const denied = async (
        work: (tx: TransactionSql) => PromiseLike<readonly unknown[]>,
      ): Promise<void> => {
        let rows: unknown[] = [];
        const failed = await failure(
          withoutContext(async (tx) => {
            rows = [...(await work(tx))];
          }),
        );
        if (failed === undefined) expect(rows).toEqual([]);
        else expect(failed).toEqual({ code: '42501', message: 'app.user_id is not set' });
      };

      it('returns no row of either table', async () => {
        await denied(paymentIds);
        await denied(eventIds);
      });

      it('changes no row', async () => {
        await denied((tx) => tx`update billing.payments set quantity = 9 returning id`);
        expect(await failure(withoutContext((tx) => insertPayment(tx, TENANT_A, A1)))).toEqual(
          expect.objectContaining({ code: '42501' }),
        );
        expect(await failure(withoutContext((tx) => insertEvent(tx, TENANT_A, A1)))).toEqual(
          expect.objectContaining({ code: '42501' }),
        );
      });
    });
  },
);
