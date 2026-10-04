import { DomainValidationException } from '@app/common';
import { Logger } from '@nestjs/common';
import { EventPublisher, type IEvent } from '@nestjs/cqrs';
import { beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  createTestStripeService,
  InMemoryBillingStore,
  InMemoryPaymentsRepository,
  InMemoryStripeEventsRepository,
  installTestTransactionHost,
  makeCheckoutSession,
  makePayment,
  type SignedWebhook,
  signedEvent,
  type TestTransactions,
} from '../../../../test/billing-test.utils.js';
import { PaymentSucceededEvent } from '../../../domain/events/payment-succeeded.event.js';
import type { Payment } from '../../../domain/payment.aggregate.js';
import { PaymentStatus } from '../../../domain/payment-status.enum.js';
import { HandleStripeWebhookCommand } from './handle-stripe-webhook.command.js';
import { HandleStripeWebhookHandler } from './handle-stripe-webhook.handler.js';

describe('HandleStripeWebhookHandler', () => {
  let store: InMemoryBillingStore;
  let payments: InMemoryPaymentsRepository;
  let tx: TestTransactions;
  let published: IEvent[];
  let publishedDuringTransaction: boolean;
  let handler: HandleStripeWebhookHandler;
  let payment: Payment;
  let paidWithoutCurrency: { inc: Mock<() => void> };

  const deliver = (webhook: SignedWebhook) =>
    handler.execute(new HandleStripeWebhookCommand(webhook.payload, webhook.signature));

  const completed = (overrides: Record<string, unknown> = {}, id?: string) =>
    signedEvent(
      'checkout.session.completed',
      {
        ...makeCheckoutSession({
          id: 'cs_paid_1',
          client_reference_id: payment.id,
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 2_500,
          currency: 'usd',
          status: 'complete',
        }),
        ...overrides,
      },
      { id, created: 1_790_000_000 },
    );

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    store = new InMemoryBillingStore();
    payments = new InMemoryPaymentsRepository(store);
    tx = installTestTransactionHost(store);
    published = [];
    publishedDuringTransaction = false;
    const eventBus = {
      publish: vi.fn(),
      publishAll: vi.fn((events: IEvent[]) => {
        publishedDuringTransaction ||= tx.active;
        published.push(...events);
      }),
    };
    paidWithoutCurrency = { inc: vi.fn<() => void>() };
    handler = new HandleStripeWebhookHandler(
      createTestStripeService(),
      new InMemoryStripeEventsRepository(store),
      payments,
      new EventPublisher(eventBus as never),
      paidWithoutCurrency,
    );
    payment = makePayment({
      stripeCheckoutSessionId: 'cs_paid_1',
      amountTotal: 2_500,
      currency: 'usd',
    });
    store.seed(payment);
  });

  it('checkout.session.completed → succeeded + PaymentSucceededEvent after the transaction', async () => {
    const webhook = completed({}, 'evt_completed_1');

    const response = await deliver(webhook);

    expect(response).toEqual({
      received: true,
      eventId: 'evt_completed_1',
      eventType: 'checkout.session.completed',
      duplicate: false,
    });
    expect(store.payment(payment.id)).toMatchObject({
      status: PaymentStatus.Succeeded,
      stripePaymentIntentId: 'pi_1',
      paidAt: new Date(1_790_000_000 * 1_000),
      version: 1,
    });
    expect(store.state.events.get('evt_completed_1')).toEqual({
      id: 'evt_completed_1',
      type: 'checkout.session.completed',
    });
    expect(tx).toMatchObject({ begun: 1, rolledBack: 0 });
    expect(published).toHaveLength(1);
    expect(published[0]).toBeInstanceOf(PaymentSucceededEvent);
    expect(published[0]).toMatchObject({
      paymentId: payment.id,
      amountTotal: 2_500,
      currency: 'usd',
    });
    expect(publishedDuringTransaction).toBe(false);
  });

  it('uses the stored currency when the completed session reports none', async () => {
    await deliver(completed({ currency: null }, 'evt_no_currency_1'));

    expect(store.payment(payment.id)).toMatchObject({
      status: PaymentStatus.Succeeded,
      currency: 'usd',
    });
    expect(published[0]).toMatchObject({ currency: 'usd' });
    expect(paidWithoutCurrency.inc).not.toHaveBeenCalled();
  });

  it('paid session without any currency: acknowledged, warned + counted, never announced with ""', async () => {
    const unpriced = makePayment({ stripeCheckoutSessionId: 'cs_unpriced_1' });
    store.seed(unpriced);
    const warn = vi.spyOn(Logger.prototype, 'warn');

    const response = await deliver(
      completed(
        { id: 'cs_unpriced_1', client_reference_id: unpriced.id, currency: '' },
        'evt_no_currency_2',
      ),
    );

    expect(response).toMatchObject({ received: true, duplicate: false });
    expect(store.state.events.has('evt_no_currency_2')).toBe(true);
    expect(store.payment(unpriced.id)).toMatchObject({
      status: PaymentStatus.Pending,
      version: 0,
    });
    expect(published).toEqual([]);
    expect(paidWithoutCurrency.inc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('neither it nor payment'));
    expect(tx.rolledBack).toBe(0);
    warn.mockRestore();
  });

  it('acknowledges a duplicate delivery without re-applying it', async () => {
    const webhook = completed({}, 'evt_dup_1');
    await deliver(webhook);

    const replay = await deliver(webhook);

    expect(replay).toMatchObject({ received: true, duplicate: true, eventId: 'evt_dup_1' });
    expect(published).toHaveLength(1);
    expect(store.payment(payment.id)?.version).toBe(1);
  });

  it('finds the payment by client_reference_id when the session id was never stored', async () => {
    const unbound = makePayment();
    store.seed(unbound);

    await deliver(completed({ id: 'cs_unbound', client_reference_id: unbound.id }));

    expect(store.payment(unbound.id)).toMatchObject({
      status: PaymentStatus.Succeeded,
      stripeCheckoutSessionId: 'cs_unbound',
    });
  });

  it('keeps a completed-but-unpaid (async) session pending until async_payment_succeeded', async () => {
    await deliver(completed({ payment_status: 'unpaid' }));
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Pending);
    expect(published).toEqual([]);

    await deliver(
      signedEvent(
        'checkout.session.async_payment_succeeded',
        makeCheckoutSession({
          id: 'cs_paid_1',
          client_reference_id: payment.id,
          payment_status: 'paid',
        }),
      ),
    );
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    expect(published).toHaveLength(1);
  });

  it('checkout.session.async_payment_failed → failed', async () => {
    await deliver(
      signedEvent(
        'checkout.session.async_payment_failed',
        makeCheckoutSession({ id: 'cs_paid_1', client_reference_id: payment.id }),
      ),
    );
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Failed);
    expect(published).toEqual([]);
  });

  it('checkout.session.expired → expired', async () => {
    const response = await deliver(
      signedEvent(
        'checkout.session.expired',
        makeCheckoutSession({ id: 'cs_paid_1', status: 'expired' }),
      ),
    );

    expect(response).toMatchObject({ eventType: 'checkout.session.expired', duplicate: false });
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Expired);
    expect(published).toEqual([]);
  });

  it('acknowledges (and records) unrelated event types without touching payments', async () => {
    const response = await deliver(
      signedEvent('customer.created', { id: 'cus_1', object: 'customer' }, { id: 'evt_other' }),
    );

    expect(response).toEqual({
      received: true,
      eventId: 'evt_other',
      eventType: 'customer.created',
      duplicate: false,
    });
    expect(store.state.events.has('evt_other')).toBe(true);
    expect(store.payment(payment.id)?.version).toBe(0);
  });

  it('acknowledges events for unknown payments and impossible transitions', async () => {
    await expect(
      deliver(completed({ id: 'cs_unknown', client_reference_id: null })),
    ).resolves.toMatchObject({ received: true });

    await deliver(completed({}, 'evt_first'));
    // A second, different completion event for an already succeeded payment: no-op, no event.
    await expect(deliver(completed({}, 'evt_second'))).resolves.toMatchObject({ duplicate: false });
    expect(published).toHaveLength(1);
  });

  it('rejects an invalid signature before any database work', async () => {
    const webhook = completed();
    const forged = signedEvent('checkout.session.completed', {}, { secret: 'whsec_attacker' });

    const error = await deliver({ ...webhook, signature: forged.signature }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DomainValidationException);
    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE', httpStatus: 422 });
    expect(tx.begun).toBe(0);
    expect(store.state.events.size).toBe(0);
  });

  it('rejects a missing signature and a tampered body', async () => {
    const webhook = completed();
    await expect(
      handler.execute(new HandleStripeWebhookCommand(webhook.payload, undefined)),
    ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });

    const tampered = Buffer.from(webhook.payload.toString('utf8').replace('2500', '1'));
    await expect(
      handler.execute(new HandleStripeWebhookCommand(tampered, webhook.signature)),
    ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rolls back (forgetting the event id) on infrastructure errors so Stripe’s retry is applied', async () => {
    const webhook = completed({}, 'evt_retry');
    const saveSpy = vi.spyOn(payments, 'save').mockRejectedValueOnce(new Error('connection reset'));

    await expect(deliver(webhook)).rejects.toThrow('connection reset');
    expect(tx.rolledBack).toBe(1);
    expect(store.state.events.has('evt_retry')).toBe(false);
    expect(published).toEqual([]);

    saveSpy.mockRestore();
    await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: false });
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    expect(published).toHaveLength(1);
  });
});
