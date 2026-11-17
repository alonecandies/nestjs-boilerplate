import type { HandleStripeWebhookResponse } from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
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
import { normalizeCurrency, type Payment } from '../../../domain/payment.aggregate.js';
import { type StripeOwner, stripeOwnerOf } from '../../../domain/stripe-owner.js';
import { STRIPE_API_VERSION } from '../../../infrastructure/stripe/stripe.constants.js';
import { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
import { StripeEventsSystemRepository } from '../../repositories/stripe-events.system-repository.js';
import { HandleStripeWebhookCommand } from './handle-stripe-webhook.command.js';

interface WebhookOutcome {
  duplicate: boolean;
  /** Payment whose uncommitted events must be published once the transaction committed. */
  payment: Payment | null;
}

type Transition = (payment: Payment, now: Date) => boolean;

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
 *      delivery stops here) and applies the event to the row-locked payment;
 *    - **no user** (platform-level objects, metadata that is not a tenant UUID, a user-less
 *      tenant): `SystemContext.run('billing.platform-webhook')` and the system method
 *      `stripeEvents.markProcessedAsPlatform` only. No payment is touched: the runtime policies
 *      need a user, and nothing else in billing may write through the system pool.
 * 3. After COMMIT, publish the aggregate's domain events (`PaymentSucceededEvent` → Kafka relay),
 *    so a rolled-back delivery never announces a payment.
 *
 * Handled: `checkout.session.completed` / `async_payment_succeeded` → `succeeded` (only once the
 * session is actually paid), `async_payment_failed` → `failed`, `expired` → `expired`. Every other
 * signed event is acknowledged and ignored. Events for unknown payments or impossible transitions
 * are acknowledged with a warning: retrying them could never succeed, and a thrown error would
 * make Stripe redeliver for days. Infrastructure errors DO throw — the transaction rolls back
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
    private readonly stripeEvents: StripeEventsRepository,
    private readonly platformEvents: StripeEventsSystemRepository,
    private readonly payments: PaymentsRepository,
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
    const owner = stripeOwnerOf(event.data.object);
    const { userId, tenantId } = owner;
    if (userId === null) {
      return SystemContext.run(PLATFORM_WEBHOOK_REASON, () => this.recordWithoutUser(event, owner));
    }
    // Spec §9: act as the user and tenant Stripe signed (stripeOwnerOf only pairs a user with a
    // real tenant UUID), with no roles: the policies need nothing more for the owner's own rows.
    return runWithPrincipal(createPrincipal({ userId, tenantId, roles: [] }), () =>
      this.process(event, owner),
    );
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
    owner: StripeOwner,
  ): Promise<HandleStripeWebhookResponse> {
    const outcome = await this.applyOnce(event, owner);
    if (outcome.payment !== null) this.publisher.mergeObjectContext(outcome.payment).commit();
    return {
      received: true,
      eventId: event.id,
      eventType: event.type,
      duplicate: outcome.duplicate,
    };
  }

  @Transactional()
  protected async applyOnce(event: Stripe.Event, owner: StripeOwner): Promise<WebhookOutcome> {
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
