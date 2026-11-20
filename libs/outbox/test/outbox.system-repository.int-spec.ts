import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  type Principal,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { AppConfigModule } from '@platform/config';
import type { EventEnvelope } from '@platform/contracts';
import {
  DatabaseModule,
  type DrizzleTransaction,
  type DrizzleTransactionHost,
  inUnitOfWork,
  platformMigrations,
  runMigrations,
  SystemDatabaseError,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { eq } from 'drizzle-orm';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxError } from '../src/outbox.errors.js';
import type { OutboxRecord } from '../src/outbox.types.js';
import { OutboxWriter } from '../src/outbox-writer.js';
import {
  CATALOG_UPDATED_EVENT,
  FX_OUTBOX,
  FX_OUTBOX_DDL,
  FxOutboxSystemRepository,
  fxOutbox,
  fxSchema,
  ORDER_PLACED_EVENT,
  orderPlaced,
} from './outbox-fixture.js';

/*
 * The outbox system repository on citusdata/citus:14.2.0 with the three roles and local execution
 * off (startRlsTestPostgres): `fx.outbox` is built from the plan's "Outbox table" SQL as app_owner
 * after the platform migrations; the runtime handle connects as app_runtime, the system handle as
 * app_system (BYPASSRLS), both through DatabaseModule. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project outbox:int
 */

const silent = { log: noop, warn: noop, error: noop, debug: noop };
const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const TENANT_C = '0197a000-0000-7000-8000-0000000000c3';
const REASON = 'fx.outbox-int';

const principalOf = (tenantId: string | null): Principal =>
  createPrincipal({
    userId: generateId(),
    tenantId,
    roles: tenantId === null ? [] : ['member'],
  });

const asSystem = <T>(fn: () => Promise<T>): Promise<T> => SystemContext.run(REASON, fn);

/** The SQLSTATE of `error` or of one of its causes (drizzle wraps the driver's error). */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** How a domain declares its writer (the subclass is its DI token). */
class FxOutbox extends OutboxWriter {}

interface StoredRow {
  tenant_id: string;
  id: string;
  published_at: Date | null;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'OutboxSystemRepository on Citus 14.2 (distributed fx.outbox, local execution off)',
  () => {
    let pg: RlsTestPostgres;
    let admin: Sql;
    let app: INestApplicationContext;
    let txHost: DrizzleTransactionHost;
    let repository: FxOutboxSystemRepository;
    let writer: FxOutbox;

    /** Builds a record (no SQL) the way a domain's writer does. */
    const recordFor = (tenantId: string, eventId?: string): OutboxRecord =>
      tenantId === PLATFORM_TENANT_ID
        ? writer.record(CATALOG_UPDATED_EVENT, { sku: `sku-${generateId()}` }, { tenantId })
        : writer.record(ORDER_PLACED_EVENT, orderPlaced(), {
            tenantId,
            ...(eventId === undefined ? {} : { eventId }),
          });

    /** Seeds rows as the superuser (FORCE RLS filters the owner too), with explicit stamps. */
    const seed = async (
      rows: readonly (OutboxRecord & { createdAt: string; publishedAt?: string | null })[],
    ): Promise<void> => {
      for (const row of rows) {
        await admin`
          insert into fx.outbox (tenant_id, id, topic, key, envelope, created_at, published_at)
          values (${row.tenantId}, ${row.id}, ${row.topic}, ${row.key},
                  ${admin.json(row.envelope as never)}, ${row.createdAt}, ${row.publishedAt ?? null})`;
      }
    };

    const stored = async (): Promise<StoredRow[]> =>
      admin<StoredRow[]>`
        select tenant_id, id, published_at from fx.outbox order by created_at, id`;

    /** `work` as `principal` in one runtime unit of work (BEGIN sends the RLS context). */
    const asRuntime = <T>(
      principal: Principal,
      work: (tx: DrizzleTransaction) => Promise<T>,
    ): Promise<T> => runWithPrincipal(principal, () => inUnitOfWork(txHost, work));

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      await runMigrations(pg.migrationUrl, { migrations: [platformMigrations], logger: silent });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      const owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
      try {
        // One autocommit statement each: with local execution off, Citus creates the shards over
        // new connections, which cannot see a schema that is not committed yet.
        for (const statement of FX_OUTBOX_DDL) await owner.unsafe(statement);
      } finally {
        await owner.end({ timeout: 5 });
      }

      vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
      vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', '2');
      vi.stubEnv('DATABASE_POOL_MAX', '2');
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
      vi.stubEnv('SERVICE_NAME', 'outbox-int');

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({ schema: fxSchema, migrations: [], runMigrations: false }),
        ],
        providers: [FxOutboxSystemRepository],
      })
      class OutboxIntegrationModule {}

      app = await NestFactory.createApplicationContext(OutboxIntegrationModule, { logger: false });
      txHost = app.get(TransactionHost);
      repository = app.get(FxOutboxSystemRepository);
      writer = new FxOutbox(FX_OUTBOX, txHost, new FakeKafkaProducer({ source: 'fx-service' }));
    });

    afterAll(async () => {
      await app?.close();
      await admin?.end({ timeout: 5 });
      await pg?.stop();
      vi.unstubAllEnvs();
    });

    beforeEach(async () => {
      await admin`delete from fx.outbox`;
    });

    it('fx.outbox is hash-distributed by tenant_id, colocated with app.tenant_colocation', async () => {
      const placements = await admin<{ name: string; column: string | null; colocation: number }[]>`
        select n.nspname || '.' || c.relname as name,
               case when p.partmethod = 'h'
                    then column_to_column_name(p.logicalrelid, p.partkey) end as column,
               p.colocationid::int as colocation
          from pg_dist_partition p
          join pg_class c on c.oid = p.logicalrelid
          join pg_namespace n on n.oid = c.relnamespace
         where p.logicalrelid in ('fx.outbox'::regclass, 'app.tenant_colocation'::regclass)
         order by 1`;
      const byName = Object.fromEntries(placements.map((row) => [row.name, row]));
      expect(byName['fx.outbox']).toMatchObject({ column: 'tenant_id' });
      expect(byName['app.tenant_colocation']).toMatchObject({ column: 'tenant_id' });
      expect(byName['fx.outbox']?.colocation).toBe(byName['app.tenant_colocation']?.colocation);
    });

    describe('the runtime role (insert-only, own tenant)', () => {
      it("as tenant A inserts its own row through the writer, in the unit of work's transaction", async () => {
        const envelope = await asRuntime(principalOf(TENANT_A), () =>
          writer.enqueue(ORDER_PLACED_EVENT, orderPlaced()),
        );
        expect(await stored()).toEqual([
          { tenant_id: TENANT_A, id: envelope.id, published_at: null },
        ]);
      });

      it('rejects a row for tenant B, for the nil tenant, and from a principal without a tenant (42501)', async () => {
        const attempts: [Principal, string][] = [
          [principalOf(TENANT_A), TENANT_B],
          [principalOf(TENANT_A), PLATFORM_TENANT_ID],
          [principalOf(null), TENANT_A],
        ];
        const states = [];
        for (const [principal, tenantId] of attempts) {
          const record = recordFor(tenantId);
          const error = await asRuntime(principal, (tx) =>
            tx.insert(fxOutbox).values({
              tenantId,
              id: record.id,
              topic: record.topic,
              key: record.key,
              envelope: record.envelope,
            }),
          ).catch((e: unknown) => e);
          states.push(sqlState(error));
        }
        expect(states).toEqual(['42501', '42501', '42501']);
        expect(await stored()).toEqual([]);
      });

      it('cannot SELECT, UPDATE or DELETE (42501)', async () => {
        const row = recordFor(TENANT_A);
        await seed([{ ...row, createdAt: '2026-09-01T10:00:00.000Z' }]);
        const member = principalOf(TENANT_A);
        const states = [
          await asRuntime(member, (tx) => tx.select().from(fxOutbox)).catch(sqlState),
          await asRuntime(member, (tx) =>
            tx
              .update(fxOutbox)
              .set({ publishedAt: new Date() })
              .where(eq(fxOutbox.tenantId, TENANT_A)),
          ).catch(sqlState),
          await asRuntime(member, (tx) =>
            tx.delete(fxOutbox).where(eq(fxOutbox.tenantId, TENANT_A)),
          ).catch(sqlState),
        ];
        expect(states).toEqual(['42501', '42501', '42501']);
        expect(await stored()).toEqual([{ tenant_id: TENANT_A, id: row.id, published_at: null }]);
      });
    });

    describe('pollUnpublished', () => {
      it('returns the two oldest of five rows over three tenants by (created_at, id), backlog 5 and the oldest created_at', async () => {
        // r2 and r3 share the oldest created_at: the id breaks the tie (r3 has the greater id).
        const [low, high] = [generateId(), generateId()].sort();
        const r1 = recordFor(TENANT_B);
        const r2 = recordFor(TENANT_A, low);
        const r3 = recordFor(TENANT_C, high);
        const r4 = recordFor(TENANT_A);
        const r5 = recordFor(TENANT_C);
        const published = recordFor(TENANT_B);
        await seed([
          {
            ...published,
            createdAt: '2026-09-01T09:00:00.000Z',
            publishedAt: '2026-09-01T09:00:01.000Z',
          },
          { ...r3, createdAt: '2026-09-01T10:00:01.000Z' },
          { ...r1, createdAt: '2026-09-01T10:00:03.000Z' },
          { ...r5, createdAt: '2026-09-01T10:00:04.000Z' },
          { ...r2, createdAt: '2026-09-01T10:00:01.000Z' },
          { ...r4, createdAt: '2026-09-01T10:00:02.000Z' },
        ]);

        const poll = await asSystem(() => repository.pollUnpublished(2));

        expect(poll.rows.map((row) => row.id)).toEqual([r2.id, r3.id]);
        expect(poll.rows[0]).toEqual({
          tenantId: TENANT_A,
          id: r2.id,
          topic: ORDER_PLACED_EVENT.topic,
          key: r2.key,
          envelope: r2.envelope,
          createdAt: new Date('2026-09-01T10:00:01.000Z'),
        });
        expect(poll.backlog).toBe(5);
        expect(poll.oldestCreatedAt).toEqual(new Date('2026-09-01T10:00:01.000Z'));

        const all = await asSystem(() => repository.pollUnpublished(100));
        expect(all.rows.map((row) => row.id)).toEqual([r2.id, r3.id, r4.id, r1.id, r5.id]);
        expect(all.rows.map((row) => row.id)).not.toContain(published.id);
      });

      it('an empty outbox polls no rows, backlog 0 and no oldest row', async () => {
        await expect(asSystem(() => repository.pollUnpublished(10))).resolves.toEqual({
          rows: [],
          backlog: 0,
          oldestCreatedAt: null,
        });
      });

      it('a row the runtime writer stored comes back with its envelope unchanged', async () => {
        const envelope: EventEnvelope<unknown> = await asRuntime(principalOf(TENANT_C), () =>
          writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { key: 'order-key' }),
        );
        const poll = await asSystem(() => repository.pollUnpublished(10));
        expect(poll.rows).toEqual([
          {
            tenantId: TENANT_C,
            id: envelope.id,
            topic: ORDER_PLACED_EVENT.topic,
            key: 'order-key',
            envelope,
            createdAt: expect.any(Date),
          },
        ]);
      });
    });

    describe('markPublished', () => {
      it('stamps only the given pairs and returns their count; again returns 0 and keeps the first stamp', async () => {
        const a = recordFor(TENANT_A);
        const a2 = recordFor(TENANT_A);
        const b = recordFor(TENANT_B);
        const c = recordFor(TENANT_C);
        await seed(
          [a, a2, b, c].map((row, index) => ({
            ...row,
            createdAt: `2026-09-01T10:00:0${index}.000Z`,
          })),
        );

        const pairs = [a, a2, b].map(({ tenantId, id }) => ({ tenantId, id }));
        await expect(asSystem(() => repository.markPublished(pairs))).resolves.toBe(3);
        const first = await stored();
        expect(first.map((row) => [row.id, row.published_at !== null])).toEqual([
          [a.id, true],
          [a2.id, true],
          [b.id, true],
          [c.id, false],
        ]);

        await expect(asSystem(() => repository.markPublished(pairs))).resolves.toBe(0);
        expect(await stored()).toEqual(first);
      });

      it('the right id under the wrong tenant changes nothing', async () => {
        const a = recordFor(TENANT_A);
        await seed([{ ...a, createdAt: '2026-09-01T10:00:00.000Z' }]);
        await expect(
          asSystem(() => repository.markPublished([{ tenantId: TENANT_B, id: a.id }])),
        ).resolves.toBe(0);
        expect(await stored()).toEqual([{ tenant_id: TENANT_A, id: a.id, published_at: null }]);
      });
    });

    describe('insertAsPlatform', () => {
      it('inserts nil-tenant rows that the poll returns, and returns 0 for the same ids again', async () => {
        const platform = [recordFor(PLATFORM_TENANT_ID), recordFor(PLATFORM_TENANT_ID)];
        await expect(asSystem(() => repository.insertAsPlatform(platform))).resolves.toBe(2);
        await expect(asSystem(() => repository.insertAsPlatform(platform))).resolves.toBe(0);

        const poll = await asSystem(() => repository.pollUnpublished(10));
        expect(poll.backlog).toBe(2);
        expect(poll.rows.map((row) => row.id).sort()).toEqual(platform.map((r) => r.id).sort());
        for (const row of poll.rows) {
          const record = platform.find((candidate) => candidate.id === row.id);
          expect(row).toMatchObject({
            tenantId: PLATFORM_TENANT_ID,
            topic: CATALOG_UPDATED_EVENT.topic,
            envelope: record?.envelope,
          });
        }
      });

      it("throws before SQL for another tenant's record, inserting none of the batch", async () => {
        const platform = recordFor(PLATFORM_TENANT_ID);
        const tenant = recordFor(TENANT_A);
        const error = await asSystem(() => repository.insertAsPlatform([platform, tenant])).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(OutboxError);
        expect(error).toMatchObject({ code: 'OUTBOX_TENANT_MISMATCH' });
        expect(await stored()).toEqual([]);
      });
    });

    describe('deletePublishedBefore', () => {
      it('removes old published rows on every shard, never an unpublished one', async () => {
        const cutoff = new Date('2026-09-08T00:00:00.000Z');
        const old = [TENANT_A, TENANT_B, TENANT_C, PLATFORM_TENANT_ID].map((tenantId, index) => ({
          ...recordFor(tenantId),
          createdAt: `2026-09-0${index + 1}T10:00:00.000Z`,
          publishedAt: `2026-09-0${index + 1}T10:00:05.000Z`,
        }));
        const recent = {
          ...recordFor(TENANT_B),
          createdAt: '2026-09-08T09:00:00.000Z',
          publishedAt: '2026-09-08T09:00:01.000Z',
        };
        const unpublished = [TENANT_A, TENANT_C].map((tenantId) => ({
          ...recordFor(tenantId),
          createdAt: '2026-08-01T10:00:00.000Z',
        }));
        await seed([...old, recent, ...unpublished]);
        // The shards those rows live on: the purge must reach more than one.
        const [shards] = await admin<{ count: number }[]>`
          select count(distinct get_shard_id_for_distribution_column('fx.outbox', tenant_id))::int
            as count from fx.outbox where published_at < ${cutoff}`;
        expect(shards?.count).toBeGreaterThan(1);

        await expect(asSystem(() => repository.deletePublishedBefore(cutoff))).resolves.toBe(4);

        expect((await stored()).map((row) => row.id).sort()).toEqual(
          [recent.id, ...unpublished.map((row) => row.id)].sort(),
        );
        await expect(asSystem(() => repository.deletePublishedBefore(cutoff))).resolves.toBe(0);
      });
    });

    it('outside SystemContext every method rejects with SYSTEM_CONTEXT_REQUIRED', async () => {
      const a = recordFor(TENANT_A);
      await seed([{ ...a, createdAt: '2026-09-01T10:00:00.000Z' }]);
      const platform = recordFor(PLATFORM_TENANT_ID);
      const calls: (() => Promise<unknown>)[] = [
        () => repository.pollUnpublished(10),
        () => repository.markPublished([{ tenantId: TENANT_A, id: a.id }]),
        () => repository.insertAsPlatform([platform]),
        () => repository.deletePublishedBefore(new Date('2030-01-01T00:00:00.000Z')),
      ];
      for (const call of calls) {
        for (const error of [
          await call().catch((e: unknown) => e),
          await runWithPrincipal(principalOf(TENANT_A), call).catch((e: unknown) => e),
        ]) {
          expect(error).toBeInstanceOf(SystemDatabaseError);
          expect(error).toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
        }
      }
      expect(await stored()).toEqual([{ tenant_id: TENANT_A, id: a.id, published_at: null }]);
    });
  },
);
