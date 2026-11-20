import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { makeCounterProvider } from '@platform/observability';
import { OutboxModule } from '@platform/outbox';
import { CreateCheckoutSessionHandler } from './application/commands/create-checkout-session/create-checkout-session.handler.js';
import { HandleStripeWebhookHandler } from './application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { PurgeStripeEventsHandler } from './application/commands/purge-stripe-events/purge-stripe-events.handler.js';
import { StripeOwnerResolver } from './application/ledger/stripe-owner-resolver.js';
import { ListPaymentsHandler } from './application/queries/list-payments/list-payments.handler.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { StripeEventsRepository } from './application/repositories/stripe-events.repository.js';
import { StripeEventsSystemRepository } from './application/repositories/stripe-events.system-repository.js';
import {
  AMOUNT_MISMATCH_METRIC,
  API_VERSION_MISMATCH_METRIC,
  CHECKOUT_WITHOUT_IDEMPOTENCY_KEY_METRIC,
  PAID_WITHOUT_AMOUNT_METRIC,
  PAID_WITHOUT_CURRENCY_METRIC,
} from './billing.constants.js';
import { ledgerConfig } from './infrastructure/ledger/ledger.config.js';
import { BILLING_OUTBOX, BillingOutbox } from './infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from './infrastructure/persistence/drizzle-outbox.system-repository.js';
import { DrizzlePaymentsRepository } from './infrastructure/persistence/drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './infrastructure/persistence/drizzle-stripe-events.repository.js';
import { DrizzleStripeEventsSystemRepository } from './infrastructure/persistence/drizzle-stripe-events.system-repository.js';
import { PurgeStripeEventsCron } from './infrastructure/scheduling/purge-stripe-events.cron.js';
import { stripeConfig } from './infrastructure/stripe/stripe.config.js';
import { StripeModule } from './infrastructure/stripe/stripe.module.js';

/**
 * The billing core: CQRS handlers, the Drizzle repositories and billing's outbox
 * (`OutboxModule.forFeature`: the `BillingOutbox` writer the webhook enqueues
 * `billing.payment-succeeded.v1` and, while LEDGER_ENABLED, `billing.ledger-posting.v1` with, in
 * its unit of work, and the relay that publishes `billing.outbox` to Kafka; `outbox` and `ledger`
 * namespaces). Imported by the process that owns the billing
 * tables (billing-service via `BillingGrpcModule`; the monolith imports it directly, next to
 * `BillingApiModule.forLocal()`).
 *
 * Expects these global app-level modules: `AppConfigModule`, `CqrsModule.forRoot()`,
 * `DatabaseModule.forRootAsync({ schema: billingSchema, migrations: [billingMigrations] })`
 * (DRIZZLE + `@Transactional()`, and the system pool: the purge, platform webhooks and the outbox
 * relay need DATABASE_SYSTEM_URL), `KafkaProducerModule.forRootAsync()`,
 * `RedisModule.forRootAsync()` (the purge cron's and the relay's distributed locks) and — for the
 * cron to be scheduled — `ScheduleModule.forRoot()`. It imports its own Stripe adapter
 * (`StripeModule.forRootAsync()`), so no app imports Stripe.
 */
@Module({
  imports: [
    ConfigModule.forFeature(stripeConfig),
    // LEDGER_ENABLED gates the webhook's billing.ledger-posting.v1 rows (outbox plan Task 12).
    ConfigModule.forFeature(ledgerConfig),
    StripeModule.forRootAsync(),
    OutboxModule.forFeature({
      feature: BILLING_OUTBOX,
      writer: BillingOutbox,
      systemRepository: BillingOutboxSystemRepository,
    }),
  ],
  providers: [
    CreateCheckoutSessionHandler,
    HandleStripeWebhookHandler,
    // The owner of a Stripe money object: its metadata, else its PaymentIntent's (one GET).
    StripeOwnerResolver,
    ListPaymentsHandler,
    PurgeStripeEventsHandler,
    PurgeStripeEventsCron,
    // Registered in prom-client's default registry; works with or without the /metrics module.
    makeCounterProvider({
      name: PAID_WITHOUT_CURRENCY_METRIC,
      help: 'Paid Stripe Checkout Sessions left pending because no currency was known (no receipt sent)',
    }),
    makeCounterProvider({
      name: PAID_WITHOUT_AMOUNT_METRIC,
      help: 'Paid Stripe Checkout Sessions left pending because no amount was known (no receipt sent)',
    }),
    makeCounterProvider({
      name: AMOUNT_MISMATCH_METRIC,
      help: 'Paid Stripe Checkout Sessions whose charged amount or currency differs from the quote',
    }),
    makeCounterProvider({
      name: API_VERSION_MISMATCH_METRIC,
      help: 'Stripe webhook events whose api_version differs from the pinned STRIPE_API_VERSION',
    }),
    makeCounterProvider({
      name: CHECKOUT_WITHOUT_IDEMPOTENCY_KEY_METRIC,
      help: 'Checkout requests that sent no Idempotency-Key',
    }),
    { provide: PaymentsRepository, useClass: DrizzlePaymentsRepository },
    { provide: StripeEventsRepository, useClass: DrizzleStripeEventsRepository },
    // The core's door to the app_system pool besides the outbox's (BILLING_SYSTEM_METHODS); the
    // ledger's repositories belong to BillingLedgerModule, their only consumer.
    { provide: StripeEventsSystemRepository, useClass: DrizzleStripeEventsSystemRepository },
  ],
})
export class BillingCoreModule {}
