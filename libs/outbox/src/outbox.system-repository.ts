import { isPlatformTenantId } from '@platform/common';
import type { EventEnvelope } from '@platform/contracts';
import { purgeInTimeSlices, type SystemDatabase } from '@platform/database';
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, lte, min, sql } from 'drizzle-orm';
import { OutboxError } from './outbox.errors.js';
import type { OutboxFeature, OutboxPoll, OutboxRecord, OutboxRow } from './outbox.types.js';
import { OUTBOX_SYSTEM_METHODS } from './outbox-system-methods.js';

/**
 * The outbox on the `app_system` (BYPASSRLS) pool, once for every domain: each domain subclasses it
 * once in its own `*.system-repository.ts`, bound to its `OutboxFeature`
 * (`constructor(@InjectSystemDatabase() system: SystemDatabase<Schema>) { super(FEATURE, system) }`).
 * Every method is one `SystemDatabase.run` of a pinned `OUTBOX_SYSTEM_METHODS` entry: logged,
 * counted, refused outside `SystemContext`, and each statement commits on its own (never inside a
 * runtime transaction). No method takes a row lock or a cross-shard transaction (SH §7.4): one
 * leader relay per outbox polls, and a row published twice is the at-least-once contract.
 */
export abstract class OutboxSystemRepository {
  protected constructor(
    protected readonly feature: OutboxFeature,
    private readonly system: SystemDatabase,
  ) {}

  /**
   * The `limit` oldest unpublished rows by `(created_at, id)`, and the count and oldest
   * `created_at` of all unpublished rows: two multi-shard reads in one call, no row lock (they are
   * not one snapshot; the statistics feed the backlog metrics only).
   */
  pollUnpublished(limit: number): Promise<OutboxPoll> {
    const { table } = this.feature;
    return this.system.run(OUTBOX_SYSTEM_METHODS.poll, async (db) => {
      const stored = await db
        .select({
          tenantId: table.tenantId,
          id: table.id,
          topic: table.topic,
          key: table.key,
          envelope: table.envelope,
          createdAt: table.createdAt,
        })
        .from(table)
        .where(isNull(table.publishedAt))
        .orderBy(asc(table.createdAt), asc(table.id))
        .limit(limit);
      const [stats] = await db
        .select({ backlog: count(), oldestCreatedAt: min(table.createdAt) })
        .from(table)
        .where(isNull(table.publishedAt));
      // `envelope` was validated when it was stored (`OutboxWriter.record`); jsonb reads as unknown.
      const rows = stored.map(
        (row): OutboxRow => ({ ...row, envelope: row.envelope as EventEnvelope<unknown> }),
      );
      return {
        rows,
        backlog: stats?.backlog ?? 0,
        oldestCreatedAt: stats?.oldestCreatedAt ?? null,
      };
    });
  }

  /**
   * Stamps `published_at = now()` on the given rows that are still unpublished; returns how many it
   * stamped. One router UPDATE per tenant (`tenant_id = $1 AND id IN (…) AND published_at IS NULL`),
   * never a multi-shard UPDATE; a row stamped before keeps its first stamp.
   */
  markPublished(rows: readonly Pick<OutboxRecord, 'tenantId' | 'id'>[]): Promise<number> {
    const { table } = this.feature;
    return this.system.run(OUTBOX_SYSTEM_METHODS.markPublished, async (db) => {
      const idsByTenant = new Map<string, Set<string>>();
      for (const { tenantId, id } of rows) {
        const tenant = tenantId.toLowerCase();
        const ids = idsByTenant.get(tenant) ?? new Set<string>();
        ids.add(id.toLowerCase());
        idsByTenant.set(tenant, ids);
      }
      let stamped = 0;
      for (const [tenantId, ids] of idsByTenant) {
        const result = await db
          .update(table)
          .set({ publishedAt: sql`now()` })
          .where(
            and(
              eq(table.tenantId, tenantId),
              inArray(table.id, [...ids]),
              isNull(table.publishedAt),
            ),
          );
        stamped += result.count;
      }
      return stamped;
    });
  }

  /**
   * Inserts records of `PLATFORM_TENANT_ID` (which no principal can write) in one router statement
   * with `ON CONFLICT DO NOTHING`; returns how many rows are new, so the same ids again return 0.
   * @throws OutboxError `OUTBOX_TENANT_MISMATCH` before any SQL when a record has another tenant
   *   (none of the batch is inserted)
   */
  insertAsPlatform(records: readonly OutboxRecord[]): Promise<number> {
    const { table } = this.feature;
    return this.system.run(OUTBOX_SYSTEM_METHODS.insertAsPlatform, async (db) => {
      if (records.some((record) => !isPlatformTenantId(record.tenantId))) {
        throw new OutboxError(
          'OUTBOX_TENANT_MISMATCH',
          `${this.feature.name} outbox: insertAsPlatform writes PLATFORM_TENANT_ID records only`,
        );
      }
      if (records.length === 0) return 0;
      const inserted = await db
        .insert(table)
        .values(
          records.map(({ tenantId, id, topic, key, envelope }) => ({
            tenantId,
            id,
            topic,
            key,
            envelope,
          })),
        )
        .onConflictDoNothing({ target: [table.tenantId, table.id] })
        .returning({ id: table.id });
      return inserted.length;
    });
  }

  /**
   * Deletes the rows published before `cutoff`, of every tenant (a multi-shard DELETE), never an
   * unpublished one; returns how many it deleted. Time slices oldest first (`purgeInTimeSlices`,
   * B3 ruling 6): each slice is one set-based DELETE that commits on its own and stays below the
   * role's `statement_timeout`; a backlog larger than one run drains over the next runs.
   */
  deletePublishedBefore(cutoff: Date): Promise<number> {
    const { table } = this.feature;
    return this.system.run(OUTBOX_SYSTEM_METHODS.deletePublishedBefore, async (db) => {
      const { deleted } = await purgeInTimeSlices({
        cutoff,
        oldestDue: async () => {
          const [row] = await db
            .select({ oldest: min(table.publishedAt) })
            .from(table)
            .where(and(isNotNull(table.publishedAt), lt(table.publishedAt, cutoff)));
          return row?.oldest ?? null;
        },
        deleteThrough: async (bound) =>
          (
            await db
              .delete(table)
              .where(
                and(
                  isNotNull(table.publishedAt),
                  lt(table.publishedAt, cutoff),
                  lte(table.publishedAt, bound),
                ),
              )
          ).count,
      });
      return deleted;
    });
  }
}
