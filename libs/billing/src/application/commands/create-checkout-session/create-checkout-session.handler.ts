import { DomainConflictException, generateId } from '@app/common';
import { type StripeConfig, stripeConfig } from '@app/config';
import type { CheckoutSession } from '@app/contracts';
import { StripeService } from '@app/payments';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type Stripe from 'stripe';
import {
  CheckoutUrlMissingException,
  IdempotencyKeyReusedException,
} from '../../../domain/billing.errors.js';
import { Payment } from '../../../domain/payment.aggregate.js';
import { PaymentsRepository } from '../../repositories/payments.repository.js';
import { CreateCheckoutSessionCommand } from './create-checkout-session.command.js';

/**
 * The Stripe idempotency key of a payment's Checkout Session. It is derived from OUR payment id —
 * never the raw client `Idempotency-Key` — because Stripe keys are account-wide: two users sending
 * the same header value must not share a session. Replays of the same client key resolve to the
 * same payment (unique `(user_id, idempotency_key)`), hence to the same Stripe key and session.
 */
export const checkoutIdempotencyKey = (paymentId: string): string => `checkout-${paymentId}`;

/**
 * 1. Insert a `pending` payment first (or find the one this `Idempotency-Key` already created), so
 *    the payment id exists before Stripe sees it (`client_reference_id` + metadata).
 * 2. Create the Checkout Session with an idempotency key derived from that id: client retries and
 *    crash-after-Stripe retries get the SAME session.
 * 3. Bind the session (id, amount, currency) to the payment with an optimistic-locked save.
 *
 * No database transaction spans the Stripe call (it may take seconds); each write is atomic on its
 * own and every step is safe to repeat.
 */
@CommandHandler(CreateCheckoutSessionCommand)
export class CreateCheckoutSessionHandler implements ICommandHandler<CreateCheckoutSessionCommand> {
  private readonly logger = new Logger(CreateCheckoutSessionHandler.name);

  constructor(
    private readonly payments: PaymentsRepository,
    private readonly stripe: StripeService,
    @Inject(stripeConfig.KEY) private readonly config: StripeConfig,
  ) {}

  async execute({ request }: CreateCheckoutSessionCommand): Promise<CheckoutSession> {
    const { payment, created } = await this.payments.create(
      Payment.initiate({
        id: generateId(),
        userId: request.userId,
        priceId: request.priceId,
        quantity: request.quantity,
        idempotencyKey: request.idempotencyKey,
        now: new Date(),
      }),
    );
    if (!created && !payment.matchesRequest(request)) throw new IdempotencyKeyReusedException();

    const session = await this.createSession(payment, request);
    if (
      payment.attachCheckoutSession(
        { id: session.id, amountTotal: session.amount_total, currency: session.currency },
        new Date(),
      )
    ) {
      await this.payments.save(payment);
    }
    if (!session.url) throw new CheckoutUrlMissingException();
    return { id: session.id, url: session.url, paymentId: payment.id };
  }

  private async createSession(
    payment: Payment,
    request: CreateCheckoutSessionCommand['request'],
  ): Promise<Stripe.Checkout.Session> {
    try {
      return await this.stripe.createCheckoutSession(
        {
          customerEmail: request.customerEmail,
          priceId: payment.priceId,
          quantity: payment.quantity,
          successUrl: request.successUrl ?? this.config.successUrl,
          cancelUrl: request.cancelUrl ?? this.config.cancelUrl,
          clientReferenceId: payment.id,
          metadata: { paymentId: payment.id, userId: payment.userId },
        },
        checkoutIdempotencyKey(payment.id),
      );
    } catch (error) {
      await this.recordFailure(payment, error);
      throw error;
    }
  }

  /**
   * A payment that never got a session is marked `failed` (a retry with the same key reopens it).
   * Not on a 409 from Stripe: the same key is in flight in a concurrent request, which owns the
   * outcome. Best effort: the Stripe error is what the caller must see, not a database error.
   */
  private async recordFailure(payment: Payment, cause: unknown): Promise<void> {
    if (cause instanceof DomainConflictException) return;
    if (payment.stripeCheckoutSessionId !== null || !payment.markFailed(new Date())) return;
    try {
      await this.payments.save(payment);
    } catch (error) {
      this.logger.warn(
        `Could not mark payment ${payment.id} as failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
