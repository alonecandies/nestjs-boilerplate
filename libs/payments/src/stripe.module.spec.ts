import { AppConfigModule } from '@app/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_CLIENT } from './stripe.constants.js';
import { StripeModule } from './stripe.module.js';
import { StripeService } from './stripe.service.js';

@Module({ imports: [AppConfigModule.forRoot(), StripeModule.forRootAsync()] })
class TestAppModule {}

describe('StripeModule', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires one Stripe client from the validated stripe namespace', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_module');
    vi.stubEnv('STRIPE_MAX_NETWORK_RETRIES', '4');
    const app = await NestFactory.createApplicationContext(TestAppModule, { logger: false });
    try {
      const client = app.get<Stripe>(STRIPE_CLIENT);
      const service = app.get(StripeService);

      expect(client).toBeInstanceOf(Stripe);
      expect(service.client).toBe(client);
      expect(client.getMaxNetworkRetries()).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('fails fast on an invalid secret key', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'pk_live_publishable_key');

    await expect(
      NestFactory.createApplicationContext(TestAppModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
