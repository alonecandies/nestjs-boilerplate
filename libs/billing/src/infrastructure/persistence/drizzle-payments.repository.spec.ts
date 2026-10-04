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

  it('lists newest first through the prepared statements', async () => {
    const userId = generateId();
    const [a, b] = [makePayment({ userId }), makePayment({ userId })];
    answers.push([paymentRowValues(b), paymentRowValues(a)], []);

    const mine = await repository.list({ userId, limit: 2 });
    await repository.list({ limit: 50 });

    expect(mine.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(queries[0]).toMatchObject({ params: [userId, 2] });
    expect(queries[0]?.sql).toMatch(
      /where "payments"\."user_id" = \$1 order by "payments"\."id" desc limit \$2$/,
    );
    expect(queries[1]).toMatchObject({ params: [50] });
    expect(queries[1]?.sql).toMatch(/from "payments" order by "payments"\."id" desc limit \$1$/);
  });

  it('stripe_events: ON CONFLICT (id) DO NOTHING tells first delivery from duplicates', async () => {
    answers.push([['evt_1']], []);

    await expect(events.markProcessed({ id: 'evt_1', type: 'x' })).resolves.toBe(true);
    await expect(events.markProcessed({ id: 'evt_1', type: 'x' })).resolves.toBe(false);
    expect(lastSql()).toBe(
      'insert into "stripe_events" ("id", "type", "processed_at") values ($1, $2, default) on conflict ("id") do nothing returning "id"',
    );
  });
});
