# @domain/billing-contracts

The published language of the billing context: everything another context, a service image or the gateway needs to talk to billing, without loading `@domain/billing` itself.

- **gRPC**: `billing.v1` (`BillingService`). The proto lives in `src/proto/billing/v1/billing.proto`, the ts-proto NestJS output in `src/generated/**` (committed, never edited by hand), and `BILLING_GRPC_PACKAGE` is the `GrpcPackageSpec` that `@platform/transport` takes to serve or call it.
- **Kafka**: `PAYMENT_SUCCEEDED_EVENT` (`billing.payment-succeeded.v1`) with its zod payload schema `paymentSucceededPayload` / `PaymentSucceededPayload`. Billing produces it; notifications consumes it (payment receipt).

It is a leaf package: it depends on `@platform/contracts` and third-party packages only, and other domains import billing only through it. `scripts/check-boundaries.mjs` enforces both rules.

## Usage

```ts
import {
  PAYMENT_SUCCEEDED_EVENT,
  BILLING_GRPC_PACKAGE,
  type Payment,
} from '@domain/billing-contracts';

connectGrpcServer(app, [BILLING_GRPC_PACKAGE]); // the service's main.ts
GrpcClientsModule.register({ spec: BILLING_GRPC_PACKAGE, url }); // an edge module's forRemote()
await kafka.publish(PAYMENT_SUCCEEDED_EVENT, payload, { key: payload.userId }); // the producer
// A consumer: @KafkaEventPattern(PAYMENT_SUCCEEDED_EVENT) + new ParseEventEnvelopePipe(PAYMENT_SUCCEEDED_EVENT)
```

Generated types are exported flat and as the namespace `billingV1`, the escape hatch for a later `v2` that reuses message names.

## Codegen

```bash
bun run --filter @domain/billing-contracts proto:lint   # buf lint with the shared policy (libs/contracts/buf.yaml)
bun run --filter @domain/billing-contracts proto:gen    # buf generate + the shared ESM fix (libs/contracts)
```

Check a proto change for breaking changes from this folder before releasing it:

```bash
buf breaking --config ../../../libs/contracts/buf.yaml \
  --against '../../../.git#branch=master,subdir=domains/billing/contracts/src/proto'
```

The first comparison after the move to this package must point at the old root instead (`subdir=libs/contracts/src/proto`); it also reports the other contexts' files as deleted, which is expected.
