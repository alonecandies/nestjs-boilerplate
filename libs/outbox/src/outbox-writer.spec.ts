import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
} from '@platform/common';
import type { DrizzleTransactionHost } from '@platform/database';
import { InvalidEventException } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_UPDATED_EVENT,
  createRecordingDrizzle,
  createRlsTransactionHost,
  FX_OUTBOX,
  fxOutbox,
  ORDER_PLACED_EVENT,
  orderPlaced,
  type RecordedQuery,
  rlsContextStatement,
} from '../test/outbox-fixture.js';
import { OutboxError } from './outbox.errors.js';
import { OutboxWriter } from './outbox-writer.js';
import { describeOutboxTable } from './testing/describe-outbox-table.js';

const USER = '0197a000-0000-7000-8000-00000000000a';
const OTHER_USER = '0197a000-0000-7000-8000-00000000000b';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const OTHER_TENANT = '0197a000-0000-7000-8000-0000000000b2';
const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const userOnly = createPrincipal({ userId: USER, tenantId: null });

/** How a domain declares its writer: a subclass, which is also its DI token. */
class FxOutbox extends OutboxWriter {}

const errorCode = (error: unknown): unknown => (error as OutboxError | undefined)?.code;

/** What `fn` throws (undefined when it returns). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describeOutboxTable(fxOutbox, 'fx');

describe('OutboxWriter', () => {
  let queries: RecordedQuery[];
  let transcript: string[];
  let txHost: DrizzleTransactionHost;
  let kafka: FakeKafkaProducer;
  let writer: FxOutbox;

  beforeEach(() => {
    const recording = createRecordingDrizzle();
    queries = recording.queries;
    transcript = recording.transcript;
    txHost = createRlsTransactionHost(recording.db);
    kafka = new FakeKafkaProducer({ source: 'fx-service' }, ClsServiceManager.getClsService());
    writer = new FxOutbox(FX_OUTBOX, txHost, kafka);
  });

  /** `fn` as `principal` inside one transaction (what a command handler's unit of work does). */
  const inTransaction = <T>(principal: typeof member, fn: () => Promise<T>): Promise<T> =>
    runWithPrincipal(principal, () => txHost.withTransaction(fn));

  describe('enqueue', () => {
    it('outside a transaction rejects with OUTBOX_NO_TRANSACTION and sends no SQL', async () => {
      const asMember = await runWithPrincipal(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, orderPlaced()).catch((e: unknown) => e),
      );
      expect(asMember).toBeInstanceOf(OutboxError);
      expect(errorCode(asMember)).toBe('OUTBOX_NO_TRANSACTION');

      const anonymous = await writer
        .enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT })
        .catch((e: unknown) => e);
      expect(errorCode(anonymous)).toBe('OUTBOX_NO_TRANSACTION');
      expect(transcript).toEqual([]);
      expect(kafka.records).toEqual([]);
    });

    it('sends exactly one plain INSERT with the principal tenant, the envelope id, topic, key and envelope', async () => {
      const payload = orderPlaced();
      const envelope = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, payload, { key: payload.orderId }),
      );

      expect(transcript).toEqual([
        'begin',
        rlsContextStatement(USER, TENANT),
        queries[0]?.sql,
        'commit',
      ]);
      expect(queries).toHaveLength(1);
      const [insert] = queries;
      expect(insert?.sql).toMatch(
        /^insert into "fx"\."outbox" \("tenant_id", "id", "topic", "key", "envelope"/,
      );
      expect(insert?.sql).not.toMatch(/returning/i);
      expect(insert?.sql).not.toMatch(/on conflict/i);
      expect(insert?.params.slice(0, 4)).toEqual([
        TENANT,
        envelope.id,
        ORDER_PLACED_EVENT.topic,
        payload.orderId,
      ]);
      expect(JSON.parse(String(insert?.params[4]))).toEqual(envelope);
      expect(insert?.params).toHaveLength(5);
      expect(envelope).toMatchObject({
        type: ORDER_PLACED_EVENT.topic,
        tenantId: TENANT,
        actorId: USER,
        source: 'fx-service',
        payload,
      });
      // Nothing reaches Kafka from the request path: the relay publishes the row later.
      expect(kafka.records).toEqual([]);
    });

    it('stores a null key when none is given', async () => {
      await inTransaction(member, () => writer.enqueue(ORDER_PLACED_EVENT, orderPlaced()));
      expect(queries[0]?.params[3]).toBeNull();
    });

    it('returns what KafkaProducer.createRecord builds for the same input', async () => {
      const payload = orderPlaced();
      const options = {
        key: 'k-1',
        eventId: generateId(),
        occurredAt: new Date('2026-09-01T10:00:00.000Z'),
        correlationId: 'corr-1',
      };
      const [envelope, expected] = await inTransaction(member, async () => [
        await writer.enqueue(ORDER_PLACED_EVENT, payload, options),
        kafka.createRecord(ORDER_PLACED_EVENT, payload, options),
      ]);
      expect(envelope).toEqual(expected.value);
      expect(queries[0]?.params[3]).toBe(expected.key);
    });

    it('keeps an explicit null actor (system work inside a principal unit of work)', async () => {
      const envelope = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { actorId: null }),
      );
      expect(envelope.actorId).toBeNull();
    });

    it('throws InvalidEventException for a payload the contract rejects, before any SQL', async () => {
      const error = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, { orderId: 'x', totalMinor: -1 }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidEventException);
      expect(queries).toEqual([]);
      expect(transcript).toEqual(['begin', rlsContextStatement(USER, TENANT), 'rollback']);
    });

    it('a principal without a tenant → OUTBOX_TENANT_REQUIRED, also for an unscoped contract', async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () => writer.enqueue(ORDER_PLACED_EVENT, orderPlaced()),
        () => writer.enqueue(CATALOG_UPDATED_EVENT, { sku: 'sku-1' }),
        () => writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT }),
      ];
      for (const enqueue of attempts) {
        const error = await inTransaction(userOnly, enqueue).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OutboxError);
        expect(errorCode(error)).toBe('OUTBOX_TENANT_REQUIRED');
      }
      expect(queries).toEqual([]);
    });

    it('options.tenantId other than the principal tenant → OUTBOX_TENANT_MISMATCH', async () => {
      const error = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: OTHER_TENANT }),
      ).catch((e: unknown) => e);
      expect(errorCode(error)).toBe('OUTBOX_TENANT_MISMATCH');
      expect(queries).toEqual([]);
    });

    it('options.tenantId equal to the principal tenant is accepted', async () => {
      const envelope = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: TENANT }),
      );
      expect(envelope.tenantId).toBe(TENANT);
      expect(queries).toHaveLength(1);
    });

    it('the nil tenant → OUTBOX_PLATFORM_TENANT', async () => {
      const error = await inTransaction(member, () =>
        writer.enqueue(ORDER_PLACED_EVENT, orderPlaced(), { tenantId: PLATFORM_TENANT_ID }),
      ).catch((e: unknown) => e);
      expect(errorCode(error)).toBe('OUTBOX_PLATFORM_TENANT');
      expect(queries).toEqual([]);
    });

    it('refuses a principal swapped inside the transaction (RLS_CONTEXT_STALE), no INSERT', async () => {
      const other = createPrincipal({ userId: OTHER_USER, tenantId: TENANT, roles: ['member'] });
      const error = await inTransaction(member, () =>
        runWithPrincipal(other, () => writer.enqueue(ORDER_PLACED_EVENT, orderPlaced())),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'RLS_CONTEXT_STALE' });
      expect(queries).toEqual([]);
    });
  });

  describe('record', () => {
    it('works with no transaction and no principal when tenantId is given', () => {
      const payload = orderPlaced();
      const record = writer.record(ORDER_PLACED_EVENT, payload, {
        tenantId: OTHER_TENANT,
        key: 'k-2',
      });
      expect(record).toEqual({
        tenantId: OTHER_TENANT,
        id: record.envelope.id,
        topic: ORDER_PLACED_EVENT.topic,
        key: 'k-2',
        envelope: expect.objectContaining({ tenantId: OTHER_TENANT, payload }) as unknown,
      });
      expect(record.envelope).not.toHaveProperty('actorId');
      expect(transcript).toEqual([]);
    });

    it('builds a platform-tenant record (written later by the system repository only)', () => {
      const record = writer.record(
        CATALOG_UPDATED_EVENT,
        { sku: 's' },
        { tenantId: PLATFORM_TENANT_ID },
      );
      expect(record.tenantId).toBe(PLATFORM_TENANT_ID);
      expect(record.envelope.tenantId).toBe(PLATFORM_TENANT_ID);
      expect(record.key).toBeNull();
    });

    it('defaults the tenant to the principal, as createRecord does', () => {
      const record = runWithPrincipal(member, () =>
        writer.record(ORDER_PLACED_EVENT, orderPlaced()),
      );
      expect(record.tenantId).toBe(TENANT);
      expect(record.envelope).toMatchObject({ tenantId: TENANT, actorId: USER });
    });

    it('no tenant at all → OUTBOX_TENANT_REQUIRED (before the contract check)', () => {
      for (const build of [
        () => writer.record(ORDER_PLACED_EVENT, orderPlaced()),
        () => writer.record(CATALOG_UPDATED_EVENT, { sku: 's' }),
        () => runWithPrincipal(userOnly, () => writer.record(ORDER_PLACED_EVENT, orderPlaced())),
      ]) {
        const error = thrown(build);
        expect(error).toBeInstanceOf(OutboxError);
        expect(errorCode(error)).toBe('OUTBOX_TENANT_REQUIRED');
      }
    });

    it('validates the payload (InvalidEventException)', () => {
      expect(() =>
        writer.record(ORDER_PLACED_EVENT, { orderId: 'x', totalMinor: 1 }, { tenantId: TENANT }),
      ).toThrow(InvalidEventException);
    });
  });
});
