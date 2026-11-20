import {
  type HandleStripeWebhookResponse,
  LEDGER_POSTING_REQUESTED_EVENT,
  PAYMENT_SUCCEEDED_EVENT,
} from '@domain/billing-contracts';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, isUuid, runWithPrincipal, SystemContext } from '@platform/common';
import { Transactional } from '@platform/database';
import { InjectMetric } from '@platform/observability';
import type Stripe from 'stripe';
import {
  AMOUNT_MISMATCH_METRIC,
  API_VERSION_MISMATCH_METRIC,
  PAID_WITHOUT_AMOUNT_METRIC,
  PAID_WITHOUT_CURRENCY_METRIC,
} from '../../../billing.constants.js';
import { PaymentSucceededEvent } from '../../../domain/events/payment-succeeded.event.js';
import { normalizeCurrency, type Payment } from '../../../domain/payment.aggregate.js';
import { PLATFORM_OWNER, type StripeOwner, stripeOwnerOf } from '../../../domain/stripe-owner.js';
import { type LedgerConfig, ledgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import { BillingOutbox } from '../../../infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../../../infrastructure/persistence/drizzle-outbox.system-repository.js';
import { STRIPE_API_VERSION } from '../../../infrastructure/stripe/stripe.constants.js';
import { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import {
  type LedgerPostingObjectType,
  ledgerPostingRecord,
  ledgerPostingRequest,
  postingOwnerOf,
} from '../../ledger/ledger-posting-request.js';
import { StripeOwnerResolver } from '../../ledger/stripe-owner-resolver.js';
import { toPaymentSucceededPayload } from '../../mappers/payment.mapper.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
import { StripeEventsSystemRepository } from '../../repositories/stripe-events.system-repository.js';
import { HandleStripeWebhookCommand } from './handle-stripe-webhook.command.js';

/** The principal's owner, and the payment its signed metadata names (money events only). */
type PaymentOwner = StripeOwner & { readonly paymentId?: string | null };

interface WebhookOutcome {
  duplicate: boolean;
  /** Payment whose uncommitted events go to the in-process bus once the transaction committed. */
  payment: Payment | null;
}

type Transition = (payment: Payment, now: Date) => boolean;

/** What a Stripe money event does (outbox plan Task 12, L-11 binding table). */
interface MoneyEvent {
  readonly objectType: LedgerPostingObjectType;
  readonly objectId: string;
  /** Writes a `billing.ledger-posting.v1` row (only while LEDGER_ENABLED). */
  readonly posts: boolean;
  /** The payment's status change, if the event moves one. */
  readonly transition: Transition | null;
  /**
   * A refund event: the charge whose CURRENT `amount_refunded` the payment records (read from
   * Stripe before the unit of work; the transition is `payment.refund(total)`), else null.
   */
  readonly refundedCharge: string | null;
  /** Platform-level money (payouts): no tenant, the system path. */
  readonly platform: boolean;
}

/**
 * The money events beyond checkout and what each does. Postings key off the events whose object
 * has a balance transaction (plan delta 5): `charge.refunded` only moves the payment status.
 */
function moneyEventOf(event: Stripe.Event): MoneyEvent | null {
  const tenantMoney = { platform: false, refundedCharge: null } as const;
  switch (event.type) {
    case 'charge.succeeded':
      return {
        ...tenantMoney,
        objectType: 'charge',
        objectId: event.data.object.id,
        posts: true,
        transition: null,
      };
    case 'charge.refunded':
      // The event's own `amount_refunded` may be stale (out of order): Stripe's current one counts.
      return {
        ...tenantMoney,
        objectType: 'charge',
        objectId: event.data.object.id,
        posts: false,
        transition: null,
        refundedCharge: event.data.object.id,
      };
    case 'refund.created':
      // Only a refund that went through moves money; pending, requires_action and canceled do not.
      return {
        ...tenantMoney,
        objectType: 'refund',
        objectId: event.data.object.id,
        posts: event.data.object.status === 'succeeded',
        transition: null,
      };
    case 'refund.updated':
    case 'refund.failed': {
      // A failed refund is returned to the balance: Stripe's total no longer counts it.
      const refund = event.data.object;
      return {
        ...tenantMoney,
        objectType: 'refund',
        objectId: refund.id,
        posts: event.type === 'refund.failed' || refund.status === 'succeeded',
        transition: null,
        refundedCharge: idOf(refund.charge),
      };
    }
    case 'charge.dispute.funds_withdrawn':
      return {
        ...tenantMoney,
        objectType: 'dispute',
        objectId: event.data.object.id,
        posts: true,
        transition: (payment, now) => payment.dispute(now),
      };
    case 'charge.dispute.funds_reinstated':
      return {
        ...tenantMoney,
        objectType: 'dispute',
        objectId: event.data.object.id,
        posts: true,
        transition: (payment, now) => payment.reinstate(now),
      };
    case 'payout.paid':
    case 'payout.failed':
      return {
        objectType: 'payout',
        objectId: event.data.object.id,
        posts: true,
        transition: null,
        refundedCharge: null,
        platform: true,
      };
    default:
      return null;
  }
}

/** The id of an expandable Stripe reference (a string id or the expanded object), else null. */
const idOf = (ref: string | { readonly id: string } | null | undefined): string | null =>
  typeof ref === 'string' ? ref : (ref?.id ?? null);

const paymentIntentIdOf = (session: Stripe.Checkout.Session): string | null =>
  typeof session.payment_intent === 'string'
    ? session.payment_intent
    : (session.payment_intent?.id ?? null);

/** Our payment id, echoed by Stripe as `client_reference_id` (metadata as a fallback). */
const paymentIdOf = (session: Stripe.Checkout.Session): string | null => {
  const candidate = session.client_reference_id ?? session.metadata?.['paymentId'];
  return isUuid(candidate) ? candidate : null;
};

/** The system context of a webhook whose owner has no user (spec §9, method 8). */
const PLATFORM_WEBHOOK_REASON = 'billing.platform-webhook';

/**
 * Applies a Stripe webhook exactly once:
 * 1. Verify the signature over the raw bytes (422 `INVALID_WEBHOOK_SIGNATURE` before any I/O).
 * 2. Resolve the owner from the signed metadata (`stripeOwnerOf`), then act as that owner
 *    (B3-13; the principal is final before the unit of work opens):
 *    - **a user in a tenant**: `runWithPrincipal({ userId, tenantId, roles: [] })` around ONE
 *      transaction that records `stripe_events(id)` with `ON CONFLICT DO NOTHING` (a duplicate
 *      delivery stops here), applies the event to the row-locked payment and, when that completes
 *      the payment, enqueues `billing.payment-succeeded.v1` on `billing.outbox` (G-1: the event
 *      commits or rolls back with the payment; a failing enqueue fails the delivery, so Stripe
 *      retries it);
 *    - **no user** (platform-level objects, metadata that is not a tenant UUID, a user-less
 *      tenant): `SystemContext.run('billing.platform-webhook')` and the system method
 *      `stripeEvents.markProcessedAsPlatform` only. No payment is touched: the runtime policies
 *      need a user, and nothing else in billing may write through the system pool.
 * 3. After COMMIT, publish the aggregate's domain events on the in-process bus, so a rolled-back
 *    delivery never announces a payment. Kafka is reached only through the outbox relay
 *    (`OutboxModule`, at least once), never from the request path.
 *
 * Handled: `checkout.session.completed` / `async_payment_succeeded` → `succeeded` (only once the
 * session is actually paid), `async_payment_failed` → `failed`, `expired` → `expired`.
 *
 * Money events (L-11, `moneyEventOf`): `charge.succeeded`, `charge.refunded`, `refund.created` /
 * `refund.updated` (posting at status `succeeded`), `refund.failed`, `charge.dispute.funds_withdrawn`
 * (→ `disputed`), `charge.dispute.funds_reinstated` (`disputed` → the status the stored refunded
 * total gives) and `payout.paid` / `payout.failed`. Every refund event (`charge.refunded`,
 * `refund.updated`, `refund.failed`) reads the charge from Stripe and stores its CURRENT
 * `amount_refunded` (`payment.refund`, absolute: 0 → `succeeded`, below the amount →
 * `partially_refunded`, else `refunded`; a disputed payment stays disputed), so replayed and
 * out-of-order events converge on Stripe's state. While LEDGER_ENABLED, each event of the table
 * with a posting writes one `billing.ledger-posting.v1` row (envelope id `uuidv5(LEDGER_NAMESPACE,
 * evt id)`, key = tenant id) in the unit of work of its receipt; with the ledger off, transitions
 * and receipts happen and no row is written. The owner comes from `StripeOwnerResolver` (the
 * object's metadata, else its PaymentIntent: at most one Stripe GET); a refund event's charge is
 * one more GET. Every Stripe call happens BEFORE the unit of work opens. An unresolved owner is
 * recorded for the platform with a warning, touches no payment and writes no row (reconciliation
 * R4 posts it). A payment id that names no payment of the owner
 * (tenant and user) moves nothing, and its row says `paymentId: null`. Payouts are platform money:
 * `SystemContext.run('billing.platform-webhook')`, `outbox.insertAsPlatform` first (nil tenant and
 * key, null user and actor), then `stripeEvents.markProcessedAsPlatform`; both are idempotent, so a
 * crash between them is healed by Stripe's redelivery.
 *
 * Every other signed event is acknowledged and ignored. Events for unknown payments or impossible
 * transitions are acknowledged with a warning: retrying them could never succeed, and a thrown
 * error would make Stripe redeliver for days. Infrastructure errors DO throw — the transaction rolls back
 * (forgetting the event id) and Stripe's retry is processed again.
 *
 * A payment is only ever looked up inside the tenant named by the signed metadata, as its user
 * (RLS): an event naming another tenant or user finds nothing and is acknowledged. Sessions created
 * before B2 carry no owner: their events are recorded under the platform tenant, never applied.
 */
@CommandHandler(HandleStripeWebhookCommand)
export class HandleStripeWebhookHandler implements ICommandHandler<HandleStripeWebhookCommand> {
  private readonly logger = new Logger(HandleStripeWebhookHandler.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly owners: StripeOwnerResolver,
    private readonly stripeEvents: StripeEventsRepository,
    private readonly platformEvents: StripeEventsSystemRepository,
    private readonly payments: PaymentsRepository,
    private readonly outbox: BillingOutbox,
    private readonly outboxSystem: BillingOutboxSystemRepository,
    @Inject(ledgerConfig.KEY) private readonly ledger: LedgerConfig,
    private readonly publisher: EventPublisher,
    @InjectMetric(PAID_WITHOUT_CURRENCY_METRIC)
    private readonly paidWithoutCurrency: { inc(): void },
    @InjectMetric(AMOUNT_MISMATCH_METRIC)
    private readonly amountMismatch: { inc(): void },
    @InjectMetric(API_VERSION_MISMATCH_METRIC)
    private readonly apiVersionMismatch: { inc(): void },
    @InjectMetric(PAID_WITHOUT_AMOUNT_METRIC)
    private readonly paidWithoutAmount: { inc(): void },
  ) {}

  async execute(command: HandleStripeWebhookCommand): Promise<HandleStripeWebhookResponse> {
    const event = this.stripe.constructWebhookEvent(command.payload, command.signature);
    if (event.api_version !== null && event.api_version !== STRIPE_API_VERSION) {
      this.apiVersionMismatch.inc();
      this.logger.warn(
        `Stripe event ${event.id} uses API version ${event.api_version}, expected ${STRIPE_API_VERSION}: re-pin the webhook endpoint`,
      );
    }
    const money = moneyEventOf(event);
    if (money?.platform === true) {
      return SystemContext.run(PLATFORM_WEBHOOK_REASON, () =>
        this.recordPlatformMoney(event, money),
      );
    }
    if (money !== null) {
      const effect = { ...money, posts: money.posts && this.ledger.enabled };
      // Nothing to post and nothing to move: no owner lookup (no Stripe call), as any other event.
      const moves = effect.transition !== null || effect.refundedCharge !== null;
      if (effect.posts || moves) return this.applyMoney(event, effect);
    }
    const owner = stripeOwnerOf(event.data.object);
    if (owner.userId === null) {
      return SystemContext.run(PLATFORM_WEBHOOK_REASON, () => this.recordWithoutUser(event, owner));
    }
    return this.actAs(owner, owner.userId, () => this.process(event, owner, null));
  }

  /**
   * Spec §9: act as the user and tenant Stripe signed (an owner pairs a user only with a real tenant
   * UUID), with no roles: the policies need nothing more for the owner's own rows.
   */
  private actAs<T>(owner: StripeOwner, userId: string, work: () => Promise<T>): Promise<T> {
    return runWithPrincipal(createPrincipal({ userId, tenantId: owner.tenantId, roles: [] }), work);
  }

  /**
   * A tenant money event: resolve the owner and, for a refund event, read the charge's current
   * refunded total (Stripe, no unit of work open; a failure fails the delivery before anything is
   * written, and Stripe retries it), then apply it once.
   */
  private async applyMoney(
    event: Stripe.Event,
    money: MoneyEvent,
  ): Promise<HandleStripeWebhookResponse> {
    const owner = await this.owners.resolve(event.data.object);
    if (owner.unresolved) {
      this.logger.warn(
        `Stripe event ${event.id} (${event.type}): no tenant could be resolved for ${money.objectType} ${money.objectId}; recorded for the platform, no payment touched${money.posts ? ', no ledger posting (reconciliation R4 posts it)' : ''}`,
      );
      return SystemContext.run(PLATFORM_WEBHOOK_REASON, () => this.recordWithoutUser(event, owner));
    }
    const { userId } = owner;
    if (userId === null) {
      this.logger.warn(
        `Stripe event ${event.id} (${event.type}) names tenant ${owner.tenantId} but no user; recorded, no payment touched, no ledger posting`,
      );
      return SystemContext.run(PLATFORM_WEBHOOK_REASON, () => this.recordWithoutUser(event, owner));
    }
    const effect =
      money.refundedCharge === null
        ? money
        : { ...money, transition: await this.refundTransition(money.refundedCharge) };
    return this.actAs(owner, userId, () => this.process(event, owner, effect));
  }

  /** `payment.refund(total)` with Stripe's CURRENT `amount_refunded` of `chargeId` (one GET). */
  private async refundTransition(chargeId: string): Promise<Transition> {
    const { amount_refunded: total } = await this.stripe.retrieveCharge(chargeId);
    return (payment, now) => payment.refund(total, now);
  }

  /**
   * A payout (platform money), in `SystemContext`: the posting row first through
   * `outbox.insertAsPlatform` (idempotent by its deterministic id), then the receipt through
   * `stripeEvents.markProcessedAsPlatform`. The system pool has no transaction across the two: a
   * crash between them leaves the row and no receipt, so Stripe redelivers, the insert adds nothing
   * and the receipt is recorded; a later delivery answers `duplicate: true`.
   */
  private async recordPlatformMoney(
    event: Stripe.Event,
    money: MoneyEvent,
  ): Promise<HandleStripeWebhookResponse> {
    if (money.posts && this.ledger.enabled) {
      const record = ledgerPostingRecord(
        this.outbox,
        event,
        { ...PLATFORM_OWNER, paymentId: null },
        money.objectType,
        money.objectId,
      );
      await this.outboxSystem.insertAsPlatform([record]);
    }
    return this.recordWithoutUser(event, PLATFORM_OWNER);
  }

  /** Records a user-less event once (system method), and touches nothing else. */
  private async recordWithoutUser(
    event: Stripe.Event,
    owner: StripeOwner,
  ): Promise<HandleStripeWebhookResponse> {
    const firstDelivery = await this.platformEvents.markProcessedAsPlatform({
      tenantId: owner.tenantId,
      userId: null,
      id: event.id,
      type: event.type,
    });
    if (!firstDelivery) {
      this.logger.debug(`Duplicate Stripe event ${event.id} (${event.type}) acknowledged`);
    } else if (event.type.startsWith('checkout.session.')) {
      // Checkout always signs the paying user: a session without one is not ours to apply.
      this.logger.warn(
        `Stripe event ${event.id} (${event.type}) carries no user: recorded, no payment applied`,
      );
    } else {
      this.logger.debug(`Recorded Stripe event ${event.id} (${event.type}) without a user`);
    }
    return {
      received: true,
      eventId: event.id,
      eventType: event.type,
      duplicate: !firstDelivery,
    };
  }

  private async process(
    event: Stripe.Event,
    owner: PaymentOwner,
    money: MoneyEvent | null,
  ): Promise<HandleStripeWebhookResponse> {
    const outcome = await this.applyOnce(event, owner, money);
    if (outcome.payment !== null) this.publisher.mergeObjectContext(outcome.payment).commit();
    return {
      received: true,
      eventId: event.id,
      eventType: event.type,
      duplicate: outcome.duplicate,
    };
  }

  @Transactional()
  protected async applyOnce(
    event: Stripe.Event,
    owner: PaymentOwner,
    money: MoneyEvent | null,
  ): Promise<WebhookOutcome> {
    // `owner` comes from metadata Stripe signed (checkout put it there) and is the principal of
    // this transaction: the policy accepts the receipt only under that tenant and user.
    const firstDelivery = await this.stripeEvents.markProcessed({
      tenantId: owner.tenantId,
      userId: owner.userId,
      id: event.id,
      type: event.type,
    });
    if (!firstDelivery) {
      this.logger.debug(`Duplicate Stripe event ${event.id} (${event.type}) acknowledged`);
      return { duplicate: true, payment: null };
    }
    if (money !== null) {
      await this.applyMoneyOnce(event, owner, money);
      return { duplicate: false, payment: null };
    }

    const paidAt = new Date(event.created * 1_000);
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        // Delayed methods (bank debits…) complete the session unpaid; async_payment_succeeded follows.
        if (session.payment_status === 'unpaid') {
          this.logger.debug(`Checkout Session ${session.id} completed, awaiting async payment`);
          return { duplicate: false, payment: null };
        }
        const payment = await this.transition(event, owner, session, (p, now) => {
          if (
            normalizeCurrency(session.currency) === null &&
            normalizeCurrency(p.currency) === null
          ) {
            // `complete()` refuses it too; say why, loudly: money was taken but no receipt goes out.
            this.paidWithoutCurrency.inc();
            this.logger.warn(
              `Stripe event ${event.id} (${event.type}): Checkout Session ${session.id} is paid but neither it nor payment ${p.id} has a currency; payment left ${p.status}, not announced`,
            );
            return false;
          }
          if (session.amount_total === null && p.amountTotal === null) {
            // `complete()` refuses it too (it never records 0); same alert path as the currency case.
            this.paidWithoutAmount.inc();
            this.logger.warn(
              `Stripe event ${event.id} (${event.type}): Checkout Session ${session.id} is paid but neither it nor payment ${p.id} has an amount; payment left ${p.status}, not announced`,
            );
            return false;
          }
          const quoted = { amount: p.amountTotal, currency: normalizeCurrency(p.currency) };
          const applied = p.complete(
            {
              sessionId: session.id,
              paymentIntentId: paymentIntentIdOf(session),
              amountTotal: session.amount_total,
              currency: session.currency,
              paidAt,
            },
            now,
          );
          const charged = { amount: p.amountTotal, currency: normalizeCurrency(p.currency) };
          if (
            applied &&
            quoted.amount !== null &&
            quoted.currency !== null &&
            charged.amount !== null &&
            charged.currency !== null &&
            (charged.amount !== quoted.amount || charged.currency !== quoted.currency)
          ) {
            this.amountMismatch.inc();
            this.logger.warn(
              `Stripe event ${event.id}: payment ${p.id} was quoted ${quoted.amount} ${quoted.currency} but Stripe charged ${charged.amount} ${charged.currency}; recorded as charged`,
            );
          }
          return applied;
        });
        if (payment !== null) await this.enqueueSucceeded(payment, owner);
        return { duplicate: false, payment };
      }
      case 'checkout.session.async_payment_failed':
        await this.transition(event, owner, event.data.object, (p, now) => p.markFailed(now));
        return { duplicate: false, payment: null };
      case 'checkout.session.expired':
        await this.transition(event, owner, event.data.object, (p, now) => p.expire(now));
        return { duplicate: false, payment: null };
      default:
        this.logger.debug(`Ignoring Stripe event ${event.id} (${event.type})`);
        return { duplicate: false, payment: null };
    }
  }

  /**
   * `billing.payment-succeeded.v1` for the `PaymentSucceededEvent` that `complete()` applied, in
   * this unit of work (after `markProcessed` and `save`, before COMMIT): key = the user id,
   * envelope id = the domain event id, `occurredAt` = `paidAt`, tenant and actor = the signed owner
   * (the unit of work's principal; the payment was found under that tenant, as that user).
   */
  private async enqueueSucceeded(payment: Payment, owner: StripeOwner): Promise<void> {
    for (const event of payment.getUncommittedEvents()) {
      if (!(event instanceof PaymentSucceededEvent)) continue;
      await this.outbox.enqueue(PAYMENT_SUCCEEDED_EVENT, toPaymentSucceededPayload(event), {
        key: event.userId,
        eventId: event.eventId,
        occurredAt: event.paidAt,
        tenantId: owner.tenantId,
        actorId: owner.userId,
      });
    }
  }

  /**
   * A tenant money event in the unit of work of its receipt (after `markProcessed`): the payment
   * transition (optimistic lock on `version`), then the posting row, enqueued as the owner, naming
   * the payment only when it is the owner's.
   */
  private async applyMoneyOnce(
    event: Stripe.Event,
    owner: PaymentOwner,
    money: MoneyEvent,
  ): Promise<void> {
    const payment = await this.ownersPayment(owner);
    if (money.transition !== null) {
      if (payment === null) {
        this.logger.warn(
          `Stripe event ${event.id} (${event.type}): no payment of the owner for ${money.objectType} ${money.objectId}; acknowledged`,
        );
      } else if (!money.transition(payment, new Date())) {
        this.logger.warn(
          `Stripe event ${event.id} (${event.type}) does not apply to payment ${payment.id} (status ${payment.status}); acknowledged`,
        );
      } else {
        await this.payments.save(payment);
      }
    }
    if (!money.posts) return;
    const { payload, options } = ledgerPostingRequest(
      event,
      postingOwnerOf(owner, payment),
      money.objectType,
      money.objectId,
    );
    await this.outbox.enqueue(LEDGER_POSTING_REQUESTED_EVENT, payload, options);
  }

  /**
   * The payment the signed metadata names, when it is the owner's: in the owner's tenant (RLS and
   * `tenant_id`) and of the owner's user. `null` otherwise, or when no payment id was signed.
   */
  private async ownersPayment(owner: PaymentOwner): Promise<Payment | null> {
    const paymentId = owner.paymentId ?? null;
    if (paymentId === null) return null;
    const payment = await this.payments.findById(owner.tenantId, paymentId);
    return postingOwnerOf(owner, payment).paymentId === null ? null : payment;
  }

  /** Loads the row-locked payment of `session`, applies `apply`, saves when it changed. */
  private async transition(
    event: Stripe.Event,
    owner: StripeOwner,
    session: Stripe.Checkout.Session,
    apply: Transition,
  ): Promise<Payment | null> {
    const payment = await this.payments.findForCheckoutSession({
      tenantId: owner.tenantId,
      paymentId: paymentIdOf(session),
      sessionId: session.id,
    });
    if (payment === null) {
      this.logger.warn(
        `Stripe event ${event.id} (${event.type}): no payment for Checkout Session ${session.id}; acknowledged`,
      );
      return null;
    }
    if (!apply(payment, new Date())) {
      this.logger.warn(
        `Stripe event ${event.id} (${event.type}) does not apply to payment ${payment.id} (status ${payment.status}); acknowledged`,
      );
      return null;
    }
    await this.payments.save(payment);
    return payment;
  }
}
