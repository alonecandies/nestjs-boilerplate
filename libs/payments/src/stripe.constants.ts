import { Inject } from '@nestjs/common';

/** DI token of the shared `Stripe` client instance (one keep-alive HTTP agent per process). */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/** `@InjectStripe() private readonly stripe: Stripe` — escape hatch for API calls `StripeService` doesn't wrap. */
export const InjectStripe = (): PropertyDecorator & ParameterDecorator => Inject(STRIPE_CLIENT);

/**
 * Max age (seconds) of a webhook signature timestamp. Stripe's recommended default: rejects
 * replayed deliveries while tolerating normal clock skew and delivery latency.
 */
export const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;

/** Reported to Stripe with every request (visible in the dashboard's request logs). */
export const STRIPE_APP_INFO = { name: 'nestjs-boilerplate' } as const;
