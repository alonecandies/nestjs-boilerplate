import { z } from 'zod';
import { BILLING_LIMITS, IDEMPOTENCY_KEY_PATTERN } from '../../billing.constants.js';

/*
 * gRPC payload schemas (`ZodRpcValidationPipe`). ts-proto request types are interfaces, so
 * class-validator cannot see them. proto-loader (`defaults: true`) decodes absent optional fields
 * as `null`: every optional field accepts null and normalises it to `undefined`.
 */

const absentAsUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const createCheckoutSessionRpcSchema = z.object({
  userId: z.uuid(),
  customerEmail: z.email(),
  priceId: z.string().trim().min(1).max(BILLING_LIMITS.PRICE_ID_MAX_LENGTH),
  quantity: z.number().int().min(1).max(BILLING_LIMITS.MAX_QUANTITY),
  successUrl: z.url().nullish().transform(absentAsUndefined),
  cancelUrl: z.url().nullish().transform(absentAsUndefined),
  idempotencyKey: z
    .string()
    .min(BILLING_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH)
    .max(BILLING_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(IDEMPOTENCY_KEY_PATTERN)
    .nullish()
    .transform(absentAsUndefined),
});

export const handleStripeWebhookRpcSchema = z.object({
  // `bytes` → Buffer with proto-loader defaults; a plain Uint8Array (other clients) is wrapped
  // without copying. The signature is verified over exactly these bytes.
  payload: z
    .instanceof(Uint8Array)
    .transform((bytes) =>
      Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ),
  signature: z.string(),
});

export const listPaymentsRpcSchema = z.object({
  userId: z.uuid().nullish().transform(absentAsUndefined),
  // 0 = "not set" in proto3; the query handler applies the default page size.
  limit: z.number().int().min(0).max(BILLING_LIMITS.MAX_PAGE_SIZE),
});
