import { isPlatformTenantId, SystemContext } from '@platform/common';
import { type DrizzleTransactionHost, SystemDatabaseError } from '@platform/database';
import type { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { OutboxError } from '../outbox.errors.js';
import type { OutboxFeature, OutboxPoll, OutboxRecord, OutboxRow } from '../outbox.types.js';
import { OutboxWriter } from '../outbox-writer.js';

/** One stored row of the fake, with its publication stamp. */
export interface InMemoryOutboxRow extends OutboxRow {
  publishedAt: Date | null;
}

export interface InMemoryOutboxOptions {
  /** Builds the envelopes. Default: a `FakeKafkaProducer` (source `test`). */
  readonly kafka?: KafkaProducer;
  /**
   * When given, `enqueue` refuses to run outside its open transaction, like the real writer.
   * Without one, every call counts as inside a transaction. Rows of a rolled-back transaction stay.
   */
  readonly txHost?: DrizzleTransactionHost;
  /** `created_at` and `published_at` stamps. Default: the wall clock. */
  readonly now?: () => Date;
}

/** Stands in for a transaction host when the fake has none: every call is inside a transaction. */
const ALWAYS_IN_TRANSACTION = {
  isTransactionActive: () => true,
} as unknown as DrizzleTransactionHost;

/**
 * The outbox writer and its system repository over one array, for unit and e2e tests: bind it as
 * the domain's writer token (`{ provide: OrdersOutbox, useValue: outbox }`) and drive the relay
 * from the same object.
 * - Writer: `record` and `enqueue` are the real ones (validation, tenant rules, the transaction
 *   check when a host is given); the INSERT appends to `records`, and a duplicate `(tenant, id)`
 *   fails like the primary key (`code: '23505'`), never deduped.
 * - System repository: `pollUnpublished`, `markPublished`, `insertAsPlatform` and
 *   `deletePublishedBefore` behave as the SQL does (poll order `created_at, id`, mark once,
 *   platform rows only and idempotent by id, purge of published rows only) and, like
 *   `SystemDatabase.run`, reject with `SYSTEM_CONTEXT_REQUIRED` outside `SystemContext`.
 */
export class InMemoryOutbox extends OutboxWriter {
  /** Every stored row, in insertion order. */
  readonly records: InMemoryOutboxRow[] = [];
  private readonly hasTransactionHost: boolean;
  private readonly now: () => Date;

  constructor(feature: OutboxFeature, options: InMemoryOutboxOptions = {}) {
    super(
      feature,
      options.txHost ?? ALWAYS_IN_TRANSACTION,
      options.kafka ?? new FakeKafkaProducer({ source: 'test' }),
    );
    this.hasTransactionHost = options.txHost !== undefined;
    this.now = options.now ?? (() => new Date());
  }

  /** The unpublished rows in poll order (`created_at`, then `id`). */
  unpublished(): InMemoryOutboxRow[] {
    return this.records.filter((row) => row.publishedAt === null).sort(byPollOrder);
  }

  /** The `limit` oldest unpublished rows, and the count and oldest `created_at` of all of them. */
  async pollUnpublished(limit: number): Promise<OutboxPoll> {
    this.requireSystemContext('pollUnpublished');
    const unpublished = this.unpublished();
    return {
      rows: unpublished.slice(0, limit).map(toRow),
      backlog: unpublished.length,
      oldestCreatedAt: unpublished[0] === undefined ? null : new Date(unpublished[0].createdAt),
    };
  }

  /** Stamps the unpublished rows among `rows`; returns how many it stamped. */
  async markPublished(rows: readonly Pick<OutboxRecord, 'tenantId' | 'id'>[]): Promise<number> {
    this.requireSystemContext('markPublished');
    const publishedAt = this.now();
    let stamped = 0;
    for (const { tenantId, id } of rows) {
      const row = this.find(tenantId, id);
      if (row === undefined || row.publishedAt !== null) continue;
      row.publishedAt = new Date(publishedAt);
      stamped += 1;
    }
    return stamped;
  }

  /** Inserts platform-tenant records, skipping ids already stored; returns how many it inserted. */
  async insertAsPlatform(records: readonly OutboxRecord[]): Promise<number> {
    this.requireSystemContext('insertAsPlatform');
    if (records.some((record) => !isPlatformTenantId(record.tenantId))) {
      throw new OutboxError(
        'OUTBOX_TENANT_MISMATCH',
        `${this.feature.name} outbox: insertAsPlatform writes PLATFORM_TENANT_ID records only`,
      );
    }
    let inserted = 0;
    for (const record of records) {
      if (this.find(record.tenantId, record.id) !== undefined) continue;
      this.store(record);
      inserted += 1;
    }
    return inserted;
  }

  /** Deletes the rows published before `cutoff`, of every tenant; returns how many it deleted. */
  async deletePublishedBefore(cutoff: Date): Promise<number> {
    this.requireSystemContext('deletePublishedBefore');
    const before = this.records.length;
    const kept = this.records.filter(
      (row) => row.publishedAt === null || row.publishedAt.getTime() >= cutoff.getTime(),
    );
    this.records.splice(0, this.records.length, ...kept);
    return before - kept.length;
  }

  protected override inTransaction(): boolean {
    return this.hasTransactionHost ? super.inTransaction() : true;
  }

  protected override async insert(record: OutboxRecord): Promise<void> {
    if (this.find(record.tenantId, record.id) !== undefined) {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "outbox_tenant_id_id_pk"'),
        { code: '23505' },
      );
    }
    this.store(record);
  }

  private store(record: OutboxRecord): void {
    this.records.push({ ...record, createdAt: this.now(), publishedAt: null });
  }

  private find(tenantId: string, id: string): InMemoryOutboxRow | undefined {
    return this.records.find((row) => row.tenantId === tenantId && row.id === id);
  }

  private requireSystemContext(method: string): void {
    if (!SystemContext.isActive()) {
      throw new SystemDatabaseError(
        'SYSTEM_CONTEXT_REQUIRED',
        `outbox.${method} needs a SystemContext (fake of ${this.feature.name})`,
      );
    }
  }
}

function byPollOrder(a: InMemoryOutboxRow, b: InMemoryOutboxRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function toRow({ tenantId, id, topic, key, envelope, createdAt }: InMemoryOutboxRow): OutboxRow {
  return { tenantId, id, topic, key, envelope, createdAt: new Date(createdAt) };
}
