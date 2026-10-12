import { z } from 'zod';
import { defineEventContract, type EventContract } from './event-contract.js';

/** Payload of `billing.payment-succeeded.v1`: a Stripe Checkout Session was paid. */
export const paymentSucceededPayload = z.object({
  paymentId: z.uuid(),
  userId: z.uuid(),
  stripeCheckoutSessionId: z.string().min(1),
  /** Minor currency units (cents). A JSON number: safe up to 2^53, far beyond any real amount. */
  amountTotal: z.number().int().nonnegative(),
  /** ISO 4217 code as reported by Stripe (lowercase). */
  currency: z.string().length(3),
  paidAt: z.iso.datetime(),
});

export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayload>;

/** A Checkout Session was paid. Produced by billing; notifications sends the receipt. */
export const PAYMENT_SUCCEEDED_EVENT: EventContract<PaymentSucceededPayload> = defineEventContract(
  'billing.payment-succeeded.v1',
  paymentSucceededPayload,
);
