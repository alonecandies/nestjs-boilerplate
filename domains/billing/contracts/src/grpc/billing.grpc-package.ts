import { join } from 'node:path';
import type { GrpcPackageSpec } from '@platform/contracts';
// Value import on purpose: registers the Timestamp <-> Date wrapper (see identity.grpc-package.ts).
import { BILLING_SERVICE_NAME } from '../generated/billing/v1/billing.pb.js';

/** `billing.v1`: BillingService (Stripe Checkout sessions, webhook, payment history). */
export const BILLING_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'billing.v1',
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['billing/v1/billing.proto'],
  services: [BILLING_SERVICE_NAME],
  clientToken: 'BILLING_GRPC_CLIENT',
  idempotentMethods: { [BILLING_SERVICE_NAME]: ['ListPayments'] },
};
