import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { makeCounterProvider } from '@platform/observability';
import { CreateCheckoutSessionHandler } from './application/commands/create-checkout-session/create-checkout-session.handler.js';
import { HandleStripeWebhookHandler } from './application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { PurgeStripeEventsHandler } from './application/commands/purge-stripe-events/purge-stripe-events.handler.js';
import { ListPaymentsHandler } from './application/queries/list-payments/list-payments.handler.js';
import { PaymentSucceededRelay } from './application/relays/payment-succeeded.relay.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { StripeEventsRepository } from './application/repositories/stripe-events.repository.js';
import { PAID_WITHOUT_CURRENCY_METRIC } from './billing.constants.js';
import { DrizzlePaymentsRepository } from './infrastructure/persistence/drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './infrastructure/persistence/drizzle-stripe-events.repository.js';
import { PurgeStripeEventsCron } from './infrastructure/scheduling/purge-stripe-events.cron.js';
import { stripeConfig } from './infrastructure/stripe/stripe.config.js';
import { StripeModule } from './infrastructure/stripe/stripe.module.js';

/**
 * The billing core: CQRS handlers, the Kafka relay and the Drizzle repositories. Imported by the
 * process that owns the billing tables (billing-service via `BillingGrpcModule`, monolith via
 * `BillingApiModule.forLocal()`).
 *
 * Expects these global app-level modules: `AppConfigModule`, `CqrsModule.forRoot()`,
 * `DatabaseModule.forRootAsync({ schema: billingSchema, migrations: [billingMigrations] })`
 * (DRIZZLE + `@Transactional()`), `KafkaProducerModule.forRootAsync()`,
 * `RedisModule.forRootAsync()` (the purge cron's distributed lock) and — for the cron to be
 * scheduled — `ScheduleModule.forRoot()`. It imports its own Stripe adapter
 * (`StripeModule.forRootAsync()`), so no app imports Stripe.
 */
@Module({
  imports: [ConfigModule.forFeature(stripeConfig), StripeModule.forRootAsync()],
  providers: [
    CreateCheckoutSessionHandler,
    HandleStripeWebhookHandler,
    ListPaymentsHandler,
    PaymentSucceededRelay,
    PurgeStripeEventsHandler,
    PurgeStripeEventsCron,
    // Registered in prom-client's default registry; works with or without the /metrics module.
    makeCounterProvider({
      name: PAID_WITHOUT_CURRENCY_METRIC,
      help: 'Paid Stripe Checkout Sessions left pending because no currency was known (no receipt sent)',
    }),
    { provide: PaymentsRepository, useClass: DrizzlePaymentsRepository },
    { provide: StripeEventsRepository, useClass: DrizzleStripeEventsRepository },
  ],
})
export class BillingCoreModule {}
