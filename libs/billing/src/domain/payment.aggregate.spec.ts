import { DomainValidationException, generateId } from '@app/common';
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
          Payment.initiate({ id: generateId(), userId: ' ', priceId: '', quantity: 0.5, now });
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
});
