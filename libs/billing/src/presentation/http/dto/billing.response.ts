import type { Payment } from '@app/contracts';
import { z } from 'zod';
import { PAYMENT_STATUSES } from '../../../domain/payment-status.enum.js';

/*
 * REST response schemas: documented in OpenAPI (`@ApiOkResponse({ standardSchema })`) and enforced
 * by `StandardSchemaSerializerInterceptor` (`@SerializeOptions({ schema })`), which strips any
 * field not listed here. The `to*Response` mappers build the exact JSON shape (ISO dates,
 * numeric minor-unit amounts).
 */

export const checkoutSessionResponseSchema = z
  .object({
    id: z.string().describe('Stripe Checkout Session id (`cs_…`)'),
    url: z.url().describe('Hosted Checkout page to redirect the customer to'),
    paymentId: z.uuid(),
  })
  .meta({ id: 'CheckoutSession' });
export type CheckoutSessionResponse = z.infer<typeof checkoutSessionResponseSchema>;

export const paymentResponseSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    status: z.enum(PAYMENT_STATUSES),
    amountTotal: z.number().int().nonnegative().describe('Minor currency units (e.g. cents)'),
    currency: z.string().describe('ISO 4217, lowercase; empty until Stripe priced the session'),
    priceId: z.string(),
    quantity: z.number().int(),
    stripeCheckoutSessionId: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Payment' });
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

export const paymentListResponseSchema = z
  .object({ items: z.array(paymentResponseSchema) })
  .meta({ id: 'PaymentList' });
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

export const stripeWebhookResponseSchema = z
  .object({
    received: z.boolean(),
    eventId: z.string(),
    eventType: z.string(),
    duplicate: z.boolean().describe('The event id had already been processed'),
  })
  .meta({ id: 'StripeWebhookAck' });
export type StripeWebhookResponse = z.infer<typeof stripeWebhookResponseSchema>;

const isoOrNull = (value: Date | undefined): string | null => value?.toISOString() ?? null;

export function toPaymentResponse(payment: Payment): PaymentResponse {
  return {
    id: payment.id,
    userId: payment.userId,
    status: payment.status as PaymentResponse['status'],
    amountTotal: Number(payment.amountTotal),
    currency: payment.currency,
    priceId: payment.priceId,
    quantity: payment.quantity,
    stripeCheckoutSessionId: payment.stripeCheckoutSessionId ?? null,
    createdAt: isoOrNull(payment.createdAt),
    updatedAt: isoOrNull(payment.updatedAt),
  };
}
