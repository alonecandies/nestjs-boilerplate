import { generateId } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRecordingDrizzle,
  installTestTransactionHost,
  makePayment,
  paymentRowValues,
  type RecordedQuery,
} from '../../../test/billing-test.utils.js';
import { PaymentConcurrentlyModifiedException } from '../../domain/billing.errors.js';
import type { Payment } from '../../domain/payment.aggregate.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './drizzle-stripe-events.repository.js';

/** Real Drizzle SQL generation (snake_case casing) against a recording postgres.js fake. */
describe('Drizzle billing repositories (generated SQL + row mapping)', () => {
  let answers: unknown[][][];
  let queries: RecordedQuery[];
  let repository: DrizzlePaymentsRepository;
  let events: DrizzleStripeEventsRepository;

  beforeEach(() => {
    answers = [];
    const recording = createRecordingDrizzle(() => answers.shift() ?? []);
    queries = recording.queries;
    const { host } = installTestTransactionHost(undefined, recording.db);
    repository = new DrizzlePaymentsRepository(host, recording.db);
    events = new DrizzleStripeEventsRepository(host);
  });

  const lastSql = (): string => queries.at(-1)?.sql ?? '';

  describe('create', () => {
    it('inserts with ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING', async () => {
      const payment = makePayment({ idempotencyKey: 'key-00001' });
      answers.push([paymentRowValues(payment)]);

      const result = await repository.create(payment);

      expect(queries).toHaveLength(1);
      expect(lastSql()).toMatch(/^insert into "payments" \(/);
      expect(lastSql()).toContain('on conflict ("user_id","idempotency_key") do nothing returning');
      expect(result.created).toBe(true);
      expect(result.payment.toSnapshot()).toEqual(payment.toSnapshot());
    });

    it('returns the existing payment of a replayed idempotency key', async () => {
      const existing = makePayment({
        idempotencyKey: 'key-00002',
        stripeCheckoutSessionId: 'cs_1',
      });
      answers.push([], [paymentRowValues(existing)]);

      const result = await repository.create(
        makePayment({ userId: existing.userId, idempotencyKey: 'key-00002' }),
      );

      expect(result).toMatchObject({ created: false });
      expect(result.payment.id).toBe(existing.id);
      expect(queries[1]?.sql).toMatch(
        /where \("payments"\."user_id" = \$1 and "payments"\."idempotency_key" = \$2\) limit \$3$/,
      );
    });
  });

  it('findForCheckoutSession locks the row, matching id OR session id', async () => {
    const payment = makePayment({ stripeCheckoutSessionId: 'cs_1' });
    answers.push([paymentRowValues(payment)]);

    const found = await repository.findForCheckoutSession({
      paymentId: payment.id,
      sessionId: 'cs_1',
    });

    expect(found?.id).toBe(payment.id);
    expect(lastSql()).toContain(
      'where ("payments"."id" = $1 or "payments"."stripe_checkout_session_id" = $2)',
    );
    expect(lastSql()).toMatch(/limit \$3 for update$/);
  });

  describe('save (optimistic lock)', () => {
    it('updates WHERE id AND version, bumping the version', async () => {
      const payment = makePayment({ version: 2 });
      payment.markFailed(new Date());
      answers.push([[payment.id]]);

      await repository.save(payment);

      expect(lastSql()).toMatch(/^update "payments" set .*"version" = \$\d+/);
      expect(lastSql()).toContain('where ("payments"."id" = $');
      expect(lastSql()).toContain('"payments"."version" = $');
      expect(queries[0]?.params).toEqual(
        expect.arrayContaining([PaymentStatus.Failed, 3, payment.id, 2]),
      );
      expect(payment.version).toBe(3);
    });

    it('throws PaymentConcurrentlyModifiedException when no row matched', async () => {
      const payment = makePayment({ version: 1 });
      answers.push([]);

      await expect(repository.save(payment)).rejects.toBeInstanceOf(
        PaymentConcurrentlyModifiedException,
      );
      expect(payment.version).toBe(1);
    });
  });

  it('lists newest first through the prepared statements, fetching one look-ahead row', async () => {
    const userId = generateId();
    const [a, b] = [makePayment({ userId }), makePayment({ userId })];
    answers.push([paymentRowValues(b), paymentRowValues(a)], []);

    const mine = await repository.list({ userId, limit: 2 });
    const all = await repository.list({ limit: 50 });

    expect(mine.items.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(mine.nextCursor).toBeNull(); // 2 rows for limit 2: no look-ahead row → last page
    expect(all).toEqual({ items: [], nextCursor: null });
    expect(queries[0]).toMatchObject({ params: [userId, 3] });
    expect(queries[0]?.sql).toMatch(
      /where "payments"\."user_id" = \$1 order by "payments"\."id" desc limit \$2$/,
    );
    expect(queries[1]).toMatchObject({ params: [51] });
    expect(queries[1]?.sql).toMatch(/from "payments" order by "payments"\."id" desc limit \$1$/);
  });

  it('pages with a keyset cursor: the look-ahead row yields nextCursor, which resumes after it', async () => {
    const userId = generateId();
    // Explicit, ordered uuidv7 ids (newest = highest): c > b > a.
    const [a, b, c] = ['d1', 'd2', 'd3'].map((suffix) =>
      makePayment({ id: `01920000-0000-7000-8000-0000000000${suffix}`, userId }),
    ) as [Payment, Payment, Payment];
    answers.push(
      [paymentRowValues(c), paymentRowValues(b), paymentRowValues(a)],
      [paymentRowValues(a)],
      [],
    );

    const first = await repository.list({ userId, limit: 2 });
    expect(first.items.map((p) => p.id)).toEqual([c.id, b.id]);
    const cursor = first.nextCursor ?? expect.fail('expected a next page');

    const second = await repository.list({ userId, limit: 2, cursor });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((p) => p.id)).toEqual([a.id]);
    expect(queries[1]?.sql).toMatch(
      /where \("payments"\."user_id" = \$1 and "payments"\."id" < \$2\) order by "payments"\."id" desc limit \$3$/,
    );
    expect(queries[1]?.params).toEqual([userId, b.id, 3]);

    // Admin listing: the primary key.
    await repository.list({ limit: 2, cursor });
    expect(queries[2]?.sql).toMatch(
      /from "payments" where "payments"\."id" < \$1 order by "payments"\."id" desc limit \$2$/,
    );
    expect(queries[2]?.params).toEqual([b.id, 3]);
  });

  it('rejects a forged cursor with INVALID_CURSOR before any SQL', async () => {
    await expect(repository.list({ limit: 2, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    expect(queries).toHaveLength(0);
  });

  it('stripe_events: ON CONFLICT (id) DO NOTHING tells first delivery from duplicates', async () => {
    answers.push([['evt_1']], []);

    await expect(events.markProcessed({ id: 'evt_1', type: 'x' })).resolves.toBe(true);
    await expect(events.markProcessed({ id: 'evt_1', type: 'x' })).resolves.toBe(false);
    expect(lastSql()).toBe(
      'insert into "stripe_events" ("id", "type", "processed_at") values ($1, $2, default) on conflict ("id") do nothing returning "id"',
    );
  });

  it('stripe_events purge: bounded DELETE of rows processed before the cutoff', async () => {
    const cutoff = new Date('2026-09-05T00:00:00.000Z');
    // postgres.js result of a DELETE without RETURNING: no rows, `count` = affected rows.
    const deleteResult: unknown[][] = Object.assign([], { count: 2 });
    answers.push(deleteResult);

    await expect(events.deleteProcessedBefore(cutoff, 500)).resolves.toBe(2);

    expect(lastSql()).toBe(
      'delete from "stripe_events" where "stripe_events"."id" in (select "id" from "stripe_events" where "stripe_events"."processed_at" < $1 limit $2)',
    );
    expect(queries.at(-1)?.params).toEqual([cutoff.toISOString(), 500]);
  });
});
