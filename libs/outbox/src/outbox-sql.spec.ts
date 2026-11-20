import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { type DrizzleDB, SystemDatabase, SystemDatabaseError } from '@platform/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_UPDATED_EVENT,
  createRecordingDrizzle,
  FX_OUTBOX,
  FxOutboxSystemRepository,
  type FxSchema,
  ORDER_PLACED_EVENT,
  orderPlaced,
  type RecordedAnswer,
  type RecordedQuery,
} from '../test/outbox-fixture.js';
import { OutboxError } from './outbox.errors.js';
import { OUTBOX_SYSTEM_METHODS } from './outbox-system-methods.js';
import { InMemoryOutbox } from './testing/in-memory-outbox.js';

/*
 * The SQL the outbox system repository generates, read from a recording postgres.js client: the
 * poll takes no row lock and orders by (created_at, id); every mark statement is a router
 * statement (`tenant_id =`); the purge deletes published rows only. The live behaviour on Citus is
 * test/outbox.system-repository.int-spec.ts.
 */

const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const ID_1 = '0197a000-0000-7000-8000-000000000001';
const ID_2 = '0197a000-0000-7000-8000-000000000002';
const ID_3 = '0197a000-0000-7000-8000-000000000003';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> => SystemContext.run('outbox.sql-spec', fn);

/** The statement without quotes, line breaks or case: `update fx.outbox set …`. */
const flat = (text: string): string =>
  text.replaceAll('"', '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

/** A column reference, bare or qualified (`published_at`, `fx.outbox.published_at`). */
const col = (name: string): string => String.raw`(?:[a-z_]+\.)*${name}`;

/** Builds records (no SQL) the way a domain does: a writer's `record()`. */
const records = new InMemoryOutbox(FX_OUTBOX);

describe('OUTBOX_SYSTEM_METHODS', () => {
  it('pins the four outbox methods, all in system scope, frozen', () => {
    expect(
      Object.entries(OUTBOX_SYSTEM_METHODS).map(([key, { name, scope }]) => ({ key, name, scope })),
    ).toEqual([
      { key: 'poll', name: 'outbox.pollUnpublished', scope: 'system' },
      { key: 'markPublished', name: 'outbox.markPublished', scope: 'system' },
      { key: 'insertAsPlatform', name: 'outbox.insertAsPlatform', scope: 'system' },
      { key: 'deletePublishedBefore', name: 'outbox.deletePublishedBefore', scope: 'system' },
    ]);
    expect(Object.isFrozen(OUTBOX_SYSTEM_METHODS)).toBe(true);
  });
});

describe('OutboxSystemRepository (generated SQL)', () => {
  let queries: RecordedQuery[];
  let answer: (query: RecordedQuery) => RecordedAnswer | undefined;
  let system: SystemDatabase<FxSchema>;
  let repository: FxOutboxSystemRepository;
  let run: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    answer = () => undefined;
    const recording = createRecordingDrizzle((query) => answer(query));
    queries = recording.queries;
    system = new SystemDatabase(recording.db as unknown as DrizzleDB<FxSchema>);
    run = vi.spyOn(system, 'run');
    repository = new FxOutboxSystemRepository(system);
  });

  const statements = (): string[] => queries.map((query) => flat(query.sql));
  const methodsRun = (): string[] =>
    run.mock.calls.map((call: unknown[]) => (call[0] as { name: string }).name);

  describe('pollUnpublished', () => {
    it('reads the oldest unpublished rows with no row lock, ordered by created_at then id, and the backlog in the same call', async () => {
      answer = (query) =>
        /count\(/i.test(query.sql) ? { rows: [['3', '2026-09-01 10:00:00.000+00']] } : undefined;

      const poll = await asSystem(() => repository.pollUnpublished(5));

      expect(poll).toEqual({
        rows: [],
        backlog: 3,
        oldestCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
      });
      expect(methodsRun()).toEqual(['outbox.pollUnpublished']);
      const [rows, stats, ...rest] = statements();
      expect(rest).toEqual([]);
      for (const statement of [rows, stats]) {
        expect(statement).toMatch(/ from fx\.outbox /);
        expect(statement).toMatch(new RegExp(`where ${col('published_at')} is null`));
        expect(statement).not.toMatch(/\bfor (?:update|no key update|share|key share)\b/);
        expect(statement).not.toMatch(/skip locked|nowait/);
      }
      expect(rows).toMatch(
        new RegExp(`order by ${col('created_at')}(?: asc)?, ${col('id')}(?: asc)? limit \\$\\d+$`),
      );
      expect(queries[0]?.params.at(-1)).toBe(5);
      expect(stats).toMatch(/count\(\*\)/);
      expect(stats).toMatch(new RegExp(`min\\(${col('created_at')}\\)`));
    });

    it('an empty answer reads as backlog 0 and no oldest row', async () => {
      await expect(asSystem(() => repository.pollUnpublished(5))).resolves.toEqual({
        rows: [],
        backlog: 0,
        oldestCreatedAt: null,
      });
    });
  });

  describe('markPublished', () => {
    it('sends one router UPDATE per tenant (tenant_id = $1, the ids, still unpublished) and sums the counts', async () => {
      answer = (query) =>
        /^update/i.test(query.sql.trim()) ? { count: query.params.length - 1 } : undefined;

      const marked = await asSystem(() =>
        repository.markPublished([
          { tenantId: TENANT_A, id: ID_1 },
          { tenantId: TENANT_B, id: ID_2 },
          { tenantId: TENANT_A, id: ID_3 },
          { tenantId: TENANT_A, id: ID_1 },
        ]),
      );

      expect(marked).toBe(3);
      expect(methodsRun()).toEqual(['outbox.markPublished']);
      expect(queries).toHaveLength(2);
      for (const statement of statements()) {
        expect(statement).toMatch(
          new RegExp(
            String.raw`^update fx\.outbox set published_at = now\(\) where \(${col('tenant_id')} = \$1 and ${col('id')} in \([$\d, ]+\) and ${col('published_at')} is null\)$`,
          ),
        );
        expect(statement).not.toMatch(/returning/);
      }
      expect(queries.map((query) => query.params)).toEqual([
        [TENANT_A, ID_1, ID_3],
        [TENANT_B, ID_2],
      ]);
    });

    it('nothing to mark sends no SQL and returns 0, still through the system method', async () => {
      await expect(asSystem(() => repository.markPublished([]))).resolves.toBe(0);
      expect(queries).toEqual([]);
      expect(methodsRun()).toEqual(['outbox.markPublished']);
    });
  });

  describe('insertAsPlatform', () => {
    it('inserts platform rows in one statement with ON CONFLICT DO NOTHING and returns the new ones', async () => {
      const platform = [1, 2].map((n) =>
        records.record(
          CATALOG_UPDATED_EVENT,
          { sku: `sku-${n}` },
          { tenantId: PLATFORM_TENANT_ID },
        ),
      );
      answer = (query) =>
        /^insert/i.test(query.sql.trim()) ? { rows: [[platform[1]?.id]] } : undefined;

      await expect(asSystem(() => repository.insertAsPlatform(platform))).resolves.toBe(1);

      expect(methodsRun()).toEqual(['outbox.insertAsPlatform']);
      const [insert, ...rest] = statements();
      expect(rest).toEqual([]);
      expect(insert).toMatch(
        /^insert into fx\.outbox \(tenant_id, id, topic, key, envelope, created_at, published_at\) values /,
      );
      expect(insert).toMatch(/ on conflict \(tenant_id,id\) do nothing/);
      const params = queries[0]?.params ?? [];
      expect(params.filter((param) => param === PLATFORM_TENANT_ID)).toHaveLength(2);
      expect(params).toContain(platform[0]?.id);
      expect(params).toContain(CATALOG_UPDATED_EVENT.topic);
    });

    it("throws before any SQL for another tenant's record", async () => {
      const platform = records.record(
        CATALOG_UPDATED_EVENT,
        { sku: 's' },
        { tenantId: PLATFORM_TENANT_ID },
      );
      const tenant = records.record(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT_A });

      const error = await asSystem(() => repository.insertAsPlatform([platform, tenant])).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(OutboxError);
      expect(error).toMatchObject({ code: 'OUTBOX_TENANT_MISMATCH' });
      expect(queries).toEqual([]);
    });

    it('nothing to insert sends no SQL and returns 0', async () => {
      await expect(asSystem(() => repository.insertAsPlatform([]))).resolves.toBe(0);
      expect(queries).toEqual([]);
    });
  });

  describe('deletePublishedBefore', () => {
    it('purges published rows only, oldest slice first, on every shard (no tenant filter)', async () => {
      const cutoff = new Date('2026-09-02T00:00:00.000Z');
      let probes = 0;
      answer = (query) => {
        if (/^delete/i.test(query.sql.trim())) return { count: 4 };
        if (/min\(/i.test(query.sql)) {
          probes += 1;
          return { rows: [[probes === 1 ? '2026-09-01 23:55:00.000+00' : null]] };
        }
        return undefined;
      };

      await expect(asSystem(() => repository.deletePublishedBefore(cutoff))).resolves.toBe(4);

      expect(methodsRun()).toEqual(['outbox.deletePublishedBefore']);
      const [probe, purge, again, ...rest] = statements();
      expect(rest).toEqual([]);
      expect(again).toBe(probe);
      expect(probe).toMatch(
        new RegExp(
          `^select min\\(${col('published_at')}\\) from fx\\.outbox where \\(${col('published_at')} is not null and ${col('published_at')} < \\$1\\)$`,
        ),
      );
      expect(purge).toMatch(
        new RegExp(
          `^delete from fx\\.outbox where \\(${col('published_at')} is not null and ${col('published_at')} < \\$1 and ${col('published_at')} <= \\$2\\)$`,
        ),
      );
      expect(purge).not.toMatch(/tenant_id/);
      expect(queries[1]?.params).toEqual([cutoff.toISOString(), cutoff.toISOString()]);
    });
  });

  it('outside SystemContext every method rejects with SYSTEM_CONTEXT_REQUIRED and sends no SQL', async () => {
    const platform = records.record(
      CATALOG_UPDATED_EVENT,
      { sku: 's' },
      { tenantId: PLATFORM_TENANT_ID },
    );
    const calls: (() => Promise<unknown>)[] = [
      () => repository.pollUnpublished(1),
      () => repository.markPublished([{ tenantId: TENANT_A, id: ID_1 }]),
      () => repository.markPublished([]),
      () => repository.insertAsPlatform([platform]),
      () => repository.insertAsPlatform([]),
      () => repository.deletePublishedBefore(new Date()),
    ];
    for (const call of calls) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SystemDatabaseError);
      expect(error).toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    }
    expect(queries).toEqual([]);
  });
});
