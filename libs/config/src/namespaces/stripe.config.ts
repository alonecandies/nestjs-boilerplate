import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt, zNodeEnv, zStr, zUrl } from '../env/env.helpers.js';

/** Development-only defaults so `bun run dev` works with zero `.env`. Rejected in production. */
export const PLACEHOLDER_STRIPE_SECRET_KEY = 'sk_test_placeholder';
export const PLACEHOLDER_STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';

export const stripeEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    STRIPE_SECRET_KEY: zStr(PLACEHOLDER_STRIPE_SECRET_KEY, {
      pattern: /^(sk|rk)_(test|live)_/,
      patternMessage: 'Expected a Stripe secret or restricted key (sk_/rk_…)',
    }),
    STRIPE_WEBHOOK_SECRET: zStr(PLACEHOLDER_STRIPE_WEBHOOK_SECRET, {
      pattern: /^whsec_/,
      patternMessage: 'Expected a webhook signing secret (whsec_…)',
    }),
    STRIPE_SUCCESS_URL: zUrl('http://localhost:3000/billing/success', /^https?$/),
    STRIPE_CANCEL_URL: zUrl('http://localhost:3000/billing/cancel', /^https?$/),
    STRIPE_MAX_NETWORK_RETRIES: zInt(2, { min: 0, max: 10 }),
    STRIPE_TIMEOUT_MS: zInt(20_000, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // A publicly known webhook secret lets anyone forge `checkout.session.completed` and mark
    // payments as paid — fail fast at boot instead (same policy as the JWT dev secrets).
    const placeholders = {
      STRIPE_SECRET_KEY: PLACEHOLDER_STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: PLACEHOLDER_STRIPE_WEBHOOK_SECRET,
    } as const;
    for (const [key, placeholder] of Object.entries(placeholders) as [
      keyof typeof placeholders,
      string,
    ][]) {
      if (env[key] === placeholder) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be set to a real Stripe value in production (the development placeholder is not allowed)`,
        });
      }
    }
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
