import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
  PAYMENT_SUCCEEDED_EVENT,
} from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
import { EventPublisher, type IEvent } from '@nestjs/cqrs';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import {
  DomainValidationException,
  generateId,
  getPrincipal,
  PLATFORM_TENANT_ID,
  SystemContext,
} from '@platform/common';
import { parseEventEnvelope } from '@platform/contracts';
import type { SystemDatabase, SystemMethod } from '@platform/database';
import type { OutboxRecord } from '@platform/outbox';
import { InMemoryOutbox } from '@platform/outbox/testing';
import { FakeKafkaProducer } from '@platform/transport/testing';
import Stripe from 'stripe';
import { v5 as uuidv5 } from 'uuid';
import { beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  createRecordingDrizzle,
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
import { LEDGER_NAMESPACE } from '../../../domain/ledger/ledger.types.js';
import type { Payment } from '../../../domain/payment.aggregate.js';
import { PaymentStatus } from '../../../domain/payment-status.enum.js';
import type { LedgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import { BILLING_OUTBOX } from '../../../infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../../../infrastructure/persistence/drizzle-outbox.system-repository.js';
import { DrizzleStripeEventsSystemRepository } from '../../../infrastructure/persistence/drizzle-stripe-events.system-repository.js';
import type { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { InMemoryStripeEventsSystemRepository } from '../../../testing/in-memory-stripe-events-system-repository.js';
import { StripeOwnerResolver } from '../../ledger/stripe-owner-resolver.js';
import type { StripeEventsSystemRepository } from '../../repositories/stripe-events.system-repository.js';
import { HandleStripeWebhookCommand } from './handle-stripe-webhook.command.js';
import { HandleStripeWebhookHandler } from './handle-stripe-webhook.handler.js';

/**
 * The in-memory billing outbox over the test transaction host (so `enqueue` refuses outside the
 * unit of work, like the real writer): each INSERT is logged in `order` with whether the unit of
 * work was open, or fails when told to.
 */
class OrderedOutbox extends InMemoryOutbox {
  failWith: Error | undefined;

  constructor(
    private readonly order: string[],
    private readonly tx: TestTransactions,
    kafka: FakeKafkaProducer,
  ) {
    super(BILLING_OUTBOX, { kafka, txHost: tx.host });
  }

  protected override async insert(record: OutboxRecord): Promise<void> {
    this.order.push(`enqueue:${record.topic}:${this.tx.active ? 'in-tx' : 'no-tx'}`);
    if (this.failWith !== undefined) throw this.failWith;
    await super.insert(record);
  }

  override async insertAsPlatform(records: readonly OutboxRecord[]): Promise<number> {
    this.order.push(`insertAsPlatform:${this.tx.active ? 'in-tx' : 'no-tx'}`);
    return super.insertAsPlatform(records);
  }
}

/** The `created` of every ledger fixture event (seconds). */
const CREATED = 1_790_000_000;

describe('HandleStripeWebhookHandler', () => {
  let store: InMemoryBillingStore;
  let payments: InMemoryPaymentsRepository;
  let systemEvents: InMemoryStripeEventsSystemRepository;
  let tx: TestTransactions;
  let published: IEvent[];
  let publishedDuringTransaction: boolean;
  let handler: HandleStripeWebhookHandler;
  let payment: Payment;
  let paidWithoutCurrency: { inc: Mock<() => void> };
  let paidWithoutAmount: { inc: Mock<() => void> };
  let amountMismatch: { inc: Mock<() => void> };
  let apiVersionMismatch: { inc: Mock<() => void> };
  let kafka: FakeKafkaProducer;
  let outbox: OrderedOutbox;
  /**
   * markProcessed, save, the outbox INSERT, the post-commit publish, the PaymentIntent GETs
   * (`stripe:<id>:<in-tx|no-tx>`), insertAsPlatform and markProcessedAsPlatform, in call order.
   */
  let order: string[];
  let stripe: StripeService;
  /** The PaymentIntents Stripe knows, by id → metadata (absent = 404). */
  let intents: Map<string, Record<string, string>>;
  let ledger: { -readonly [K in keyof LedgerConfig]: LedgerConfig[K] };
  let systemEventsRepository: StripeEventsSystemRepository;
  let outboxSystem: BillingOutboxSystemRepository;

  /** The metadata checkout signs into the session (B2-26): what the webhook resolves the tenant from. */
  const signedMetadata = () => ({
    paymentId: payment.id,
    userId: payment.userId,
    tenantId: TEST_TENANT_ID,
  });

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
          metadata: signedMetadata(),
        }),
        ...overrides,
      },
      { id, created: 1_790_000_000 },
    );

  /** The handler over the current doubles (the system repositories can be swapped first). */
  const buildHandler = () =>
    new HandleStripeWebhookHandler(
      stripe,
      new StripeOwnerResolver(stripe),
      runtimeEvents,
      systemEventsRepository,
      payments,
      outbox,
      outboxSystem,
      ledger,
      new EventPublisher(eventBusOf() as never),
      paidWithoutCurrency,
      amountMismatch,
      apiVersionMismatch,
      paidWithoutAmount,
    );
  let eventBusOf: () => unknown;
  let runtimeEvents: InMemoryStripeEventsRepository;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    store = new InMemoryBillingStore();
    payments = new InMemoryPaymentsRepository(store);
    tx = installTestTransactionHost(store);
    published = [];
    publishedDuringTransaction = false;
    order = [];
    kafka = new FakeKafkaProducer({ source: 'billing-test' });
    outbox = new OrderedOutbox(order, tx, kafka);
    const eventBus = {
      publish: vi.fn(),
      publishAll: vi.fn((events: IEvent[]) => {
        publishedDuringTransaction ||= tx.active;
        published.push(...events);
        order.push(`publish:${tx.active ? 'in-tx' : 'after-commit'}`);
      }),
    };
    eventBusOf = () => eventBus;
    paidWithoutCurrency = { inc: vi.fn<() => void>() };
    paidWithoutAmount = { inc: vi.fn<() => void>() };
    amountMismatch = { inc: vi.fn<() => void>() };
    apiVersionMismatch = { inc: vi.fn<() => void>() };
    systemEvents = new InMemoryStripeEventsSystemRepository(
      () => new Date('2026-10-01T00:00:00.000Z'),
    );
    const stripeEvents = new InMemoryStripeEventsRepository(store);
    const markProcessed = stripeEvents.markProcessed.bind(stripeEvents);
    stripeEvents.markProcessed = async (event) => {
      order.push('markProcessed');
      return markProcessed(event);
    };
    const save = payments.save.bind(payments);
    payments.save = async (p) => {
      order.push('save');
      return save(p);
    };
    const markAsPlatform = systemEvents.markProcessedAsPlatform.bind(systemEvents);
    systemEvents.markProcessedAsPlatform = async (event) => {
      order.push(`markProcessedAsPlatform:${tx.active ? 'in-tx' : 'no-tx'}`);
      return markAsPlatform(event);
    };
    stripe = createTestStripeService();
    intents = new Map();
    vi.spyOn(stripe.client.paymentIntents, 'retrieve').mockImplementation((async (id: string) => {
      // A GET is never sent while the unit of work is open (no Stripe call inside a transaction).
      order.push(`stripe:${id}:${tx.active ? 'in-tx' : 'no-tx'}`);
      const metadata = intents.get(id);
      if (metadata === undefined) {
        throw Stripe.errors.StripeError.generate({
          statusCode: 404,
          message: `No such payment_intent: '${id}'`,
          type: 'invalid_request_error',
          code: 'resource_missing',
        });
      }
      return { id, object: 'payment_intent', metadata };
    }) as never);
    // LEDGER_ENABLED defaults to false; the ledger blocks below switch it on.
    ledger = { enabled: false, reconcileLookbackHours: 72, verify: false, allowUnverified: false };
    systemEventsRepository = systemEvents;
    // The in-memory outbox is both the writer and the system repository (one array).
    outboxSystem = outbox as unknown as BillingOutboxSystemRepository;
    runtimeEvents = stripeEvents;
    handler = buildHandler();
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
    expect(store.state.events.get(`${TEST_TENANT_ID}:evt_completed_1`)).toEqual({
      tenantId: TEST_TENANT_ID,
      userId: payment.userId,
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

  it('paid session without any amount: acknowledged, warned + counted, never announced with 0', async () => {
    const unpriced = makePayment({
      stripeCheckoutSessionId: 'cs_no_amount_1',
      amountTotal: null,
      currency: 'usd',
    });
    store.seed(unpriced);
    const warn = vi.spyOn(Logger.prototype, 'warn');

    const response = await deliver(
      completed(
        { id: 'cs_no_amount_1', client_reference_id: unpriced.id, amount_total: null },
        'evt_no_amount_1',
      ),
    );

    expect(response).toMatchObject({ received: true, duplicate: false });
    expect(store.payment(unpriced.id)).toMatchObject({ status: PaymentStatus.Pending, version: 0 });
    expect(published).toEqual([]);
    expect(paidWithoutAmount.inc).toHaveBeenCalledTimes(1);
    expect(paidWithoutCurrency.inc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has an amount'));
    warn.mockRestore();
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
    expect(store.state.events.has(`${TEST_TENANT_ID}:evt_no_currency_2`)).toBe(true);
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
          metadata: signedMetadata(),
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
        makeCheckoutSession({
          id: 'cs_paid_1',
          client_reference_id: payment.id,
          metadata: signedMetadata(),
        }),
      ),
    );
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Failed);
    expect(published).toEqual([]);
  });

  it('checkout.session.expired → expired', async () => {
    const response = await deliver(
      signedEvent(
        'checkout.session.expired',
        makeCheckoutSession({ id: 'cs_paid_1', status: 'expired', metadata: signedMetadata() }),
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
    // No owner in the metadata: a platform event, recorded through the system method.
    expect(systemEvents.events).toEqual([
      expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, userId: null, id: 'evt_other' }),
    ]);
    expect(store.state.events.size).toBe(0);
    expect(tx.begun).toBe(0);
    expect(store.payment(payment.id)?.version).toBe(0);
  });

  it('acknowledges events for unknown payments and impossible transitions', async () => {
    await expect(
      deliver(
        completed({
          id: 'cs_unknown',
          client_reference_id: null,
          metadata: { userId: payment.userId, tenantId: TEST_TENANT_ID },
        }),
      ),
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
    expect(store.state.events.has(`${TEST_TENANT_ID}:evt_retry`)).toBe(false);
    expect(published).toEqual([]);
    expect(outbox.records).toEqual([]);

    saveSpy.mockRestore();
    await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: false });
    expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    expect(published).toHaveLength(1);
  });

  it('counts and records a charge that differs from the quote (S-5)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await deliver(completed({ amount_total: 2_000 }, 'evt_amount_mismatch_1'));
    expect(store.payment(payment.id)).toMatchObject({
      status: PaymentStatus.Succeeded,
      amountTotal: 2_000,
    });
    expect(amountMismatch.inc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quoted 2500 usd'));
    warn.mockRestore();
  });

  it('does not count a charge equal to the quote', async () => {
    await deliver(completed({}, 'evt_amount_equal_1'));
    expect(amountMismatch.inc).not.toHaveBeenCalled();
  });

  it('counts events signed for another API version but still applies them (S-10)', async () => {
    await deliver(
      signedEvent(
        'checkout.session.expired',
        makeCheckoutSession({
          id: 'cs_paid_1',
          client_reference_id: payment.id,
          status: 'expired',
          metadata: signedMetadata(),
        }),
        { id: 'evt_old_api_1', apiVersion: '2020-08-27' },
      ),
    );
    expect(apiVersionMismatch.inc).toHaveBeenCalledTimes(1);
    expect(store.payment(payment.id)).toMatchObject({ status: PaymentStatus.Expired });
  });

  describe('billing.payment-succeeded.v1 on the outbox (G-1: in the unit of work, never Kafka)', () => {
    const outboxRows = () =>
      outbox.records.filter((row) => row.topic === PAYMENT_SUCCEEDED_EVENT.topic);

    it('a paid session enqueues one record after markProcessed and save, before the commit', async () => {
      await deliver(completed({}, 'evt_outbox_paid_1'));

      expect(order).toEqual([
        'markProcessed',
        'save',
        `enqueue:${PAYMENT_SUCCEEDED_EVENT.topic}:in-tx`,
        'publish:after-commit',
      ]);
      const [event] = published as [PaymentSucceededEvent];
      expect(event).toBeInstanceOf(PaymentSucceededEvent);
      // key = user id, envelope id = the domain event id, tenant and actor = the signed owner.
      expect(outbox.records).toHaveLength(1);
      expect(outboxRows()[0]).toMatchObject({
        tenantId: TEST_TENANT_ID,
        id: event.eventId,
        topic: PAYMENT_SUCCEEDED_EVENT.topic,
        key: payment.userId,
        publishedAt: null,
      });
      // The envelope the deleted relay built, field for field (occurredAt = paidAt).
      expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, outboxRows()[0]?.envelope)).toEqual({
        id: event.eventId,
        type: PAYMENT_SUCCEEDED_EVENT.topic,
        version: 1,
        source: 'billing-test',
        occurredAt: new Date(1_790_000_000 * 1_000).toISOString(),
        tenantId: TEST_TENANT_ID,
        actorId: payment.userId,
        payload: {
          paymentId: payment.id,
          userId: payment.userId,
          stripeCheckoutSessionId: 'cs_paid_1',
          stripePaymentIntentId: 'pi_1',
          amountTotal: 2_500,
          currency: 'usd',
          paidAt: new Date(1_790_000_000 * 1_000).toISOString(),
        },
      });
      expect(kafka.records).toEqual([]);
    });

    it('async_payment_succeeded enqueues the record too', async () => {
      await deliver(completed({ payment_status: 'unpaid' }, 'evt_outbox_unpaid'));
      expect(outbox.records).toEqual([]);
      await deliver(
        signedEvent(
          'checkout.session.async_payment_succeeded',
          makeCheckoutSession({
            id: 'cs_paid_1',
            client_reference_id: payment.id,
            payment_status: 'paid',
            metadata: signedMetadata(),
          }),
          { id: 'evt_outbox_async_paid' },
        ),
      );
      expect(outboxRows()).toHaveLength(1);
      expect(outboxRows()[0]?.id).toBe((published[0] as PaymentSucceededEvent).eventId);
    });

    it('a duplicate delivery enqueues nothing', async () => {
      const webhook = completed({}, 'evt_outbox_dup');
      await deliver(webhook);
      await expect(deliver(webhook)).resolves.toMatchObject({ duplicate: true });
      expect(outbox.records).toHaveLength(1);
    });

    it('an unpaid completion, a failed and an expired session enqueue nothing', async () => {
      await deliver(completed({ payment_status: 'unpaid' }, 'evt_outbox_unpaid_only'));
      await deliver(
        signedEvent(
          'checkout.session.async_payment_failed',
          makeCheckoutSession({
            id: 'cs_paid_1',
            client_reference_id: payment.id,
            metadata: signedMetadata(),
          }),
        ),
      );
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Failed);
      await deliver(
        signedEvent(
          'checkout.session.expired',
          makeCheckoutSession({ id: 'cs_paid_1', status: 'expired', metadata: signedMetadata() }),
        ),
      );
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Expired);
      expect(outbox.records).toEqual([]);
      expect(order.filter((step) => step.startsWith('enqueue'))).toEqual([]);
    });

    it('an impossible transition and a platform event enqueue nothing', async () => {
      await deliver(completed({}, 'evt_outbox_first'));
      await deliver(completed({}, 'evt_outbox_second'));
      await deliver(signedEvent('payout.paid', { id: 'po_outbox' }, { id: 'evt_outbox_payout' }));
      expect(outbox.records).toHaveLength(1);
    });

    it('a failing enqueue rejects and leaves no receipt, no transition and nothing published', async () => {
      outbox.failWith = new Error('outbox insert failed');

      await expect(deliver(completed({}, 'evt_outbox_fail'))).rejects.toThrow(
        'outbox insert failed',
      );

      expect(tx.rolledBack).toBe(1);
      expect(store.state.events.has(`${TEST_TENANT_ID}:evt_outbox_fail`)).toBe(false);
      expect(store.payment(payment.id)).toMatchObject({
        status: PaymentStatus.Pending,
        version: 0,
      });
      expect(published).toEqual([]);
      expect(outbox.records).toEqual([]);
      expect(kafka.records).toEqual([]);

      // Stripe's retry is applied in full once the outbox accepts the row.
      outbox.failWith = undefined;
      await expect(deliver(completed({}, 'evt_outbox_fail'))).resolves.toMatchObject({
        duplicate: false,
      });
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
      expect(outbox.records).toHaveLength(1);
    });
  });

  describe('tenancy (signed metadata)', () => {
    const owned = (tenantId: string, id?: string) =>
      completed({ metadata: { paymentId: payment.id, userId: payment.userId, tenantId } }, id);

    it("records the event under the metadata's tenant and user and completes that tenant's payment", async () => {
      await deliver(owned(TEST_TENANT_ID, 'evt_owned_1'));

      expect(store.state.events.get(`${TEST_TENANT_ID}:evt_owned_1`)).toEqual({
        tenantId: TEST_TENANT_ID,
        userId: payment.userId,
        id: 'evt_owned_1',
        type: 'checkout.session.completed',
      });
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Succeeded);
    });

    it('leaves the payment untouched when the metadata names another tenant (acknowledged)', async () => {
      const result = await deliver(owned(generateId(), 'evt_foreign_1'));

      expect(result).toMatchObject({ received: true, duplicate: false });
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Pending);
      expect(published).toEqual([]);
    });

    it('applies the event as the signed { userId, tenantId } principal (spec §9)', async () => {
      let seen: unknown;
      const save = payments.save.bind(payments);
      payments.save = async (p) => {
        seen = getPrincipal();
        return save(p);
      };
      const principals: unknown[] = [];
      const begin = tx.host.withTransaction.bind(tx.host) as (...args: unknown[]) => unknown;
      vi.spyOn(tx.host, 'withTransaction').mockImplementation(((...args: unknown[]) => {
        // The principal is final before the unit of work opens (B3 global constraint).
        principals.push(getPrincipal());
        return begin(...args);
      }) as never);
      await deliver(owned(TEST_TENANT_ID, 'evt_principal_1'));

      expect(principals).toEqual([seen]);
      expect(seen).toMatchObject({
        userId: payment.userId,
        tenantId: TEST_TENANT_ID,
        roles: [],
        staff: false,
      });
    });

    it('publishes PaymentSucceededEvent with the payment tenant, and enqueues it under that tenant', async () => {
      await deliver(owned(TEST_TENANT_ID, 'evt_tenant_event_1'));
      expect(published).toEqual([expect.objectContaining({ tenantId: TEST_TENANT_ID })]);
      expect(outbox.records.map((row) => row.tenantId)).toEqual([TEST_TENANT_ID]);
    });

    it('treats a nil-UUID user as no user: recorded through the system method, never retried forever, no payment touched', async () => {
      const nilUser = (id: string) =>
        completed(
          {
            metadata: {
              paymentId: payment.id,
              userId: PLATFORM_TENANT_ID,
              tenantId: TEST_TENANT_ID,
            },
          },
          id,
        );

      const result = await deliver(nilUser('evt_nil_user_1'));

      expect(result).toMatchObject({ received: true, duplicate: false });
      // Plan Task 16 flow table: a user-less owner goes through the system method under its
      // tenant, and no payment is touched (no principal could open a runtime transaction).
      expect(systemEvents.events).toEqual([
        {
          tenantId: TEST_TENANT_ID,
          userId: null,
          id: 'evt_nil_user_1',
          type: 'checkout.session.completed',
          processedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ]);
      expect(store.state.events.size).toBe(0);
      expect(tx.begun).toBe(0);
      expect(store.payment(payment.id)?.status).toBe(PaymentStatus.Pending);
      expect(published).toEqual([]);
      await expect(deliver(nilUser('evt_nil_user_1'))).resolves.toMatchObject({ duplicate: true });
    });

    it('records an event without tenant metadata for the platform tenant with a NULL user', async () => {
      await deliver(
        signedEvent('payout.paid', { id: 'po_1', object: 'payout' }, { id: 'evt_payout_1' }),
      );

      expect(systemEvents.events).toEqual([
        {
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          id: 'evt_payout_1',
          type: 'payout.paid',
          processedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ]);
      expect(store.state.events.size).toBe(0);
    });

    it("records a platform event inside SystemContext('billing.platform-webhook'), no principal, no transaction", async () => {
      let seen: unknown;
      const mark = systemEvents.markProcessedAsPlatform.bind(systemEvents);
      systemEvents.markProcessedAsPlatform = async (event) => {
        seen = { system: SystemContext.current(), principal: getPrincipal() };
        return mark(event);
      };
      const payout = signedEvent('payout.paid', { id: 'po_2' }, { id: 'evt_payout_2' });

      await expect(deliver(payout)).resolves.toMatchObject({ duplicate: false });
      await expect(deliver(payout)).resolves.toMatchObject({ duplicate: true });

      expect(seen).toEqual({
        system: { reason: 'billing.platform-webhook' },
        principal: undefined,
      });
      expect(tx.begun).toBe(0);
    });

    it('a failing system method fails the delivery (Stripe retries it)', async () => {
      vi.spyOn(systemEvents, 'markProcessedAsPlatform').mockRejectedValueOnce(
        new Error('system pool down'),
      );
      await expect(
        deliver(signedEvent('payout.paid', { id: 'po_3' }, { id: 'evt_payout_3' })),
      ).rejects.toThrow('system pool down');
    });

    it('never uses the system method for an owner with a user', async () => {
      const mark = vi.spyOn(systemEvents, 'markProcessedAsPlatform');
      await deliver(owned(TEST_TENANT_ID, 'evt_owned_runtime'));
      expect(mark).not.toHaveBeenCalled();
      expect(systemEvents.events).toEqual([]);
    });
  });

  describe('ledger postings and money events (L-11, LEDGER_ENABLED=true)', () => {
    let paid: Payment;
    const POSTING = LEDGER_POSTING_REQUESTED_EVENT.topic;
    const postings = () => outbox.records.filter((row) => row.topic === POSTING);
    /** The metadata checkout mirrored onto the PaymentIntent (B2-26). */
    const paidMetadata = () => ({
      paymentId: paid.id,
      userId: paid.userId,
      tenantId: TEST_TENANT_ID,
    });

    const charge = (overrides: Record<string, unknown> = {}) => ({
      id: 'ch_1',
      object: 'charge',
      amount: 2_500,
      amount_refunded: 0,
      currency: 'usd',
      metadata: paidMetadata(),
      payment_intent: 'pi_paid',
      ...overrides,
    });
    const refund = (overrides: Record<string, unknown> = {}) => ({
      id: 're_1',
      object: 'refund',
      amount: 2_500,
      currency: 'usd',
      status: 'succeeded',
      metadata: {},
      payment_intent: 'pi_paid',
      ...overrides,
    });
    const dispute = (overrides: Record<string, unknown> = {}) => ({
      id: 'du_1',
      object: 'dispute',
      amount: 2_500,
      currency: 'usd',
      status: 'needs_response',
      metadata: {},
      payment_intent: 'pi_paid',
      ...overrides,
    });
    const payout = (overrides: Record<string, unknown> = {}) => ({
      id: 'po_1',
      object: 'payout',
      amount: 2_500,
      currency: 'usd',
      metadata: {},
      ...overrides,
    });
    const money = (type: string, object: object, id: string) =>
      signedEvent(type, object, { id, created: CREATED });

    /** The one posting row, exactly: id, tenant, key, actor and the payload field for field. */
    const expectPosting = (
      eventId: string,
      fields: Pick<LedgerPostingRequestedPayload, 'stripeEventType' | 'objectType' | 'objectId'> &
        Partial<LedgerPostingRequestedPayload>,
    ) => {
      const tenantId = fields.tenantId ?? TEST_TENANT_ID;
      const userId = fields.userId === undefined ? paid.userId : fields.userId;
      const rows = postings();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        id: uuidv5(eventId, LEDGER_NAMESPACE),
        topic: POSTING,
        key: tenantId,
        publishedAt: null,
      });
      expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, rows[0]?.envelope)).toEqual({
        id: uuidv5(eventId, LEDGER_NAMESPACE),
        type: POSTING,
        version: 1,
        source: 'billing-test',
        occurredAt: new Date(CREATED * 1_000).toISOString(),
        tenantId,
        actorId: userId,
        payload: {
          source: 'stripe',
          stripeEventId: eventId,
          tenantId,
          userId,
          paymentId: paid.id,
          livemode: false,
          ...fields,
        },
      });
    };

    beforeEach(() => {
      ledger.enabled = true;
      paid = makePayment({
        status: PaymentStatus.Succeeded,
        stripeCheckoutSessionId: 'cs_paid_ledger',
        stripePaymentIntentId: 'pi_paid',
        amountTotal: 2_500,
        currency: 'usd',
        paidAt: new Date('2026-09-02T11:59:00.000Z'),
      });
      store.seed(paid);
      intents.set('pi_paid', paidMetadata());
    });

    it('charge.succeeded (charge metadata): no Stripe call, no transition, one charge posting in the unit of work', async () => {
      await expect(deliver(money('charge.succeeded', charge(), 'evt_ch_ok'))).resolves.toEqual({
        received: true,
        eventId: 'evt_ch_ok',
        eventType: 'charge.succeeded',
        duplicate: false,
      });

      expect(order).toEqual(['markProcessed', `enqueue:${POSTING}:in-tx`]);
      expectPosting('evt_ch_ok', {
        stripeEventType: 'charge.succeeded',
        objectType: 'charge',
        objectId: 'ch_1',
      });
      expect(store.state.events.get(`${TEST_TENANT_ID}:evt_ch_ok`)).toMatchObject({
        tenantId: TEST_TENANT_ID,
        userId: paid.userId,
      });
      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.Succeeded,
        version: 0,
      });
      expect(tx).toMatchObject({ begun: 1, rolledBack: 0 });
      expect(kafka.records).toEqual([]);
      expect(published).toEqual([]);
    });

    it('charge.succeeded without charge metadata: one PaymentIntent GET before the unit of work', async () => {
      await deliver(money('charge.succeeded', charge({ metadata: {} }), 'evt_ch_pi'));

      expect(order).toEqual(['stripe:pi_paid:no-tx', 'markProcessed', `enqueue:${POSTING}:in-tx`]);
      expectPosting('evt_ch_pi', {
        stripeEventType: 'charge.succeeded',
        objectType: 'charge',
        objectId: 'ch_1',
      });
    });

    it('charge.refunded with amount_refunded = amount → refunded, no posting row', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 2_500 }), 'evt_ch_rf'));

      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.Refunded,
        version: 1,
      });
      expect(order).toEqual(['markProcessed', 'save']);
      expect(postings()).toEqual([]);
    });

    it('charge.refunded with less refunded → partially_refunded, no posting row', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 500 }), 'evt_ch_prf'));

      expect(store.payment(paid.id)?.status).toBe(PaymentStatus.PartiallyRefunded);
      expect(postings()).toEqual([]);
    });

    it.each(['refund.created', 'refund.updated'])(
      '%s with status succeeded: one refund posting, no transition',
      async (type) => {
        await deliver(money(type, refund(), `evt_${type}`));

        expect(order).toEqual([
          'stripe:pi_paid:no-tx',
          'markProcessed',
          `enqueue:${POSTING}:in-tx`,
        ]);
        expectPosting(`evt_${type}`, {
          stripeEventType: type,
          objectType: 'refund',
          objectId: 're_1',
        });
        expect(store.payment(paid.id)).toMatchObject({
          status: PaymentStatus.Succeeded,
          version: 0,
        });
      },
    );

    it('refund.failed: one refund posting', async () => {
      await deliver(money('refund.failed', refund({ status: 'failed' }), 'evt_re_failed'));

      expectPosting('evt_re_failed', {
        stripeEventType: 'refund.failed',
        objectType: 'refund',
        objectId: 're_1',
      });
    });

    it('a full refund then refund.failed: the payment is succeeded again', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 2_500 }), 'evt_ch_rf'));
      expect(store.payment(paid.id)?.status).toBe(PaymentStatus.Refunded);

      await deliver(money('refund.failed', refund({ status: 'failed' }), 'evt_re_failed'));

      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.Succeeded,
        amountRefunded: 0,
        version: 2,
      });
      expectPosting('evt_re_failed', {
        stripeEventType: 'refund.failed',
        objectType: 'refund',
        objectId: 're_1',
      });
    });

    it('two partial refunds then one refund.failed: still partially_refunded by the other', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 500 }), 'evt_ch_rf1'));
      await deliver(money('charge.refunded', charge({ amount_refunded: 1_500 }), 'evt_ch_rf2'));
      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 1_500,
      });

      await deliver(
        money('refund.failed', refund({ amount: 500, status: 'failed' }), 'evt_re_failed'),
      );

      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.PartiallyRefunded,
        amountRefunded: 1_000,
      });
    });

    it('a partial refund then refund.failed: succeeded again', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 500 }), 'evt_ch_prf'));

      await deliver(
        money('refund.failed', refund({ amount: 500, status: 'failed' }), 'evt_re_failed'),
      );

      expect(store.payment(paid.id)).toMatchObject({
        status: PaymentStatus.Succeeded,
        amountRefunded: 0,
      });
    });

    it('refund.failed with the ledger off still restores the payment, and writes no row', async () => {
      await deliver(money('charge.refunded', charge({ amount_refunded: 2_500 }), 'evt_ch_rf'));
      ledger.enabled = false;

      await deliver(money('refund.failed', refund({ status: 'failed' }), 'evt_re_failed'));

      expect(store.payment(paid.id)?.status).toBe(PaymentStatus.Succeeded);
      expect(postings()).toEqual([]);
    });

    it.each(['pending', 'requires_action', 'canceled'])(
      'refund.updated with status %s writes no row (and asks Stripe nothing)',
      async (status) => {
        const response = await deliver(
          money('refund.updated', refund({ status }), `evt_re_${status}`),
        );

        expect(response).toMatchObject({ received: true, duplicate: false });
        expect(postings()).toEqual([]);
        expect(order.filter((step) => step.startsWith('stripe:'))).toEqual([]);
        expect(store.payment(paid.id)?.version).toBe(0);
      },
    );

    it('charge.dispute.funds_withdrawn → disputed, one dispute posting', async () => {
      await deliver(money('charge.dispute.funds_withdrawn', dispute(), 'evt_du_out'));

      expect(order).toEqual([
        'stripe:pi_paid:no-tx',
        'markProcessed',
        'save',
        `enqueue:${POSTING}:in-tx`,
      ]);
      expect(store.payment(paid.id)).toMatchObject({ status: PaymentStatus.Disputed, version: 1 });
      expectPosting('evt_du_out', {
        stripeEventType: 'charge.dispute.funds_withdrawn',
        objectType: 'dispute',
        objectId: 'du_1',
      });
    });

    it('charge.dispute.funds_reinstated: disputed → succeeded, one dispute posting', async () => {
      await deliver(money('charge.dispute.funds_withdrawn', dispute(), 'evt_du_out'));
      outbox.records.splice(0);

      await deliver(money('charge.dispute.funds_reinstated', dispute(), 'evt_du_in'));

      expect(store.payment(paid.id)).toMatchObject({ status: PaymentStatus.Succeeded, version: 2 });
      expectPosting('evt_du_in', {
        stripeEventType: 'charge.dispute.funds_reinstated',
        objectType: 'dispute',
        objectId: 'du_1',
      });
    });

    it('a transition that does not apply still writes the posting (the money moved)', async () => {
      const pending = makePayment({ userId: paid.userId, amountTotal: 2_500, currency: 'usd' });
      store.seed(pending);
      intents.set('pi_pending', { ...paidMetadata(), paymentId: pending.id });

      await deliver(
        money(
          'charge.dispute.funds_withdrawn',
          dispute({ payment_intent: 'pi_pending' }),
          'evt_np',
        ),
      );

      expect(store.payment(pending.id)).toMatchObject({
        status: PaymentStatus.Pending,
        version: 0,
      });
      expect(postings()).toHaveLength(1);
      expect(postings()[0]?.envelope.payload).toMatchObject({ paymentId: pending.id });
    });

    it('a payment id that names no payment of the tenant: the row is written with paymentId null', async () => {
      const elsewhere = generateId();
      await deliver(
        money(
          'charge.succeeded',
          charge({ metadata: { ...paidMetadata(), paymentId: elsewhere } }),
          'evt_np2',
        ),
      );

      expectPosting('evt_np2', {
        stripeEventType: 'charge.succeeded',
        objectType: 'charge',
        objectId: 'ch_1',
        paymentId: null,
      });
    });

    it("another user's payment in the same tenant is neither touched nor named", async () => {
      const someoneElse = makePayment({
        status: PaymentStatus.Succeeded,
        amountTotal: 2_500,
        currency: 'usd',
      });
      store.seed(someoneElse);
      const metadata = { ...paidMetadata(), paymentId: someoneElse.id };

      await deliver(
        money('charge.refunded', charge({ amount_refunded: 2_500, metadata }), 'evt_x1'),
      );
      await deliver(money('charge.succeeded', charge({ metadata }), 'evt_x2'));

      expect(store.payment(someoneElse.id)).toMatchObject({
        status: PaymentStatus.Succeeded,
        version: 0,
      });
      expect(postings()[0]?.envelope.payload).toMatchObject({ paymentId: null });
    });

    it('a duplicate delivery does nothing', async () => {
      const event = money('charge.dispute.funds_withdrawn', dispute(), 'evt_du_dup');
      await deliver(event);
      order.splice(0);

      await expect(deliver(event)).resolves.toMatchObject({ duplicate: true });

      expect(order).toEqual(['stripe:pi_paid:no-tx', 'markProcessed']);
      expect(postings()).toHaveLength(1);
      expect(store.payment(paid.id)?.version).toBe(1);
    });

    it('a failing posting enqueue rolls the unit back: no receipt, no transition, no row', async () => {
      outbox.failWith = new Error('outbox insert failed');

      await expect(
        deliver(money('charge.dispute.funds_withdrawn', dispute(), 'evt_du_fail')),
      ).rejects.toThrow('outbox insert failed');

      expect(tx.rolledBack).toBe(1);
      expect(store.state.events.has(`${TEST_TENANT_ID}:evt_du_fail`)).toBe(false);
      expect(store.payment(paid.id)).toMatchObject({ status: PaymentStatus.Succeeded, version: 0 });
      expect(postings()).toEqual([]);
    });

    it('an unresolved owner: a platform receipt with a warning, no payment touched, no row', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');

      const response = await deliver(
        money('refund.created', refund({ payment_intent: 'pi_unknown' }), 'evt_re_lost'),
      );

      expect(response).toMatchObject({ received: true, duplicate: false });
      expect(order).toEqual(['stripe:pi_unknown:no-tx', 'markProcessedAsPlatform:no-tx']);
      expect(systemEvents.events).toEqual([
        expect.objectContaining({
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          id: 'evt_re_lost',
          type: 'refund.created',
        }),
      ]);
      expect(tx.begun).toBe(0);
      expect(store.state.events.size).toBe(0);
      expect(store.payment(paid.id)?.version).toBe(0);
      expect(outbox.records).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no tenant'));
      warn.mockRestore();
    });

    it('an unresolved charge.refunded touches no payment either', async () => {
      await deliver(
        money(
          'charge.refunded',
          charge({ amount_refunded: 2_500, metadata: {}, payment_intent: null }),
          'evt_rf_lost',
        ),
      );

      expect(systemEvents.events).toEqual([
        expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, id: 'evt_rf_lost' }),
      ]);
      expect(store.payment(paid.id)).toMatchObject({ status: PaymentStatus.Succeeded, version: 0 });
    });

    it.each(['payout.paid', 'payout.failed'])(
      '%s: insertAsPlatform first, then markProcessedAsPlatform, in SystemContext',
      async (type) => {
        const enqueue = vi.spyOn(outbox, 'enqueue');
        const contexts: unknown[] = [];
        const insert = outbox.insertAsPlatform.bind(outbox);
        vi.spyOn(outbox, 'insertAsPlatform').mockImplementation(async (records) => {
          contexts.push({ system: SystemContext.current(), principal: getPrincipal() });
          return insert(records);
        });

        await expect(deliver(money(type, payout(), `evt_${type}`))).resolves.toMatchObject({
          duplicate: false,
        });

        expect(order).toEqual(['insertAsPlatform:no-tx', 'markProcessedAsPlatform:no-tx']);
        expect(contexts).toEqual([
          { system: { reason: 'billing.platform-webhook' }, principal: undefined },
        ]);
        expectPosting(`evt_${type}`, {
          stripeEventType: type,
          objectType: 'payout',
          objectId: 'po_1',
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          paymentId: null,
        });
        expect(systemEvents.events).toEqual([
          expect.objectContaining({
            tenantId: PLATFORM_TENANT_ID,
            userId: null,
            id: `evt_${type}`,
          }),
        ]);
        expect(enqueue).not.toHaveBeenCalled();
        expect(tx.begun).toBe(0);
      },
    );

    it('payout.paid: a crash between the two calls is healed by the redelivery, then duplicate', async () => {
      const event = money('payout.paid', payout(), 'evt_po_crash');
      const mark = vi
        .spyOn(systemEvents, 'markProcessedAsPlatform')
        .mockRejectedValueOnce(new Error('connection lost'));

      await expect(deliver(event)).rejects.toThrow('connection lost');
      expect(postings()).toHaveLength(1);
      expect(systemEvents.events).toEqual([]);

      await expect(deliver(event)).resolves.toMatchObject({ duplicate: false });
      expect(postings()).toHaveLength(1);
      expect(systemEvents.events).toEqual([expect.objectContaining({ id: 'evt_po_crash' })]);

      await expect(deliver(event)).resolves.toMatchObject({ duplicate: true });
      expect(postings()).toHaveLength(1);
      expect(mark).toHaveBeenCalledTimes(3);
    });

    it('payout.paid: SystemDatabase.run sees only outbox.insertAsPlatform and stripeEvents.markProcessedAsPlatform', async () => {
      const ran: string[] = [];
      const { db } = createRecordingDrizzle((query) =>
        query.sql.startsWith('insert') ? [['inserted']] : [],
      );
      const system = {
        run: async (method: SystemMethod, work: (handle: unknown) => Promise<unknown>) => {
          if (!SystemContext.isActive()) throw new Error('outside SystemContext');
          ran.push(method.name);
          return work(db);
        },
      } as unknown as SystemDatabase;
      systemEventsRepository = new DrizzleStripeEventsSystemRepository(system as never);
      outboxSystem = new BillingOutboxSystemRepository(system as never);
      const enqueue = vi.spyOn(outbox, 'enqueue');
      handler = buildHandler();

      await deliver(money('payout.paid', payout(), 'evt_po_spy'));

      expect(ran).toEqual(['outbox.insertAsPlatform', 'stripeEvents.markProcessedAsPlatform']);
      expect(enqueue).not.toHaveBeenCalled();
      expect(tx.begun).toBe(0);
    });

    it('no Stripe call happens while the unit of work is open, for any money event', async () => {
      await deliver(money('charge.succeeded', charge({ metadata: {} }), 'evt_s1'));
      await deliver(
        money('charge.refunded', charge({ metadata: {}, amount_refunded: 1 }), 'evt_s2'),
      );
      await deliver(money('refund.updated', refund(), 'evt_s3'));
      await deliver(money('refund.failed', refund({ status: 'failed' }), 'evt_s4'));
      await deliver(money('charge.dispute.funds_withdrawn', dispute(), 'evt_s5'));
      await deliver(money('charge.dispute.funds_reinstated', dispute(), 'evt_s6'));
      await deliver(money('payout.paid', payout(), 'evt_s7'));

      const calls = order.filter((step) => step.startsWith('stripe:'));
      expect(calls).toHaveLength(6);
      expect(calls.every((step) => step.endsWith(':no-tx'))).toBe(true);
      expect(postings()).toHaveLength(6);
    });

    describe('with LEDGER_ENABLED=false', () => {
      beforeEach(() => {
        ledger.enabled = false;
      });

      it('transitions still happen and no posting row is written', async () => {
        await deliver(money('charge.dispute.funds_withdrawn', dispute(), 'evt_off_1'));
        expect(store.payment(paid.id)?.status).toBe(PaymentStatus.Disputed);
        await deliver(money('charge.dispute.funds_reinstated', dispute(), 'evt_off_2'));
        expect(store.payment(paid.id)?.status).toBe(PaymentStatus.Succeeded);
        await deliver(money('charge.refunded', charge({ amount_refunded: 2_500 }), 'evt_off_3'));
        expect(store.payment(paid.id)?.status).toBe(PaymentStatus.Refunded);

        await deliver(money('charge.succeeded', charge(), 'evt_off_4'));
        await deliver(money('refund.updated', refund(), 'evt_off_5'));

        expect(outbox.records).toEqual([]);
        expect(order.some((step) => step.startsWith('enqueue'))).toBe(false);
      });

      it('payout.paid only records the receipt: no insertAsPlatform', async () => {
        await expect(deliver(money('payout.paid', payout(), 'evt_off_po'))).resolves.toMatchObject({
          duplicate: false,
        });
        expect(order).toEqual(['markProcessedAsPlatform:no-tx']);
        expect(outbox.records).toEqual([]);
      });

      it('events without a transition ask Stripe nothing', async () => {
        await deliver(money('charge.succeeded', charge({ metadata: {} }), 'evt_off_6'));
        await deliver(money('refund.created', refund(), 'evt_off_7'));
        expect(order.filter((step) => step.startsWith('stripe:'))).toEqual([]);
      });
    });
  });
});
