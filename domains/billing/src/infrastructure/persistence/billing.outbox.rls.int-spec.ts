import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import type { LoggerService } from '@nestjs/common';
import { generateId, PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import {
  buildRlsContextSql,
  type DrizzleTransactionHost,
  runMigrations,
  SystemDatabase,
  withPlatformMigrations,
} from '@platform/database';
import type { OutboxRecord } from '@platform/outbox';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingMigrations } from './billing.migrations.js';
import { billingSchema } from './billing.schema.js';
import { BILLING_OUTBOX, BillingOutbox } from './billing-outbox.js';
import { BillingOutboxSystemRepository } from './drizzle-outbox.system-repository.js';

/*
 * billing.outbox (0004_outbox, outbox plan Task 6) on Citus 14.2, single node, local execution off
 * (startRlsTestPostgres): distributed by tenant_id and colocated with app.tenant_colocation, RLS
 * enabled and forced, insert-only for app_runtime (its own tenant's rows, never the nil tenant),
 * poll, mark, purge and the platform-tenant insert for app_system. The real billing migration set
 * runs as app_owner; every runtime case is raw postgres.js on app_runtime in its own transaction
 * opened with buildRlsContextSql (the adapter's exact SET LOCAL string, plus app.elevated = 'on'
 * where a case is elevated); the system repository runs on the app_system pool inside SystemContext.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int billing.outbox.rls
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const id = (suffix: string): string => `0197c300-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
const USER_A = id('1a1');
const USER_B = id('1b1');
const TOPIC = PAYMENT_SUCCEEDED_EVENT.topic;
const SYSTEM_REASON = 'billing.outbox-int';

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

interface RuntimeContext {
  readonly user: string;
  readonly tenant: string | null;
  readonly elevated?: boolean;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'billing.outbox (0004_outbox) on Citus, local execution off',
  () => {
    let pg: RlsTestPostgres | undefined;
    let admin: Sql;
    let runtime: Sql;
    let systemClient: Sql;
    let repository: BillingOutboxSystemRepository;
    /** Builds records only (`record()` sends no SQL and needs no transaction). */
    const writer = new BillingOutbox(
      BILLING_OUTBOX,
      {} as DrizzleTransactionHost,
      new FakeKafkaProducer({ source: 'billing-int' }),
    );

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

    /** A plain INSERT as the writer sends it (no RETURNING: the runtime role cannot read). */
    const insertRow = (tx: TransactionSql, tenantId: string, rowId: string) =>
      tx`insert into billing.outbox (tenant_id, id, topic, key, envelope)
        values (${tenantId}, ${rowId}, ${TOPIC}, ${USER_A}, ${tx.json({ id: rowId, tenantId })})`;

    /** Every outbox row, through the superuser. */
    const rows = () =>
      admin<{ tenant_id: string; id: string; published_at: Date | null }[]>`
        select tenant_id::text, id::text, published_at from billing.outbox order by id`;

    /** A platform-tenant record of billing.payment-succeeded.v1 (a system job's, no actor). */
    const platformRecord = (): OutboxRecord =>
      writer.record(
        PAYMENT_SUCCEEDED_EVENT,
        {
          paymentId: generateId(),
          userId: USER_A,
          stripeCheckoutSessionId: 'cs_platform',
          amountTotal: 100,
          currency: 'usd',
          paidAt: new Date('2026-11-01T00:00:00.000Z').toISOString(),
        },
        { tenantId: PLATFORM_TENANT_ID, actorId: null, key: USER_A },
      );

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, {
        migrations: withPlatformMigrations([billingMigrations]),
        logger: silent,
        applicationName: 'billing-outbox-rls-int',
      });
      admin = connect(pg.url);
      runtime = connect(pg.runtimeUrl);
      systemClient = postgres(pg.systemUrl, { max: 2, onnotice: () => undefined });
      repository = new BillingOutboxSystemRepository(
        new SystemDatabase(
          drizzle({ client: systemClient, schema: billingSchema, casing: 'snake_case' }),
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

    it('distributes billing.outbox by tenant_id, colocated with app.tenant_colocation', async () => {
      const distribution = await admin<{ table: string; kind: string; colocation: number }[]>`
        select t.name as "table", app.citus_table_kind(t.name::regclass) as kind,
          p.colocationid::int as colocation
        from unnest(${['billing.outbox', 'app.tenant_colocation']}::text[]) as t(name)
        join pg_dist_partition p on p.logicalrelid = t.name::regclass
        order by t.name`;
      const [anchor, outbox] = distribution;
      expect(anchor).toMatchObject({ table: 'app.tenant_colocation', kind: 'hash:tenant_id' });
      expect(outbox).toEqual({
        table: 'billing.outbox',
        kind: 'hash:tenant_id',
        colocation: anchor?.colocation,
      });
      const [column] = await admin<{ column: string }[]>`
        select column_to_column_name(logicalrelid, partkey) as column
        from pg_dist_partition where logicalrelid = 'billing.outbox'::regclass`;
      expect(column?.column).toBe('tenant_id');
    });

    it('enables and forces row-level security', async () => {
      const [row] = await admin<{ enabled: boolean; forced: boolean }[]>`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'billing' and c.relname = 'outbox'`;
      expect(row).toEqual({ enabled: true, forced: true });
    });

    it('grants exactly INSERT to app_runtime and SELECT, INSERT, UPDATE, DELETE to app_system', async () => {
      const grants = await admin<{ grantee: string; privileges: string[] }[]>`
        select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
        from information_schema.role_table_grants
        where table_schema = 'billing' and table_name = 'outbox'
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
          from pg_policies where schemaname = 'billing' and tablename = 'outbox'`;
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

    it("a principal of tenant A inserts its own row; B's row, the nil tenant's and a principal without a tenant are refused", async () => {
      const own = generateId();
      await asRuntime({ user: USER_A, tenant: TENANT_A }, (tx) => insertRow(tx, TENANT_A, own));
      expect(
        await failure(
          asRuntime({ user: USER_A, tenant: TENANT_A }, (tx) =>
            insertRow(tx, TENANT_B, generateId()),
          ),
        ),
      ).toEqual(RLS_VIOLATION);
      // The nil PLATFORM_TENANT_ID is never a runtime tenant: no principal can write its rows,
      // elevated or not (only outbox.insertAsPlatform, on the system pool, can).
      for (const elevated of [false, true]) {
        expect(
          await failure(
            asRuntime({ user: USER_A, tenant: TENANT_A, elevated }, (tx) =>
              insertRow(tx, PLATFORM_TENANT_ID, generateId()),
            ),
          ),
        ).toEqual(RLS_VIOLATION);
      }
      const noTenant = await failure(
        asRuntime({ user: USER_A, tenant: null }, (tx) => insertRow(tx, TENANT_A, generateId())),
      );
      expect(noTenant?.code).toBe('42501');
      const noTenantPlatform = await failure(
        asRuntime({ user: USER_A, tenant: null }, (tx) =>
          insertRow(tx, PLATFORM_TENANT_ID, generateId()),
        ),
      );
      expect(noTenantPlatform?.code).toBe('42501');
      expect((await rows()).map((row) => [row.tenant_id, row.id])).toEqual([[TENANT_A, own]]);
    });

    it('runtime SELECT, UPDATE and DELETE raise 42501 (no grant), even on its own rows', async () => {
      const context = { user: USER_A, tenant: TENANT_A };
      const attempts = [
        asRuntime(context, (tx) => tx`select id from billing.outbox`),
        asRuntime(
          context,
          (tx) => tx`select count(*) from billing.outbox where tenant_id = ${TENANT_A}`,
        ),
        asRuntime(
          context,
          (tx) => tx`update billing.outbox set published_at = now() where tenant_id = ${TENANT_A}`,
        ),
        asRuntime(context, (tx) => tx`delete from billing.outbox where tenant_id = ${TENANT_A}`),
      ];
      for (const attempt of attempts) expect(await failure(attempt)).toEqual(PERMISSION_DENIED);
      expect((await rows()).every((row) => row.published_at === null)).toBe(true);
    });

    it('the system repository polls the unpublished row and marks it, once', async () => {
      const before = await rows();
      expect(before).toHaveLength(1);
      const [row] = before;

      const poll = await SystemContext.run(SYSTEM_REASON, () => repository.pollUnpublished(10));
      expect(poll.rows.map((r) => [r.tenantId, r.id, r.topic, r.key])).toEqual([
        [TENANT_A, row?.id, TOPIC, USER_A],
      ]);
      expect(poll.backlog).toBe(1);
      expect(poll.oldestCreatedAt).toBeInstanceOf(Date);

      const marked = await SystemContext.run(SYSTEM_REASON, () =>
        repository.markPublished(poll.rows),
      );
      expect(marked).toBe(1);
      await expect(
        SystemContext.run(SYSTEM_REASON, () => repository.markPublished(poll.rows)),
      ).resolves.toBe(0);
      expect((await rows()).map((r) => r.published_at !== null)).toEqual([true]);
      await expect(
        SystemContext.run(SYSTEM_REASON, () => repository.pollUnpublished(10)),
      ).resolves.toEqual({ rows: [], backlog: 0, oldestCreatedAt: null });
    });

    describe('outbox.insertAsPlatform: the only way a PLATFORM_TENANT_ID row enters the table', () => {
      let record: OutboxRecord;

      it('inserts a nil-tenant row once (the same id again inserts nothing) and refuses another tenant before SQL', async () => {
        record = platformRecord();
        await expect(
          SystemContext.run(SYSTEM_REASON, () => repository.insertAsPlatform([record])),
        ).resolves.toBe(1);
        await expect(
          SystemContext.run(SYSTEM_REASON, () => repository.insertAsPlatform([record])),
        ).resolves.toBe(0);
        const foreign = { ...platformRecord(), tenantId: TENANT_A };
        await expect(
          SystemContext.run(SYSTEM_REASON, () => repository.insertAsPlatform([foreign])),
        ).rejects.toMatchObject({ code: 'OUTBOX_TENANT_MISMATCH' });
        expect((await rows()).filter((row) => row.tenant_id === PLATFORM_TENANT_ID)).toEqual([
          { tenant_id: PLATFORM_TENANT_ID, id: record.id, published_at: null },
        ]);
        expect((await rows()).some((row) => row.id === foreign.id)).toBe(false);
      });

      it('the row is invisible to and unchangeable by every runtime principal, elevated or not', async () => {
        const before = await rows();
        const contexts: RuntimeContext[] = [
          { user: USER_A, tenant: TENANT_A },
          { user: USER_A, tenant: TENANT_A, elevated: true },
          { user: USER_B, tenant: TENANT_B, elevated: true },
          { user: USER_A, tenant: null },
          { user: USER_A, tenant: null, elevated: true },
        ];
        for (const context of contexts) {
          const attempts = [
            asRuntime(context, (tx) => tx`select id from billing.outbox where id = ${record.id}`),
            asRuntime(
              context,
              (tx) =>
                tx`select count(*) from billing.outbox where tenant_id = ${PLATFORM_TENANT_ID}`,
            ),
            asRuntime(
              context,
              (tx) =>
                tx`update billing.outbox set published_at = now()
                  where tenant_id = ${PLATFORM_TENANT_ID} and id = ${record.id}`,
            ),
            asRuntime(
              context,
              (tx) =>
                tx`delete from billing.outbox
                  where tenant_id = ${PLATFORM_TENANT_ID} and id = ${record.id}`,
            ),
          ];
          for (const attempt of attempts) {
            expect(await failure(attempt), JSON.stringify(context)).toEqual(PERMISSION_DENIED);
          }
        }
        expect(await rows()).toEqual(before);
      });

      it('is returned by the poll and marked by the relay methods', async () => {
        const poll = await SystemContext.run(SYSTEM_REASON, () => repository.pollUnpublished(10));
        expect(poll.rows.map((r) => [r.tenantId, r.id, r.topic])).toEqual([
          [PLATFORM_TENANT_ID, record.id, TOPIC],
        ]);
        expect(poll.rows[0]?.envelope).toMatchObject({
          id: record.id,
          tenantId: PLATFORM_TENANT_ID,
          type: TOPIC,
        });
        expect(poll.backlog).toBe(1);
        await expect(
          SystemContext.run(SYSTEM_REASON, () => repository.markPublished(poll.rows)),
        ).resolves.toBe(1);
      });
    });

    it('outside SystemContext the system repository refuses (SYSTEM_CONTEXT_REQUIRED)', async () => {
      await expect(repository.pollUnpublished(1)).rejects.toMatchObject({
        code: 'SYSTEM_CONTEXT_REQUIRED',
      });
      await expect(repository.insertAsPlatform([platformRecord()])).rejects.toMatchObject({
        code: 'SYSTEM_CONTEXT_REQUIRED',
      });
    });
  },
);
