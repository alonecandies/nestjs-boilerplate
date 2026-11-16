/**
 * @domain/billing — the billing bounded context: Stripe Checkout sessions (idempotent), signed and
 * exactly-once Stripe webhooks, the payments ledger (Drizzle) and the
 * `billing.payment-succeeded.v1` integration event.
 *
 * Entry points: `@domain/billing/api` (edge surface, re-exported here) and this root entry (adds
 * core, persistence, the Stripe adapter, commands, queries and domain types).
 * Wiring: `BillingCoreModule` + `BillingGrpcModule` (billing-service), `BillingCoreModule` +
 * `BillingApiModule.forLocal()` (monolith), `BillingApiModule.forRemote()` from
 * `@domain/billing/api` (gateway). `billingSchema` and the migration set `billingMigrations` go into
 * `DatabaseModule.forRootAsync({ schema, migrations })`.
 */

// The edge surface (also `@domain/billing/api`).
export * from './api/index.js';
// Application
export * from './application/commands/create-checkout-session/create-checkout-session.command.js';
export * from './application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
// Ledger (model)
export * from './application/ledger/posting-rules.js';
export * from './application/mappers/payment.mapper.js';
export * from './application/ports/ledger.port.js';
export * from './application/queries/list-payments/list-payments.query.js';
// Modules and core constants
export {
  PAID_WITHOUT_CURRENCY_METRIC,
  PURGE_STRIPE_EVENTS_BATCH_SIZE,
  PURGE_STRIPE_EVENTS_LOCK,
  PURGE_STRIPE_EVENTS_LOCK_TTL_MS,
  STRIPE_EVENTS_RETENTION_DAYS,
} from './billing.constants.js';
export * from './billing-core.module.js';
export * from './billing-grpc.module.js';
// Domain
export * from './domain/billing.errors.js';
export * from './domain/events/payment-succeeded.event.js';
export * from './domain/ledger/ledger.accounts.js';
export * from './domain/ledger/ledger.errors.js';
export * from './domain/ledger/ledger.ids.js';
export * from './domain/ledger/ledger.invariant.js';
export * from './domain/ledger/ledger.types.js';
export * from './domain/payment.aggregate.js';
// Infrastructure
export * from './infrastructure/ledger/billing-ledger.migrations.js';
export * from './infrastructure/ledger/immudb-ledger.adapter.js';
export { billingMigrations } from './infrastructure/persistence/billing.migrations.js';
export {
  type BillingSchema,
  billingSchema,
  type PaymentRow,
  paymentStatusEnum,
  payments,
  type StripeEventRow,
  stripeEvents,
} from './infrastructure/persistence/billing.schema.js';
// Stripe adapter (imported by BillingCoreModule; public for custom wiring / tests)
export * from './infrastructure/stripe/stripe.config.js';
export * from './infrastructure/stripe/stripe.constants.js';
export * from './infrastructure/stripe/stripe.errors.js';
export * from './infrastructure/stripe/stripe.module.js';
export * from './infrastructure/stripe/stripe.service.js';
export type * from './infrastructure/stripe/stripe.types.js';
// Presentation: the gRPC server (billing-service)
export * from './presentation/grpc/billing-grpc.controller.js';
