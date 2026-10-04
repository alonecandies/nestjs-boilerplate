import { type StripeConfig, stripeConfig } from '@app/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Stripe from 'stripe';
import { STRIPE_APP_INFO, STRIPE_CLIENT } from './stripe.constants.js';
import { StripeService } from './stripe.service.js';

/**
 * Builds the process-wide Stripe client. `apiVersion` is deliberately omitted: Stripe 22 types it
 * as the SDK's pinned literal, so the API version moves with SDK upgrades (pin the webhook
 * endpoint to the same version in the dashboard). The SDK already uses a keep-alive agent and
 * retries 409/429/5xx/network errors with backoff, adding idempotency keys to retried POSTs.
 */
export function createStripeClient(cfg: StripeConfig): Stripe {
  return new Stripe(cfg.secretKey, {
    maxNetworkRetries: cfg.maxNetworkRetries,
    timeout: cfg.timeoutMs,
    telemetry: false,
    appInfo: STRIPE_APP_INFO,
  });
}

/**
 * Global Stripe integration: `STRIPE_CLIENT` (raw SDK, `@InjectStripe()`) + `StripeService`.
 * Import once in the process that talks to Stripe (billing-service / monolith).
 */
@Module({})
export class StripeModule {
  static forRootAsync(): DynamicModule {
    return {
      module: StripeModule,
      global: true,
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
  }
}
