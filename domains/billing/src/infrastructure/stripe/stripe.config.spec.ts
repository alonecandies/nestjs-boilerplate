import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_STRIPE_SECRET_KEY,
  PLACEHOLDER_STRIPE_WEBHOOK_SECRET,
  stripeConfig,
} from './stripe.config.js';

const PROD = { NODE_ENV: 'production' } as const;

/** The docker-compose fallbacks (docker-compose.yml x-env-stripe). */
const COMPOSE = {
  STRIPE_SECRET_KEY: 'sk_test_compose_local_not_for_production',
  STRIPE_WEBHOOK_SECRET: 'whsec_compose_local_not_for_production',
} as const;

const KNOWN_VALUE_MESSAGE = 'is a publicly known value';

/** Runs `fn` and returns the `EnvValidationError` it throws; anything else fails the test. */
const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('stripe namespace (owned by billing)', () => {
  it('works with an empty environment (dev placeholders)', () => {
    expect(stripeConfig.parse({})).toMatchObject({
      secretKey: 'sk_test_placeholder',
      maxNetworkRetries: 2,
    });
  });

  it('keeps its Nest config token', () => {
    expect(stripeConfig.KEY).toBe('CONFIGURATION(stripe)');
  });

  it('names the env var of an invalid value', () => {
    const error = errorOf(() => stripeConfig.parse({ STRIPE_WEBHOOK_SECRET: 'nope' }));
    expect(error.namespace).toBe('stripe');
    expect(error.message).toContain('Invalid environment for "stripe"');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });
});

describe('stripe production guards', () => {
  const REAL = {
    STRIPE_SECRET_KEY: 'sk_live_51HxRealKey',
    STRIPE_WEBHOOK_SECRET: 'whsec_1a2b3c4d5e6f7g8h9i0j',
    STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
    STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
  };

  it('rejects the development placeholders in production (forged webhooks would verify)', () => {
    const error = errorOf(() => stripeConfig.parse(PROD));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });

  it('rejects the compose fallbacks and the docs placeholders unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const compose = {
      ...PROD,
      ...REAL,
      STRIPE_SECRET_KEY: COMPOSE.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: COMPOSE.STRIPE_WEBHOOK_SECRET,
    };
    const error = errorOf(() => stripeConfig.parse(compose));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
    expect(error.message).toContain(KNOWN_VALUE_MESSAGE);
    expect(stripeConfig.parse({ ...compose, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).secretKey).toBe(
      COMPOSE.STRIPE_SECRET_KEY,
    );
    // Copied unfilled from .env.example / the production checklist.
    const unfilled = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_WEBHOOK_SECRET: 'whsec_...' }),
    );
    expect(unfilled.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });

  it('requires https, non-loopback Checkout redirect URLs in production', () => {
    const keys = {
      STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
    };
    const local = errorOf(() => stripeConfig.parse({ ...PROD, ...keys }));
    expect(local.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(local.message).toContain('→ at STRIPE_CANCEL_URL');
    expect(local.message).toContain('STRIPE_ALLOW_LOCAL_REDIRECTS');
    const plainHttp = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_SUCCESS_URL: 'http://app.example.com/ok' }),
    );
    expect(plainHttp.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(stripeConfig.parse({ ...PROD, ...REAL }).successUrl).toBe(REAL.STRIPE_SUCCESS_URL);
    expect(
      stripeConfig.parse({ ...PROD, ...keys, STRIPE_ALLOW_LOCAL_REDIRECTS: 'true' }).cancelUrl,
    ).toBe('http://localhost:3000/billing/cancel');
  });

  it('keeps the placeholders outside production', () => {
    expect(stripeConfig.parse({ NODE_ENV: 'test' }).secretKey).toBe(PLACEHOLDER_STRIPE_SECRET_KEY);
    expect(stripeConfig.parse({}).webhookSecret).toBe(PLACEHOLDER_STRIPE_WEBHOOK_SECRET);
  });
});
