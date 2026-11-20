import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Stripe from 'stripe';
import { type StripeConfig, stripeConfig } from './stripe.config.js';
import { STRIPE_API_VERSION, STRIPE_APP_INFO, STRIPE_CLIENT } from './stripe.constants.js';
import { StripeService } from './stripe.service.js';

/**
 * Builds the process-wide Stripe client. `apiVersion` is pinned to `STRIPE_API_VERSION` (the
 * SDK's literal); pin the webhook endpoint to the same version in the dashboard. The SDK already uses a keep-alive agent and
 * retries 409/429/5xx/network errors with backoff, adding idempotency keys to retried POSTs.
 */
export function createStripeClient(cfg: StripeConfig): Stripe {
  return new Stripe(cfg.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: cfg.maxNetworkRetries,
    timeout: cfg.timeoutMs,
    telemetry: false,
    appInfo: STRIPE_APP_INFO,
  });
}

/**
 * Billing's Stripe adapter: `STRIPE_CLIENT` (raw SDK, `@InjectStripe()`) + `StripeService`.
 * Imported by `BillingCoreModule` and `BillingLedgerModule` (their handlers and R4 are the
 * consumers), so no app imports it and it is not global. `forRootAsync()` returns one module
 * object: Nest keys dynamic modules by reference, so both importers share one client.
 */
@Module({})
export class StripeModule {
  private static root: DynamicModule | undefined;

  static forRootAsync(): DynamicModule {
    StripeModule.root ??= {
      module: StripeModule,
      imports: [ConfigModule.forFeature(stripeConfig)],
      providers: [
        {
          provide: STRIPE_CLIENT,
          inject: [stripeConfig.KEY],
          useFactory: createStripeClient,
        },
        StripeService,
      ],
      exports: [STRIPE_CLIENT, StripeService],
    };
    return StripeModule.root;
  }
}
