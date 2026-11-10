import { BillingApiModule } from '../billing-api.module.js';
import { BillingCoreModule } from '../billing-core.module.js';
import * as root from '../index.js';
import * as api from './index.js';

const API_VALUES = [
  'BILLING_GRPC_UPSTREAM',
  'BILLING_LIMITS',
  'BILLING_LOG_REDACT_PATHS',
  'BillingApiModule',
  'BillingController',
  'BillingErrorCode',
  'BillingGrpcAdapter',
  'BillingLocalAdapter',
  'BillingPort',
  'BillingResolver',
  'CheckoutSessionModel',
  'IDEMPOTENCY_KEY_PATTERN',
  'PAYMENT_STATUSES',
  'PaymentConnectionModel',
  'PaymentModel',
  'PaymentStatus',
  'PaymentStatusGraphqlEnum',
  'STRIPE_SIGNATURE_HEADER',
  'billingGrpcClientConfig',
  'billingGrpcClientEnvSchema',
  'isPaymentStatus',
  'normalizePayment',
  'toPaymentConnectionModel',
  'toPaymentModel',
];

describe('@domain/billing entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports ./api and keeps core, persistence and Stripe', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of [
      'BillingCoreModule',
      'BillingGrpcModule',
      'billingSchema',
      'StripeService',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });

  it('forLocal() binds the port without importing BillingCoreModule (the app imports it)', () => {
    expect(BillingApiModule.forLocal().imports ?? []).not.toContain(BillingCoreModule);
  });
});
