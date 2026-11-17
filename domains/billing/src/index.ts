/**
 * @domain/billing — the billing bounded context: Stripe Checkout sessions (idempotent), signed and
 * exactly-once Stripe webhooks, the payments ledger (Drizzle) and the
 * `billing.payment-succeeded.v1` integration event.
 *
 * Entry points: `@domain/billing/api` (edge surface, re-exported here) and this root entry (adds
 * core, persistence, the Stripe adapter, commands, queries and domain types).
 * Wiring: `BillingCoreModule` (handlers, repositories, outbox and its relay, cron) +
 * `BillingGrpcModule` (billing-service), `BillingCoreModule` +
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
// The system port (app e2e harnesses override it with `@domain/billing/testing`'s in-memory one).
export type { StripeEventReceipt } from './application/repositories/stripe-events.repository.js';
export { StripeEventsSystemRepository } from './application/repositories/stripe-events.system-repository.js';
// Modules and core constants
export {
  PAID_WITHOUT_AMOUNT_METRIC,
  PAID_WITHOUT_CURRENCY_METRIC,
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
  outbox,
  type PaymentRow,
  paymentStatusEnum,
  payments,
  type StripeEventRow,
  stripeEvents,
} from './infrastructure/persistence/billing.schema.js';
export { BILLING_SYSTEM_METHODS } from './infrastructure/persistence/billing.system-methods.js';
// Billing's outbox (G-1): the writer token, the feature and the system repository (the e2e apps
// bind `@domain/billing/testing`'s createInMemoryBillingOutbox() in their place).
export { BILLING_OUTBOX, BillingOutbox } from './infrastructure/persistence/billing-outbox.js';
export { BillingOutboxSystemRepository } from './infrastructure/persistence/drizzle-outbox.system-repository.js';
// Stripe adapter (imported by BillingCoreModule; public for custom wiring / tests)
export * from './infrastructure/stripe/stripe.config.js';
export * from './infrastructure/stripe/stripe.constants.js';
export * from './infrastructure/stripe/stripe.errors.js';
export * from './infrastructure/stripe/stripe.module.js';
export * from './infrastructure/stripe/stripe.service.js';
export type * from './infrastructure/stripe/stripe.types.js';
// Presentation: the gRPC server (billing-service)
export * from './presentation/grpc/billing-grpc.controller.js';
