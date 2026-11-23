import { describe, expect, it } from 'vitest';
import { billingGrpcClientConfig } from './billing-grpc-client.config.js';

describe('billingGrpcClientConfig (BILLING_GRPC_URL, read by BillingApiModule.forRemote())', () => {
  it("defaults to billing-service on its host-dev port and the monolith's handler budget for Stripe", () => {
    expect(billingGrpcClientConfig.parse({})).toEqual({
      url: 'localhost:50053',
      stripeDeadlineMs: 30_000,
    });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      billingGrpcClientConfig.parse({ BILLING_GRPC_URL: 'dns:///billing-service:50051' }).url,
    ).toBe('dns:///billing-service:50051');
    expect(billingGrpcClientConfig.parse({ BILLING_GRPC_URL: '  ' }).url).toBe('localhost:50053');
  });

  it('bounds the deadline of the Stripe-backed calls', () => {
    expect(
      billingGrpcClientConfig.parse({ BILLING_GRPC_STRIPE_DEADLINE_MS: '45000' }).stripeDeadlineMs,
    ).toBe(45_000);
    expect(() =>
      billingGrpcClientConfig.parse({ BILLING_GRPC_STRIPE_DEADLINE_MS: '999' }),
    ).toThrow();
    expect(() =>
      billingGrpcClientConfig.parse({ BILLING_GRPC_STRIPE_DEADLINE_MS: '900001' }),
    ).toThrow();
  });

  it('is its own namespace, owned by billing', () => {
    expect(billingGrpcClientConfig.KEY).toBe('CONFIGURATION(billingGrpcClient)');
  });
});
