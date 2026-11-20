import { TEST_TENANT_ID } from '@platform/auth/testing';
import { DomainValidationException, generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { makePayment } from '../../test/billing-test.utils.js';
import { CheckoutSessionMismatchException, InvalidPaymentException } from './billing.errors.js';
import { PaymentSucceededEvent } from './events/payment-succeeded.event.js';
import { Payment } from './payment.aggregate.js';
import { PaymentStatus } from './payment-status.enum.js';

const now = new Date('2026-09-02T12:00:00.000Z');
const paidAt = new Date('2026-09-02T11:59:00.000Z');

describe('Payment aggregate', () => {
  describe('initiate', () => {
    it('creates a pending, unpriced payment with version 0 and no events', () => {
      const id = generateId();
      const payment = Payment.initiate({
        id,
        tenantId: TEST_TENANT_ID,
        userId: generateId(),
        priceId: '  price_pro  ',
        quantity: 3,
        idempotencyKey: 'order-42-attempt',
        now,
      });

      expect(payment.toSnapshot()).toMatchObject({
        id,
        priceId: 'price_pro',
        quantity: 3,
        status: PaymentStatus.Pending,
        amountTotal: null,
        currency: null,
        stripeCheckoutSessionId: null,
        idempotencyKey: 'order-42-attempt',
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
      expect(payment.getUncommittedEvents()).toEqual([]);
    });

    it('rejects invalid quantity / price / user with every issue at once', () => {
      const error = (() => {
        try {
          Payment.initiate({
            id: generateId(),
            tenantId: TEST_TENANT_ID,
            userId: ' ',
            priceId: '',
            quantity: 0.5,
            now,
          });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();

      expect(error).toBeInstanceOf(InvalidPaymentException);
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as InvalidPaymentException).issues.map((i) => i.path)).toEqual([
        'priceId',
        'quantity',
        'userId',
      ]);
    });

    it('matches replays by price and quantity only', () => {
      const payment = makePayment({ priceId: 'price_a', quantity: 2 });
      expect(payment.matchesRequest({ priceId: ' price_a ', quantity: 2 })).toBe(true);
      expect(payment.matchesRequest({ priceId: 'price_a', quantity: 3 })).toBe(false);
      expect(payment.matchesRequest({ priceId: 'price_b', quantity: 2 })).toBe(false);
    });
  });

  describe('attachCheckoutSession', () => {
    it('binds the session and its pricing (currency lowercased)', () => {
      const payment = makePayment();
      const changed = payment.attachCheckoutSession(
        { id: 'cs_1', amountTotal: 4_200, currency: 'EUR' },
        now,
      );

      expect(changed).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 4_200,
        currency: 'eur',
        status: PaymentStatus.Pending,
        updatedAt: now,
      });
    });

    it('is a no-op for a replay of the same session', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 100,
        currency: 'usd',
      });
      expect(
        payment.attachCheckoutSession({ id: 'cs_1', amountTotal: 100, currency: 'usd' }, now),
      ).toBe(false);
    });

    it('reopens a payment whose session creation failed (retried idempotent request)', () => {
      const payment = makePayment({ status: PaymentStatus.Failed });
      expect(
        payment.attachCheckoutSession({ id: 'cs_2', amountTotal: 1, currency: 'usd' }, now),
      ).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Pending);
    });

    it('never reopens a payment whose async payment failed', () => {
      const payment = makePayment({
        status: PaymentStatus.Failed,
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 1,
        currency: 'usd',
      });
      expect(
        payment.attachCheckoutSession({ id: 'cs_1', amountTotal: 1, currency: 'usd' }, now),
      ).toBe(false);
      expect(payment.status).toBe(PaymentStatus.Failed);
    });

    it('fills missing pricing on a replay without touching the status', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        status: PaymentStatus.Expired,
      });
      expect(
        payment.attachCheckoutSession({ id: 'cs_1', amountTotal: 300, currency: 'USD' }, now),
      ).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.Expired,
        amountTotal: 300,
        currency: 'usd',
      });
    });

    it('refuses a different session', () => {
      const payment = makePayment({ stripeCheckoutSessionId: 'cs_1' });
      expect(() =>
        payment.attachCheckoutSession({ id: 'cs_other', amountTotal: 1, currency: 'usd' }, now),
      ).toThrow(CheckoutSessionMismatchException);
    });

    it('refuses to bind a session to a settled payment that never had one', () => {
      const payment = makePayment({ status: PaymentStatus.Succeeded });
      expect(() =>
        payment.attachCheckoutSession({ id: 'cs_1', amountTotal: 1, currency: 'usd' }, now),
      ).toThrow(CheckoutSessionMismatchException);
    });

    it('ignores a late replay once the payment succeeded', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        status: PaymentStatus.Succeeded,
        amountTotal: 1,
        currency: 'usd',
      });
      expect(
        payment.attachCheckoutSession({ id: 'cs_1', amountTotal: 1, currency: 'usd' }, now),
      ).toBe(false);
      expect(payment.status).toBe(PaymentStatus.Succeeded);
    });
  });

  describe('complete', () => {
    it('succeeds once and applies PaymentSucceededEvent with the Stripe totals', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 999,
        currency: 'usd',
      });

      const changed = payment.complete(
        { sessionId: 'cs_1', paymentIntentId: 'pi_1', amountTotal: 2_000, currency: 'USD', paidAt },
        now,
      );

      expect(changed).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.Succeeded,
        stripePaymentIntentId: 'pi_1',
        amountTotal: 2_000,
        currency: 'usd',
        paidAt,
      });
      const [event] = payment.getUncommittedEvents();
      expect(event).toBeInstanceOf(PaymentSucceededEvent);
      expect(event).toMatchObject({
        paymentId: payment.id,
        userId: payment.userId,
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 2_000,
        currency: 'usd',
        paidAt,
      });

      // Replay: no second transition, no second event.
      expect(
        payment.complete(
          {
            sessionId: 'cs_1',
            paymentIntentId: 'pi_1',
            amountTotal: 2_000,
            currency: 'usd',
            paidAt,
          },
          now,
        ),
      ).toBe(false);
      expect(payment.getUncommittedEvents()).toHaveLength(1);
    });

    it('refuses a paid completion when no amount is known (no ?? 0, S-5)', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: null,
        currency: 'usd',
      });
      const done = payment.complete(
        {
          sessionId: 'cs_1',
          paymentIntentId: 'pi_1',
          amountTotal: null,
          currency: 'usd',
          paidAt: new Date(),
        },
        new Date(),
      );
      expect(done).toBe(false);
      expect(payment.status).toBe(PaymentStatus.Pending);
      expect(payment.getUncommittedEvents()).toEqual([]);
    });

    it('records what Stripe charged and carries the PaymentIntent id on the event (S-5, S-8)', () => {
      const payment = makePayment({
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 2_500,
        currency: 'usd',
      });
      payment.complete(
        {
          sessionId: 'cs_1',
          paymentIntentId: 'pi_9',
          amountTotal: 2_000,
          currency: 'usd',
          paidAt: new Date(),
        },
        new Date(),
      );
      expect(payment.amountTotal).toBe(2_000);
      expect(payment.getUncommittedEvents()).toEqual([
        expect.objectContaining({ amountTotal: 2_000, stripePaymentIntentId: 'pi_9' }),
      ]);
    });

    it('binds the session when the creation response was never saved (crash after Stripe)', () => {
      const payment = makePayment();
      expect(
        payment.complete(
          { sessionId: 'cs_9', paymentIntentId: null, amountTotal: 10, currency: 'usd', paidAt },
          now,
        ),
      ).toBe(true);
      expect(payment.stripeCheckoutSessionId).toBe('cs_9');
    });

    it.each([null, '', '  ', 'dollars'])(
      'falls back to the stored currency when Stripe reports %j',
      (reported) => {
        const payment = makePayment({ stripeCheckoutSessionId: 'cs_1', currency: 'eur' });

        expect(
          payment.complete(
            {
              sessionId: 'cs_1',
              paymentIntentId: null,
              amountTotal: 5,
              currency: reported,
              paidAt,
            },
            now,
          ),
        ).toBe(true);

        expect(payment.toSnapshot().currency).toBe('eur');
        expect(payment.getUncommittedEvents()[0]).toMatchObject({ currency: 'eur' });
      },
    );

    it('refuses to complete (no state change, no event) when no currency is known at all', () => {
      // Stored '' = a row priced before currencies were validated.
      for (const stored of [null, '']) {
        const payment = makePayment({ stripeCheckoutSessionId: 'cs_1', currency: stored });

        expect(
          payment.complete(
            { sessionId: 'cs_1', paymentIntentId: 'pi_1', amountTotal: 5, currency: '', paidAt },
            now,
          ),
        ).toBe(false);

        expect(payment.status).toBe(PaymentStatus.Pending);
        expect(payment.getUncommittedEvents()).toEqual([]);
      }
    });

    it('does not apply to expired payments or foreign sessions', () => {
      const expired = makePayment({
        status: PaymentStatus.Expired,
        stripeCheckoutSessionId: 'cs_1',
      });
      const foreign = makePayment({ stripeCheckoutSessionId: 'cs_1' });
      const completion = {
        sessionId: 'cs_2',
        paymentIntentId: null,
        amountTotal: 1,
        currency: 'usd',
        paidAt,
      };

      expect(expired.complete({ ...completion, sessionId: 'cs_1' }, now)).toBe(false);
      expect(foreign.complete(completion, now)).toBe(false);
      expect(foreign.getUncommittedEvents()).toEqual([]);
    });
  });

  describe('markFailed / expire / markPersisted', () => {
    it('follows the status machine', () => {
      const payment = makePayment();
      expect(payment.markFailed(now)).toBe(true);
      expect(payment.markFailed(now)).toBe(false);
      expect(payment.expire(now)).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Expired);
      expect(payment.expire(now)).toBe(false);

      const succeeded = makePayment({ status: PaymentStatus.Succeeded });
      expect(succeeded.markFailed(now)).toBe(false);
      expect(succeeded.expire(now)).toBe(false);
    });

    it('increments the optimistic-lock version', () => {
      const payment = makePayment({ version: 4 });
      payment.markPersisted();
      expect(payment.version).toBe(5);
    });
  });

  describe('refund / dispute / reinstate (ledger S-6, L-11)', () => {
    const later = new Date('2026-09-10T08:00:00.000Z');
    const at = (status: PaymentStatus, amountRefunded = 0) =>
      makePayment({ status, amountTotal: 2_500, currency: 'usd', paidAt, amountRefunded });

    it('refund(full) moves succeeded → refunded, refund(partial) → partially_refunded', () => {
      const full = at(PaymentStatus.Succeeded);
      expect(full.refund(2_500, true, later)).toBe(true);
      expect(full.toSnapshot()).toMatchObject({
        status: PaymentStatus.Refunded,
        amountRefunded: 2_500,
        updatedAt: later,
        paidAt,
        amountTotal: 2_500,
      });

      const partial = at(PaymentStatus.Succeeded);
      expect(partial.refund(500, false, later)).toBe(true);
      expect(partial.toSnapshot()).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 500,
      });
    });

    it('a partially refunded payment can be refunded in full', () => {
      const payment = at(PaymentStatus.PartiallyRefunded, 500);
      expect(payment.refund(2_500, true, later)).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Refunded);
    });

    it('a second partial refund records the new refunded total; an older, smaller total changes nothing', () => {
      const payment = at(PaymentStatus.PartiallyRefunded, 500);
      expect(payment.refund(1_500, false, later)).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 1_500,
      });
      const before = payment.toSnapshot();
      expect(payment.refund(500, false, later)).toBe(false);
      expect(payment.toSnapshot()).toEqual(before);
    });

    it('a failed full refund (refund.failed) restores succeeded', () => {
      const payment = at(PaymentStatus.Succeeded);
      payment.refund(2_500, true, later);

      expect(payment.failRefund(2_500, later)).toBe(true);

      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.Succeeded,
        amountRefunded: 0,
        updatedAt: later,
        paidAt,
      });
    });

    it('a failed partial refund restores succeeded, or partially_refunded while other refunds remain', () => {
      const only = at(PaymentStatus.Succeeded);
      only.refund(500, false, later);
      expect(only.failRefund(500, later)).toBe(true);
      expect(only.toSnapshot()).toMatchObject({
        status: PaymentStatus.Succeeded,
        amountRefunded: 0,
      });

      const two = at(PaymentStatus.Succeeded);
      two.refund(500, false, later);
      two.refund(1_500, false, later);
      expect(two.failRefund(500, later)).toBe(true);
      expect(two.toSnapshot()).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 1_000,
      });

      // A full refund made of two refunds, one of which fails: the other remains.
      const split = at(PaymentStatus.Succeeded);
      split.refund(1_000, false, later);
      split.refund(2_500, true, later);
      expect(split.failRefund(1_500, later)).toBe(true);
      expect(split.toSnapshot()).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 1_000,
      });
    });

    it('failRefund changes nothing without a recorded refund, and keeps a disputed payment disputed', () => {
      for (const status of [
        PaymentStatus.Pending,
        PaymentStatus.Failed,
        PaymentStatus.Expired,
        PaymentStatus.Succeeded,
      ]) {
        const payment = at(status);
        const before = payment.toSnapshot();
        expect(payment.failRefund(500, later), status).toBe(false);
        expect(payment.toSnapshot()).toEqual(before);
      }
      const disputed = at(PaymentStatus.Disputed, 500);
      expect(disputed.failRefund(500, later)).toBe(true);
      expect(disputed.toSnapshot()).toMatchObject({
        status: PaymentStatus.Disputed,
        amountRefunded: 0,
      });
    });

    it('a refund failure larger than what is recorded leaves nothing refunded (never negative)', () => {
      const payment = at(PaymentStatus.PartiallyRefunded, 500);
      expect(payment.failRefund(2_000, later)).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.Succeeded,
        amountRefunded: 0,
      });
    });

    it('dispute() moves succeeded and partially_refunded → disputed', () => {
      for (const status of [PaymentStatus.Succeeded, PaymentStatus.PartiallyRefunded]) {
        const payment = at(status);
        expect(payment.dispute(later)).toBe(true);
        expect(payment.toSnapshot()).toMatchObject({
          status: PaymentStatus.Disputed,
          updatedAt: later,
        });
      }
    });

    it('reinstate() moves disputed → succeeded', () => {
      const payment = at(PaymentStatus.Disputed);
      expect(payment.reinstate(later)).toBe(true);
      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.Succeeded,
        updatedAt: later,
        paidAt,
      });
    });

    it('a partially refunded payment disputed then reinstated is partially_refunded again', () => {
      const payment = at(PaymentStatus.Succeeded);
      payment.refund(500, false, later);
      expect(payment.dispute(later)).toBe(true);

      expect(payment.reinstate(later)).toBe(true);

      expect(payment.toSnapshot()).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 500,
        updatedAt: later,
      });
    });

    it('a dispute reinstated after its only refund failed is succeeded', () => {
      const payment = at(PaymentStatus.PartiallyRefunded, 500);
      payment.dispute(later);
      payment.failRefund(500, later);

      expect(payment.reinstate(later)).toBe(true);

      expect(payment.status).toBe(PaymentStatus.Succeeded);
    });

    it.each([PaymentStatus.Pending, PaymentStatus.Failed, PaymentStatus.Expired])(
      'refuses every new transition from %s (no state change, no event)',
      (status) => {
        const payment = at(status);
        const before = payment.toSnapshot();
        expect(payment.refund(2_500, true, later)).toBe(false);
        expect(payment.refund(500, false, later)).toBe(false);
        expect(payment.dispute(later)).toBe(false);
        expect(payment.reinstate(later)).toBe(false);
        expect(payment.toSnapshot()).toEqual(before);
        expect(payment.getUncommittedEvents()).toEqual([]);
      },
    );

    it('a repeat changes nothing', () => {
      const cases: [PaymentStatus, (payment: Payment) => boolean][] = [
        [PaymentStatus.Refunded, (p) => p.refund(2_500, true, later)],
        [PaymentStatus.Refunded, (p) => p.refund(500, false, later)],
        [PaymentStatus.PartiallyRefunded, (p) => p.refund(500, false, later)],
        [PaymentStatus.Disputed, (p) => p.dispute(later)],
        [PaymentStatus.Succeeded, (p) => p.reinstate(later)],
      ];
      for (const [status, repeat] of cases) {
        const payment = at(status, status === PaymentStatus.Succeeded ? 0 : 500);
        const before = payment.toSnapshot();
        expect(repeat(payment), status).toBe(false);
        expect(payment.toSnapshot()).toEqual(before);
      }
    });

    it('refuses a dispute of a refunded payment and a refund of a disputed one', () => {
      const refunded = at(PaymentStatus.Refunded);
      expect(refunded.dispute(later)).toBe(false);
      expect(refunded.status).toBe(PaymentStatus.Refunded);
      const disputed = at(PaymentStatus.Disputed);
      expect(disputed.refund(2_500, true, later)).toBe(false);
      expect(disputed.status).toBe(PaymentStatus.Disputed);
    });
  });

  describe('tenant', () => {
    const base = {
      id: generateId(),
      userId: generateId(),
      priceId: 'price_pro',
      quantity: 1,
      now: new Date(),
    };

    it('belongs to the tenant it was initiated in and keeps the request hash', () => {
      const payment = Payment.initiate({
        ...base,
        tenantId: TEST_TENANT_ID,
        requestHash: 'a'.repeat(64),
      });
      expect(payment.tenantId).toBe(TEST_TENANT_ID);
      expect(payment.requestHash).toBe('a'.repeat(64));
      expect(payment.toSnapshot()).toMatchObject({
        tenantId: TEST_TENANT_ID,
        requestHash: 'a'.repeat(64),
      });
    });

    it.each([PLATFORM_TENANT_ID, 'not-a-uuid', ''])('refuses tenant %j', (tenantId) => {
      expect(() => Payment.initiate({ ...base, tenantId })).toThrow(InvalidPaymentException);
    });
  });
});
