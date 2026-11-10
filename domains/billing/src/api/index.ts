/**
 * @domain/billing/api — the edge surface of billing: `BillingApiModule` (`forRemote()` for the
 * gateway; `forLocal()` for the monolith, which also imports `BillingCoreModule` from
 * `@domain/billing`), `BillingPort` and its adapters, the gRPC client config, the REST / GraphQL
 * presentation and the log-redaction paths. No core, persistence or Stripe code is reachable from here.
 */
export { BillingPort } from '../application/ports/billing.port.js';
export {
  BILLING_GRPC_UPSTREAM,
  BILLING_LIMITS,
  BillingErrorCode,
  IDEMPOTENCY_KEY_PATTERN,
  STRIPE_SIGNATURE_HEADER,
} from '../billing.constants.js';
export { BillingApiModule } from '../billing-api.module.js';
export { BILLING_LOG_REDACT_PATHS } from '../billing-log-redaction.js';
export { isPaymentStatus, PAYMENT_STATUSES, PaymentStatus } from '../domain/payment-status.enum.js';
export {
  BillingGrpcAdapter,
  normalizePayment,
} from '../infrastructure/adapters/grpc/billing-grpc.adapter.js';
export {
  type BillingGrpcClientConfig,
  billingGrpcClientConfig,
  billingGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/billing-grpc-client.config.js';
export { BillingLocalAdapter } from '../infrastructure/adapters/local/billing-local.adapter.js';
export { BillingResolver } from '../presentation/graphql/billing.resolver.js';
export { CheckoutSessionModel } from '../presentation/graphql/models/checkout-session.model.js';
export {
  PaymentConnectionModel,
  PaymentModel,
  PaymentStatusGraphqlEnum,
  toPaymentConnectionModel,
  toPaymentModel,
} from '../presentation/graphql/models/payment.model.js';
export { BillingController } from '../presentation/http/billing.controller.js';
