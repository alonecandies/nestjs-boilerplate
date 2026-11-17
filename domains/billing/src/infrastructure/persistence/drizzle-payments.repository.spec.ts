import { TEST_TENANT_ID } from '@platform/auth/testing';
import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { type DrizzleDB, SystemDatabase, TransactionHost } from '@platform/database';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRecordingDrizzle,
  installRlsTransactionHost,
  makePayment,
  paymentRowValues,
  type RecordedQuery,
  rlsContextStatement,
} from '../../../test/billing-test.utils.js';
import type { PaymentsRepository } from '../../application/repositories/payments.repository.js';
import type { StripeEventsRepository } from '../../application/repositories/stripe-events.repository.js';
import { PaymentConcurrentlyModifiedException } from '../../domain/billing.errors.js';
import type { Payment } from '../../domain/payment.aggregate.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import type { BillingSchema } from './billing.schema.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './drizzle-stripe-events.repository.js';
import { DrizzleStripeEventsSystemRepository } from './drizzle-stripe-events.system-repository.js';

/**
 * Real Drizzle SQL generation (snake_case casing) against a recording postgres.js fake, through the
 * real transactional adapter: every runtime method is a unit of work (BEGIN, the principal's RLS
 * context, the statement, COMMIT) and refuses to start without a principal.
 */
describe('Drizzle billing repositories (generated SQL + row mapping)', () => {
  const tenantId = TEST_TENANT_ID;
  const userId = generateId();
  const member = createPrincipal({ userId, tenantId, roles: ['member'] });
  const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(member, fn);
  const context = rlsContextStatement(userId, tenantId);
  let answers: unknown[][][];
  let queries: RecordedQuery[];
  let transcript: string[];
  let repository: DrizzlePaymentsRepository;
  let events: DrizzleStripeEventsRepository;
  let system: DrizzleStripeEventsSystemRepository;

  beforeEach(() => {
    answers = [];
    const recording = createRecordingDrizzle(() => answers.shift() ?? []);
    queries = recording.queries;
    transcript = recording.transcript;
    const host = installRlsTransactionHost(recording.db);
    repository = new DrizzlePaymentsRepository(host);
    events = new DrizzleStripeEventsRepository(host);
    system = new DrizzleStripeEventsSystemRepository(
      new SystemDatabase(recording.db as DrizzleDB<BillingSchema>),
    );
  });

  const lastSql = (): string => queries.at(-1)?.sql ?? '';

  describe('unit of work (B3-8)', () => {
    it('injects only the transaction host: no pool handle, no pool-bound prepared statements', () => {
      expect(Reflect.getMetadata('design:paramtypes', DrizzlePaymentsRepository)).toEqual([
        TransactionHost,
      ]);
      expect(Reflect.getMetadata('design:paramtypes', DrizzleStripeEventsRepository)).toEqual([
        TransactionHost,
      ]);
    });

    /** One invocation per public method of both runtime ports (compile-time exhaustive). */
    const invocations: {
      [K in keyof PaymentsRepository | `events.${keyof StripeEventsRepository}`]: (
        payment: Payment,
      ) => Promise<unknown>;
    } = {
      create: (payment) => repository.create(payment),
      findById: (payment) => repository.findById(tenantId, payment.id),
      findForCheckoutSession: (payment) =>
        repository.findForCheckoutSession({ tenantId, paymentId: payment.id, sessionId: 'cs_1' }),
      save: (payment) => repository.save(payment),
      list: () => repository.list({ tenantId, userId, limit: 2 }),
      'events.markProcessed': () =>
        events.markProcessed({ tenantId, userId, id: 'evt_uow', type: 'x' }),
    };

    for (const [method, invoke] of Object.entries(invocations)) {
      it(`${method}: a standalone call is one transaction opened with the principal's context`, async () => {
        const payment = makePayment({ tenantId, userId, stripeCheckoutSessionId: 'cs_1' });
        answers.push([paymentRowValues(payment)]);

        await asMember(() => invoke(payment));

        expect(transcript).toHaveLength(4);
        expect(transcript.slice(0, 2)).toEqual(['begin', context]);
        expect(transcript[2]).toBe(queries[0]?.sql);
        expect(transcript[3]).toBe('commit');
      });

      it(`${method}: without a principal it refuses before BEGIN (RLS_NO_PRINCIPAL)`, async () => {
        await expect(invoke(makePayment({ tenantId, userId }))).rejects.toMatchObject({
          name: 'RlsContextError',
          code: 'RLS_NO_PRINCIPAL',
        });
        expect(transcript).toEqual([]);
      });
    }

    it('joins an open transaction: create then findById share one BEGIN and one context', async () => {
      const host = TransactionHost.getInstance();
      const payment = makePayment({ tenantId, userId });
      answers.push([paymentRowValues(payment)], [paymentRowValues(payment)]);

      await asMember(() =>
        host.withTransaction(async () => {
          await repository.create(payment);
          await repository.findById(tenantId, payment.id);
        }),
      );

      expect(transcript).toEqual(['begin', context, queries[0]?.sql, queries[1]?.sql, 'commit']);
    });
  });

  describe('create', () => {
    it('inserts with ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING RETURNING', async () => {
      const payment = makePayment({ idempotencyKey: 'key-00001' });
      answers.push([paymentRowValues(payment)]);

      const result = await asMember(() => repository.create(payment));

      expect(queries).toHaveLength(1);
      expect(lastSql()).toMatch(/^insert into "billing"\."payments" \(/);
      expect(lastSql()).toContain(
        'on conflict ("tenant_id","user_id","idempotency_key") do nothing returning',
      );
      expect(result.created).toBe(true);
      expect(result.payment.toSnapshot()).toEqual(payment.toSnapshot());
    });

    it('returns the existing payment of a replayed idempotency key, in the same transaction', async () => {
      const existing = makePayment({
        idempotencyKey: 'key-00002',
        stripeCheckoutSessionId: 'cs_1',
      });
      answers.push([], [paymentRowValues(existing)]);

      const result = await asMember(() =>
        repository.create(makePayment({ userId: existing.userId, idempotencyKey: 'key-00002' })),
      );

      expect(result).toMatchObject({ created: false });
      expect(result.payment.id).toBe(existing.id);
      expect(queries[1]?.sql).toMatch(
        /where \("billing"\."payments"\."tenant_id" = \$1 and "billing"\."payments"\."user_id" = \$2 and "billing"\."payments"\."idempotency_key" = \$3\) limit \$4$/,
      );
      expect(transcript.filter((line) => line === 'begin')).toHaveLength(1);
    });
  });

  it('findById reads by (tenant_id, id)', async () => {
    const payment = makePayment();
    answers.push([paymentRowValues(payment)]);

    await expect(asMember(() => repository.findById(tenantId, payment.id))).resolves.toMatchObject({
      id: payment.id,
    });
    expect(lastSql()).toMatch(
      /where \("billing"\."payments"\."tenant_id" = \$1 and "billing"\."payments"\."id" = \$2\) limit \$3$/,
    );
    expect(queries[0]?.params).toEqual([tenantId, payment.id, 1]);
  });

  it('findForCheckoutSession locks the row, matching id OR session id', async () => {
    const payment = makePayment({ stripeCheckoutSessionId: 'cs_1' });
    answers.push([paymentRowValues(payment)]);

    const found = await asMember(() =>
      repository.findForCheckoutSession({
        tenantId,
        paymentId: payment.id,
        sessionId: 'cs_1',
      }),
    );

    expect(found?.id).toBe(payment.id);
    expect(lastSql()).toContain(
      'where ("billing"."payments"."tenant_id" = $1 and ("billing"."payments"."id" = $2 or "billing"."payments"."stripe_checkout_session_id" = $3))',
    );
    expect(lastSql()).toMatch(/limit \$4 for update$/);
  });

  describe('save (optimistic lock)', () => {
    it('updates WHERE id AND version, bumping the version', async () => {
      const payment = makePayment({ version: 2 });
      payment.markFailed(new Date());
      answers.push([[payment.id]]);

      await asMember(() => repository.save(payment));

      expect(lastSql()).toMatch(/^update "billing"\."payments" set .*"version" = \$\d+/);
      expect(lastSql()).toContain('"billing"."payments"."tenant_id" = $');
      expect(lastSql()).toContain('where ("billing"."payments"."tenant_id" = $');
      expect(lastSql()).toContain('"billing"."payments"."id" = $');
      expect(lastSql()).toContain('"billing"."payments"."version" = $');
      expect(queries[0]?.params).toEqual(
        expect.arrayContaining([PaymentStatus.Failed, 3, payment.id, 2]),
      );
      expect(payment.version).toBe(3);
    });

    it('throws PaymentConcurrentlyModifiedException when no row matched (and rolls back)', async () => {
      const payment = makePayment({ version: 1 });
      answers.push([]);

      await expect(asMember(() => repository.save(payment))).rejects.toBeInstanceOf(
        PaymentConcurrentlyModifiedException,
      );
      expect(payment.version).toBe(1);
      expect(transcript.at(-1)).toBe('rollback');
    });
  });

  it('lists newest first, fetching one look-ahead row', async () => {
    const [a, b] = [makePayment({ userId }), makePayment({ userId })];
    answers.push([paymentRowValues(b), paymentRowValues(a)], []);

    const mine = await asMember(() => repository.list({ tenantId, userId, limit: 2 }));
    const all = await asMember(() => repository.list({ tenantId, limit: 50 }));

    expect(mine.items.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(mine.nextCursor).toBeNull(); // 2 rows for limit 2: no look-ahead row → last page
    expect(all).toEqual({ items: [], nextCursor: null });
    expect(queries[0]).toMatchObject({ params: [tenantId, userId, 3] });
    expect(queries[0]?.sql).toMatch(
      /where \("billing"\."payments"\."tenant_id" = \$1 and "billing"\."payments"\."user_id" = \$2\) order by "billing"\."payments"\."id" desc limit \$3$/,
    );
    expect(queries[1]).toMatchObject({ params: [tenantId, 51] });
    expect(queries[1]?.sql).toMatch(
      /where "billing"\."payments"\."tenant_id" = \$1 order by "billing"\."payments"\."id" desc limit \$2$/,
    );
  });

  it('pages with a keyset cursor: the look-ahead row yields nextCursor, which resumes after it', async () => {
    // Explicit, ordered uuidv7 ids (newest = highest): c > b > a.
    const [a, b, c] = ['d1', 'd2', 'd3'].map((suffix) =>
      makePayment({ id: `01920000-0000-7000-8000-0000000000${suffix}`, userId }),
    ) as [Payment, Payment, Payment];
    answers.push(
      [paymentRowValues(c), paymentRowValues(b), paymentRowValues(a)],
      [paymentRowValues(a)],
      [],
    );

    const first = await asMember(() => repository.list({ tenantId, userId, limit: 2 }));
    expect(first.items.map((p) => p.id)).toEqual([c.id, b.id]);
    const cursor = first.nextCursor ?? expect.fail('expected a next page');

    const second = await asMember(() => repository.list({ tenantId, userId, limit: 2, cursor }));
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((p) => p.id)).toEqual([a.id]);
    expect(queries[1]?.sql).toMatch(
      /where \("billing"\."payments"\."tenant_id" = \$1 and "billing"\."payments"\."user_id" = \$2 and "billing"\."payments"\."id" < \$3\) order by "billing"\."payments"\."id" desc limit \$4$/,
    );
    expect(queries[1]?.params).toEqual([tenantId, userId, b.id, 3]);

    // The whole tenant (`billing:read-all`): the (tenant_id, id) primary key.
    await asMember(() => repository.list({ tenantId, limit: 2, cursor }));
    expect(queries[2]?.sql).toMatch(
      /where \("billing"\."payments"\."tenant_id" = \$1 and "billing"\."payments"\."id" < \$2\) order by "billing"\."payments"\."id" desc limit \$3$/,
    );
    expect(queries[2]?.params).toEqual([tenantId, b.id, 3]);
  });

  it('rejects a forged cursor with INVALID_CURSOR before any SQL', async () => {
    await expect(
      asMember(() => repository.list({ tenantId, limit: 2, cursor: 'not-a-cursor' })),
    ).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    expect(queries).toHaveLength(0);
    expect(transcript).toEqual([]);
  });

  it('stripe_events: ON CONFLICT (tenant_id, id) DO NOTHING tells first delivery from duplicates', async () => {
    answers.push([['evt_1']], []);

    const receipt = { tenantId, userId, id: 'evt_1', type: 'x' };
    await expect(asMember(() => events.markProcessed(receipt))).resolves.toBe(true);
    await expect(asMember(() => events.markProcessed(receipt))).resolves.toBe(false);
    expect(lastSql()).toBe(
      'insert into "billing"."stripe_events" ("tenant_id", "id", "user_id", "type", "processed_at") values ($1, $2, $3, $4, default) on conflict ("tenant_id","id") do nothing returning "id"',
    );
  });

  describe('stripe_events system repository (system pool, SystemContext only)', () => {
    const inSystem = <T>(fn: () => Promise<T>): Promise<T> =>
      SystemContext.run('billing.repository-spec', fn);

    it('purge: one multi-shard DELETE of rows processed before the cutoff, no transaction', async () => {
      const cutoff = new Date('2026-09-05T00:00:00.000Z');
      // postgres.js result of a DELETE without RETURNING: no rows, `count` = affected rows.
      const deleteResult: unknown[][] = Object.assign([], { count: 2 });
      answers.push(deleteResult);

      await expect(inSystem(() => system.deleteProcessedBefore(cutoff))).resolves.toBe(2);

      // No subquery and no LIMIT (Citus cannot push either down on a distributed table), no row lock.
      expect(queries).toHaveLength(1);
      expect(lastSql()).toBe(
        'delete from "billing"."stripe_events" where "billing"."stripe_events"."processed_at" < $1',
      );
      expect(queries.at(-1)?.params).toEqual([cutoff.toISOString()]);
      expect(transcript).toEqual([lastSql()]); // no BEGIN, no RLS context
    });

    it('markProcessedAsPlatform: ON CONFLICT DO NOTHING RETURNING, true once then false', async () => {
      answers.push([['evt_payout']], []);
      const receipt = { tenantId: PLATFORM_TENANT_ID, userId: null, id: 'evt_payout', type: 'p' };

      await expect(inSystem(() => system.markProcessedAsPlatform(receipt))).resolves.toBe(true);
      await expect(inSystem(() => system.markProcessedAsPlatform(receipt))).resolves.toBe(false);
      expect(lastSql()).toBe(
        'insert into "billing"."stripe_events" ("tenant_id", "id", "user_id", "type", "processed_at") values ($1, $2, $3, $4, default) on conflict ("tenant_id","id") do nothing returning "id"',
      );
      expect(queries.at(-1)?.params).toEqual([PLATFORM_TENANT_ID, 'evt_payout', null, 'p']);
      expect(transcript).not.toContain('begin');
    });

    it('markProcessedAsPlatform keeps a user-less tenant receipt in its tenant', async () => {
      answers.push([['evt_t']]);
      await inSystem(() =>
        system.markProcessedAsPlatform({ tenantId, userId: null, id: 'evt_t', type: 't' }),
      );
      expect(queries.at(-1)?.params).toEqual([tenantId, 'evt_t', null, 't']);
    });

    it('markProcessedAsPlatform refuses a receipt with a user, before any SQL', async () => {
      await expect(
        inSystem(() =>
          system.markProcessedAsPlatform({ tenantId, userId, id: 'evt_user', type: 'x' }),
        ),
      ).rejects.toThrow(/user/);
      expect(transcript).toEqual([]);
    });

    it('both methods refuse outside SystemContext, also under a principal (SYSTEM_CONTEXT_REQUIRED)', async () => {
      const receipt = { tenantId: PLATFORM_TENANT_ID, userId: null, id: 'evt_x', type: 'x' };
      const refused = { name: 'SystemDatabaseError', code: 'SYSTEM_CONTEXT_REQUIRED' };
      await expect(system.deleteProcessedBefore(new Date())).rejects.toMatchObject(refused);
      await expect(system.markProcessedAsPlatform(receipt)).rejects.toMatchObject(refused);
      await expect(asMember(() => system.deleteProcessedBefore(new Date()))).rejects.toMatchObject(
        refused,
      );
      await expect(asMember(() => system.markProcessedAsPlatform(receipt))).rejects.toMatchObject(
        refused,
      );
      expect(transcript).toEqual([]);
    });
  });
});
