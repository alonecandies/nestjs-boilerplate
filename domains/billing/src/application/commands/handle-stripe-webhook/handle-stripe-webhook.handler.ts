import type { HandleStripeWebhookResponse } from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, isUuid, runWithPrincipal } from '@platform/common';
import { Transactional } from '@platform/database';
import { InjectMetric } from '@platform/observability';
import type Stripe from 'stripe';
import {
  AMOUNT_MISMATCH_METRIC,
  API_VERSION_MISMATCH_METRIC,
  PAID_WITHOUT_CURRENCY_METRIC,
} from '../../../billing.constants.js';
import { normalizeCurrency, type Payment } from '../../../domain/payment.aggregate.js';
import { type StripeOwner, stripeOwnerOf } from '../../../domain/stripe-owner.js';
import { STRIPE_API_VERSION } from '../../../infrastructure/stripe/stripe.constants.js';
import { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
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

/**
 * Applies a Stripe webhook exactly once:
 * 1. Verify the signature over the raw bytes (422 `INVALID_WEBHOOK_SIGNATURE` before any I/O).
 * 2. In ONE transaction: record `stripe_events(id)` with `ON CONFLICT DO NOTHING` (a duplicate
 *    delivery stops here) and apply the event to the row-locked payment.
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
 * A payment is only ever looked up inside the tenant named by the signed metadata: an event naming
 * another tenant finds nothing and is acknowledged. Sessions created before B2 carry no tenant and
 * resolve to the platform tenant, where `0001` moved their payments.
 */
@CommandHandler(HandleStripeWebhookCommand)
export class HandleStripeWebhookHandler implements ICommandHandler<HandleStripeWebhookCommand> {
  private readonly logger = new Logger(HandleStripeWebhookHandler.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly stripeEvents: StripeEventsRepository,
    private readonly payments: PaymentsRepository,
    private readonly publisher: EventPublisher,
    @InjectMetric(PAID_WITHOUT_CURRENCY_METRIC)
    private readonly paidWithoutCurrency: { inc(): void },
    @InjectMetric(AMOUNT_MISMATCH_METRIC)
    private readonly amountMismatch: { inc(): void },
    @InjectMetric(API_VERSION_MISMATCH_METRIC)
    private readonly apiVersionMismatch: { inc(): void },
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
    const work = () => this.process(event, owner);
    // Spec §9: act as the user and tenant Stripe signed; platform-level events have no user and run
    // without a principal (B3-11 moves their writes to the system pool).
    return owner.userId === null
      ? work()
      : runWithPrincipal(createPrincipal({ userId: owner.userId, tenantId: owner.tenantId }), work);
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
    // `owner` comes from metadata Stripe signed (checkout put it there); events without one are
    // platform-level and recorded under PLATFORM_TENANT_ID with a NULL user (spec §9, method 8).
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
