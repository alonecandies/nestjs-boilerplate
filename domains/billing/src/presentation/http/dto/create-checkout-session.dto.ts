import { z } from 'zod';
import { BILLING_LIMITS } from '../../../billing.constants.js';

/**
 * `POST /v1/billing/checkout-sessions` body (Nest-native Standard Schema: `@Body({ schema })`).
 * Strict: unknown keys are a 400, like `forbidNonWhitelisted` DTOs. Redirect URLs are NOT
 * accepted from clients (open-redirect risk): they come from `STRIPE_SUCCESS_URL` /
 * `STRIPE_CANCEL_URL`.
 */
export const createCheckoutSessionBodySchema = z
  .strictObject({
    priceId: z
      .string()
      .trim()
      .min(1)
      .max(BILLING_LIMITS.PRICE_ID_MAX_LENGTH)
      .describe('Stripe Price id (`price_…`)'),
    quantity: z.number().int().min(1).max(BILLING_LIMITS.MAX_QUANTITY).default(1),
  })
  .meta({ id: 'CreateCheckoutSessionBody' });

export type CreateCheckoutSessionBody = z.infer<typeof createCheckoutSessionBodySchema>;
