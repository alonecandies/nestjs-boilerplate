import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const billingGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: billing-service:50051).
    BILLING_GRPC_URL: zStr('localhost:50053'),
  })
  .transform((env) => ({
    /** Target of `billing.v1.BillingService`. */
    url: env.BILLING_GRPC_URL,
  }));

/**
 * Where the gateway dials billing-service. Read by `BillingApiModule.forRemote()` when the module
 * is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const billingGrpcClientConfig = defineConfigNamespace(
  'billingGrpcClient',
  billingGrpcClientEnvSchema,
);
export type BillingGrpcClientConfig = ConfigType<typeof billingGrpcClientConfig>;
