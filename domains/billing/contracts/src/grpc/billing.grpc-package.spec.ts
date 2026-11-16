import { join } from 'node:path';
import {
  boundRpcPatterns,
  loadGrpcPackages,
  protoFilesUnder,
  wireRoundTrip,
} from '@platform/contracts/testing';
import { describe, expect, it } from 'vitest';
import {
  BILLING_GRPC_PACKAGE,
  BillingServiceControllerMethods,
  type HandleStripeWebhookRequest,
  type Payment,
} from '../index.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const root = loadGrpcPackages([BILLING_GRPC_PACKAGE]);

describe('BILLING_GRPC_PACKAGE', () => {
  it('resolves its protos under <package>/src/proto and registers every billing proto', () => {
    expect(BILLING_GRPC_PACKAGE.protoDir).toBe(join(PACKAGE_ROOT, 'src', 'proto'));
    const own = protoFilesUnder(BILLING_GRPC_PACKAGE.protoDir).filter((file) =>
      file.startsWith('billing/'),
    );
    expect(own).toEqual([...BILLING_GRPC_PACKAGE.protoPath].sort());
  });

  it('declares the protobuf package and service the proto defines', () => {
    expect(root.lookup('billing.v1')).toBeDefined();
    expect(BILLING_GRPC_PACKAGE.services).toEqual(['BillingService']);
    expect(root.lookupService('billing.v1.BillingService').name).toBe('BillingService');
  });

  it('retries only ListPayments, never checkout or the webhook', () => {
    const billing = root.lookupService('billing.v1.BillingService');
    expect(BILLING_GRPC_PACKAGE.idempotentMethods).toEqual({ BillingService: ['ListPayments'] });
    expect(billing.methods['ListPayments']).toBeDefined();
  });

  it('generated BillingService decorator binds every rpc of the proto', () => {
    const service = root.lookupService('billing.v1.BillingService');
    expect(boundRpcPatterns(BillingServiceControllerMethods, service)).toEqual(
      service.methodsArray.map((method) => [
        {
          service: 'BillingService',
          rpc: method.name.charAt(0).toLowerCase() + method.name.slice(1),
          streaming: 'no_stream',
        },
      ]),
    );
  });
});

describe('billing.v1 wire format (proto-loader semantics + generated types)', () => {
  it('keeps int64 exact as decimal strings beyond 2^53', () => {
    const payment: Payment = {
      id: 'p1',
      tenantId: 't1',
      userId: 'u1',
      status: 'succeeded',
      amountTotal: '9007199254740993',
      currency: 'usd',
      priceId: 'price_1',
      quantity: 2,
      stripeCheckoutSessionId: 'cs_test_1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const decoded = wireRoundTrip(root, 'billing.v1.Payment', payment) as unknown as Payment;
    expect(decoded.amountTotal).toBe('9007199254740993');
    expect(decoded.createdAt).toBeInstanceOf(Date);
  });

  it('round-trips bytes as a Buffer', () => {
    const webhook: HandleStripeWebhookRequest = {
      payload: Buffer.from('{"id":"evt_1"}'),
      signature: 't=1,v1=abc',
    };
    const decoded = wireRoundTrip(root, 'billing.v1.HandleStripeWebhookRequest', webhook);
    expect(Buffer.isBuffer(decoded['payload'])).toBe(true);
    expect((decoded['payload'] as Buffer).toString('utf8')).toBe('{"id":"evt_1"}');
  });
});
