import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  type Principal,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_UPDATED_EVENT,
  createRecordingDrizzle,
  createRlsTransactionHost,
  FX_OUTBOX,
  ORDER_PLACED_EVENT,
  orderPlaced,
} from '../../test/outbox-fixture.js';
import { OutboxError } from '../outbox.errors.js';
import { OutboxWriter } from '../outbox-writer.js';
import { InMemoryOutbox } from './in-memory-outbox.js';

const TENANT_A = '0197a000-0000-7000-8000-0000000000a1';
const TENANT_B = '0197a000-0000-7000-8000-0000000000b2';
const TENANT_C = '0197a000-0000-7000-8000-0000000000c3';
const principalOf = (tenantId: string): Principal =>
  createPrincipal({ userId: generateId(), tenantId, roles: ['member'] });

const asSystem = <T>(fn: () => Promise<T>): Promise<T> => SystemContext.run('fx.outbox-test', fn);
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;

describe('InMemoryOutbox', () => {
  let clock: number;
  let outbox: InMemoryOutbox;

  beforeEach(() => {
    clock = Date.parse('2026-09-01T10:00:00.000Z');
    outbox = new InMemoryOutbox(FX_OUTBOX, { now: () => new Date(clock) });
  });

  /** Enqueues one event as a member of `tenantId`, `atMs` after the clock's start. */
  const enqueueAt = async (tenantId: string, atMs: number, eventId?: string) => {
    clock = Date.parse('2026-09-01T10:00:00.000Z') + atMs;
    return runWithPrincipal(principalOf(tenantId), () =>
      outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { eventId }),
    );
  };

  describe('as the writer', () => {
    it('is an OutboxWriter: enqueue stores the record, unpublished, and publishes nothing', async () => {
      const kafka = new FakeKafkaProducer();
      outbox = new InMemoryOutbox(FX_OUTBOX, { kafka, now: () => new Date(clock) });
      expect(outbox).toBeInstanceOf(OutboxWriter);
      const payload = orderPlaced();
      const envelope = await runWithPrincipal(principalOf(TENANT_A), () =>
        outbox.enqueue(ORDER_PLACED_EVENT, payload, { key: payload.orderId }),
      );
      expect(outbox.records).toEqual([
        {
          tenantId: TENANT_A,
          id: envelope.id,
          topic: ORDER_PLACED_EVENT.topic,
          key: payload.orderId,
          envelope,
          createdAt: new Date(clock),
          publishedAt: null,
        },
      ]);
      expect(outbox.unpublished()).toEqual(outbox.records);
      expect(kafka.records).toEqual([]);
    });

    it('applies the tenant rules of the real writer', async () => {
      const member = principalOf(TENANT_A);
      const attempts = [
        () => outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT_B }),
        () => outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: PLATFORM_TENANT_ID }),
      ];
      const codes = [];
      for (const attempt of attempts) {
        codes.push(codeOf(await runWithPrincipal(member, attempt).catch((e: unknown) => e)));
      }
      const userOnly = createPrincipal({ userId: generateId(), tenantId: null });
      codes.push(
        codeOf(
          await runWithPrincipal(userOnly, () =>
            outbox.enqueue(CATALOG_UPDATED_EVENT, { sku: 's' }),
          ).catch((e: unknown) => e),
        ),
      );
      expect(codes).toEqual([
        'OUTBOX_TENANT_MISMATCH',
        'OUTBOX_PLATFORM_TENANT',
        'OUTBOX_TENANT_REQUIRED',
      ]);
      expect(outbox.records).toEqual([]);
    });

    it('with a transaction host, refuses to enqueue outside its transaction', async () => {
      const txHost = createRlsTransactionHost(createRecordingDrizzle().db);
      outbox = new InMemoryOutbox(FX_OUTBOX, { txHost });
      const member = principalOf(TENANT_A);
      const outside = await runWithPrincipal(member, () =>
        outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced()),
      ).catch((e: unknown) => e);
      expect(outside).toBeInstanceOf(OutboxError);
      expect(codeOf(outside)).toBe('OUTBOX_NO_TRANSACTION');

      await runWithPrincipal(member, () =>
        txHost.withTransaction(() => outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced())),
      );
      expect(outbox.records).toHaveLength(1);
    });

    it('never dedupes: the same envelope id twice fails like the primary key', async () => {
      const eventId = generateId();
      const member = principalOf(TENANT_A);
      await runWithPrincipal(member, () =>
        outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { eventId }),
      );
      await expect(
        runWithPrincipal(member, () =>
          outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { eventId }),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      expect(outbox.records).toHaveLength(1);
    });
  });

  describe('as the system repository', () => {
    it('pollUnpublished returns the oldest rows by (created_at, id) with the backlog statistics', async () => {
      // e3 and e2 share created_at; e3 is enqueued first but has the greater id: the id breaks the tie.
      const [low, high] = [generateId(), generateId()].sort();
      const e1 = await enqueueAt(TENANT_B, 3_000);
      const e3 = await enqueueAt(TENANT_C, 1_000, high);
      const e2 = await enqueueAt(TENANT_A, 1_000, low);
      const e4 = await enqueueAt(TENANT_A, 2_000);
      const e5 = await enqueueAt(TENANT_C, 4_000);

      const poll = await asSystem(() => outbox.pollUnpublished(2));
      expect(poll.rows.map((row) => row.id)).toEqual([e2.id, e3.id]);
      expect(poll.rows[0]).toEqual({
        tenantId: TENANT_A,
        id: e2.id,
        topic: ORDER_PLACED_EVENT.topic,
        key: null,
        envelope: e2,
        createdAt: new Date('2026-09-01T10:00:01.000Z'),
      });
      expect(poll.backlog).toBe(5);
      expect(poll.oldestCreatedAt).toEqual(new Date('2026-09-01T10:00:01.000Z'));

      await asSystem(() => outbox.markPublished(poll.rows));
      const next = await asSystem(() => outbox.pollUnpublished(10));
      expect(next.rows.map((row) => row.id)).toEqual([e4.id, e1.id, e5.id]);
      expect(next.backlog).toBe(3);
      expect(next.oldestCreatedAt).toEqual(new Date('2026-09-01T10:00:02.000Z'));
    });

    it('an empty outbox polls no rows, backlog 0 and no oldest row', async () => {
      await expect(asSystem(() => outbox.pollUnpublished(5))).resolves.toEqual({
        rows: [],
        backlog: 0,
        oldestCreatedAt: null,
      });
    });

    it('markPublished stamps only the given pairs, once, and ignores the right id under the wrong tenant', async () => {
      const a = await enqueueAt(TENANT_A, 0);
      const b = await enqueueAt(TENANT_B, 0);
      const c = await enqueueAt(TENANT_C, 0);
      clock += 5_000;
      const first = new Date(clock);

      await expect(
        asSystem(() =>
          outbox.markPublished([
            { tenantId: TENANT_A, id: a.id },
            { tenantId: TENANT_A, id: b.id },
          ]),
        ),
      ).resolves.toBe(1);
      clock += 5_000;
      await expect(
        asSystem(() => outbox.markPublished([{ tenantId: TENANT_A, id: a.id }])),
      ).resolves.toBe(0);

      const publishedAt = Object.fromEntries(outbox.records.map((r) => [r.id, r.publishedAt]));
      expect(publishedAt).toEqual({ [a.id]: first, [b.id]: null, [c.id]: null });
      expect(outbox.unpublished().map((row) => row.id)).toEqual([b.id, c.id]);
    });

    it('insertAsPlatform inserts nil-tenant rows the poll returns, idempotent by id', async () => {
      const writer = outbox;
      const records = [1, 2].map((n) =>
        writer.record(CATALOG_UPDATED_EVENT, { sku: `sku-${n}` }, { tenantId: PLATFORM_TENANT_ID }),
      );
      await expect(asSystem(() => outbox.insertAsPlatform(records))).resolves.toBe(2);
      await expect(asSystem(() => outbox.insertAsPlatform(records))).resolves.toBe(0);
      const poll = await asSystem(() => outbox.pollUnpublished(10));
      expect(poll.rows.map((row) => [row.tenantId, row.id])).toEqual(
        records.map((record) => [PLATFORM_TENANT_ID, record.id]),
      );
    });

    it("insertAsPlatform throws before inserting anything for another tenant's record", async () => {
      const platform = outbox.record(
        CATALOG_UPDATED_EVENT,
        { sku: 's' },
        { tenantId: PLATFORM_TENANT_ID },
      );
      const tenant = outbox.record(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT_A });
      const error = await asSystem(() => outbox.insertAsPlatform([platform, tenant])).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OutboxError);
      expect(codeOf(error)).toBe('OUTBOX_TENANT_MISMATCH');
      expect(outbox.records).toEqual([]);
    });

    it('deletePublishedBefore removes old published rows of every tenant, never an unpublished one', async () => {
      const a = await enqueueAt(TENANT_A, 0);
      const b = await enqueueAt(TENANT_B, 0);
      const c = await enqueueAt(TENANT_C, 0);
      const d = await enqueueAt(TENANT_C, 0);
      clock = Date.parse('2026-09-01T11:00:00.000Z');
      await asSystem(() =>
        outbox.markPublished([
          { tenantId: TENANT_A, id: a.id },
          { tenantId: TENANT_B, id: b.id },
        ]),
      );
      clock = Date.parse('2026-09-01T13:00:00.000Z');
      await asSystem(() => outbox.markPublished([{ tenantId: TENANT_C, id: c.id }]));

      await expect(
        asSystem(() => outbox.deletePublishedBefore(new Date('2026-09-01T12:00:00.000Z'))),
      ).resolves.toBe(2);
      expect(outbox.records.map((row) => row.id).sort()).toEqual([c.id, d.id].sort());
      await expect(
        asSystem(() => outbox.deletePublishedBefore(new Date('2026-09-02T00:00:00.000Z'))),
      ).resolves.toBe(1);
      expect(outbox.records.map((row) => row.id)).toEqual([d.id]);
    });

    it('outside SystemContext every method rejects with SYSTEM_CONTEXT_REQUIRED', async () => {
      await enqueueAt(TENANT_A, 0);
      const member = principalOf(TENANT_A);
      const calls: (() => Promise<unknown>)[] = [
        () => outbox.pollUnpublished(1),
        () => outbox.markPublished([]),
        () => outbox.insertAsPlatform([]),
        () => outbox.deletePublishedBefore(new Date()),
      ];
      for (const call of calls) {
        for (const error of [
          await call().catch((e: unknown) => e),
          await runWithPrincipal(member, call).catch((e: unknown) => e),
        ]) {
          expect(error).toBeInstanceOf(SystemDatabaseError);
          expect(codeOf(error)).toBe('SYSTEM_CONTEXT_REQUIRED');
        }
      }
      expect(outbox.unpublished()).toHaveLength(1);
    });
  });
});
