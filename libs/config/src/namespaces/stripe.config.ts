import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt, zStr, zUrl } from '../env/env.helpers.js';

export const stripeEnvSchema = z
  .object({
    STRIPE_SECRET_KEY: zStr('sk_test_placeholder', {
      pattern: /^(sk|rk)_(test|live)_/,
      patternMessage: 'Expected a Stripe secret or restricted key (sk_/rk_…)',
    }),
    STRIPE_WEBHOOK_SECRET: zStr('whsec_placeholder', {
      pattern: /^whsec_/,
      patternMessage: 'Expected a webhook signing secret (whsec_…)',
    }),
    STRIPE_SUCCESS_URL: zUrl('http://localhost:3000/billing/success', /^https?$/),
    STRIPE_CANCEL_URL: zUrl('http://localhost:3000/billing/cancel', /^https?$/),
    STRIPE_MAX_NETWORK_RETRIES: zInt(2, { min: 0, max: 10 }),
    STRIPE_TIMEOUT_MS: zInt(20_000, { min: 1 }),
  })
  .transform((env) => ({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    successUrl: env.STRIPE_SUCCESS_URL,
    cancelUrl: env.STRIPE_CANCEL_URL,
    /** Stripe retries idempotently (it sends Idempotency-Key on retries), so this is safe. */
    maxNetworkRetries: env.STRIPE_MAX_NETWORK_RETRIES,
    timeoutMs: env.STRIPE_TIMEOUT_MS,
  }));

/** Stripe API client + webhook verification + Checkout redirect URLs. */
export const stripeConfig = defineConfigNamespace('stripe', stripeEnvSchema);
export type StripeConfig = ConfigType<typeof stripeConfig>;
