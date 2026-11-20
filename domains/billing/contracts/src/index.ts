/**
 * @domain/billing-contracts — the published language of the billing context: the billing.v1
 * gRPC contract (ts-proto NestJS output + `BILLING_GRPC_PACKAGE`), the payment-succeeded event
 * (`PAYMENT_SUCCEEDED_EVENT`) and the ledger-posting event (`LEDGER_POSTING_REQUESTED_EVENT`,
 * billing's own). Other domains and the apps depend on this package to talk to billing; only the
 * composition roots import @domain/billing itself.
 *
 * - Generated types are re-exported flat (`Payment`, `PaymentList`, …) and as the
 *   version-qualified namespace `billingV1`, the escape hatch for a later `v2`.
 * - Loading this barrel evaluates the generated module, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/billing.grpc-package.ts).
 */
export * from './events/billing.events.js';
export * from './generated/billing/v1/billing.pb.js';
export * as billingV1 from './generated/billing/v1/billing.pb.js';
export * from './grpc/billing.grpc-package.js';
