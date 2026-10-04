/**
 * @app/billing — the billing bounded context: Stripe Checkout sessions (idempotent), signed and
 * exactly-once Stripe webhooks, the payments ledger (Drizzle) and the
 * `billing.payment-succeeded.v1` integration event.
 *
 * Wiring: `BillingCoreModule` (handlers, relay, repositories) + `BillingGrpcModule`
 * (billing-service) or `BillingApiModule.forLocal()` (monolith) / `.forRemote()` (gateway).
 * `billingSchema` goes into `DatabaseModule.forRootAsync({ schema })`.
 */

// Application
export * from './application/commands/create-checkout-session/create-checkout-session.command.js';
export * from './application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
export * from './application/mappers/payment.mapper.js';
export * from './application/ports/billing.port.js';
export * from './application/queries/list-payments/list-payments.query.js';
// Modules
export * from './billing.constants.js';
export * from './billing-api.module.js';
export * from './billing-core.module.js';
export * from './billing-grpc.module.js';
// Domain
export * from './domain/billing.errors.js';
export * from './domain/events/payment-succeeded.event.js';
export * from './domain/payment.aggregate.js';
export * from './domain/payment-status.enum.js';
// Infrastructure (adapters are public for custom wiring / tests)
export * from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
export * from './infrastructure/adapters/local/billing-local.adapter.js';
export {
  type BillingSchema,
  billingSchema,
  type PaymentRow,
  paymentStatusEnum,
  payments,
  type StripeEventRow,
  stripeEvents,
} from './infrastructure/persistence/billing.schema.js';
// Presentation
export * from './presentation/graphql/billing.resolver.js';
export * from './presentation/graphql/models/checkout-session.model.js';
export * from './presentation/graphql/models/payment.model.js';
export * from './presentation/grpc/billing-grpc.controller.js';
export * from './presentation/http/billing.controller.js';
