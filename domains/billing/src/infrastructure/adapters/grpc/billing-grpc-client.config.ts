import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt, zStr } from '@platform/config';
import { z } from 'zod';

export const billingGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: billing-service:50051).
    BILLING_GRPC_URL: zStr('localhost:50053'),
    // Deadline of the Stripe-backed calls over gRPC (CreateCheckoutSession, HandleStripeWebhook):
    // the monolith gives the same routes HTTP_HANDLER_TIMEOUT_MS (30000). Every other call keeps
    // GRPC_DEADLINE_MS.
    BILLING_GRPC_STRIPE_DEADLINE_MS: zInt(30_000, { min: 1_000, max: 900_000 }),
  })
  .transform((env) => ({
    /** Target of `billing.v1.BillingService`. */
    url: env.BILLING_GRPC_URL,
    /** Deadline of `CreateCheckoutSession` and `HandleStripeWebhook` (ms). */
    stripeDeadlineMs: env.BILLING_GRPC_STRIPE_DEADLINE_MS,
  }));

/**
 * Where the gateway dials billing-service, and how long a Stripe-backed call may take. Read by
 * `BillingApiModule.forRemote()` when the module is defined; message limits and TLS stay in the
 * platform `grpc` namespace, as does `GRPC_DEADLINE_MS` for every other billing call.
 */
export const billingGrpcClientConfig = defineConfigNamespace(
  'billingGrpcClient',
  billingGrpcClientEnvSchema,
);
export type BillingGrpcClientConfig = ConfigType<typeof billingGrpcClientConfig>;
