import { stripeConfig } from '@app/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CreateCheckoutSessionHandler } from './application/commands/create-checkout-session/create-checkout-session.handler.js';
import { HandleStripeWebhookHandler } from './application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { ListPaymentsHandler } from './application/queries/list-payments/list-payments.handler.js';
import { PaymentSucceededRelay } from './application/relays/payment-succeeded.relay.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { StripeEventsRepository } from './application/repositories/stripe-events.repository.js';
import { DrizzlePaymentsRepository } from './infrastructure/persistence/drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './infrastructure/persistence/drizzle-stripe-events.repository.js';

/**
 * The billing core: CQRS handlers, the Kafka relay and the Drizzle repositories. Imported by the
 * process that owns the billing tables (billing-service via `BillingGrpcModule`, monolith via
 * `BillingApiModule.forLocal()`).
 *
 * Expects these global app-level modules: `AppConfigModule`, `CqrsModule.forRoot()`,
 * `DatabaseModule.forRootAsync({ schema: billingSchema })` (DRIZZLE + `@Transactional()`),
 * `StripeModule.forRootAsync()` and `KafkaProducerModule.forRootAsync()`.
 */
@Module({
  imports: [ConfigModule.forFeature(stripeConfig)],
  providers: [
    CreateCheckoutSessionHandler,
    HandleStripeWebhookHandler,
    ListPaymentsHandler,
    PaymentSucceededRelay,
    { provide: PaymentsRepository, useClass: DrizzlePaymentsRepository },
    { provide: StripeEventsRepository, useClass: DrizzleStripeEventsRepository },
  ],
})
export class BillingCoreModule {}
