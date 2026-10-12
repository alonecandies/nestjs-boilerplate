# @domain/identity-contracts

The published language of the identity context: everything another context, a service image or the gateway needs to talk to identity, without loading `@domain/identity` itself.

- **gRPC**: `identity.v1` (`AuthService` and `UsersService`). The proto lives in `src/proto/identity/v1/identity.proto`, the ts-proto NestJS output in `src/generated/**` (committed, never edited by hand), and `IDENTITY_GRPC_PACKAGE` is the `GrpcPackageSpec` that `@platform/transport` takes to serve or call it.
- **Kafka**: `USER_REGISTERED_EVENT` (`identity.user-registered.v1`) with its zod payload schema `userRegisteredPayload` / `UserRegisteredPayload`. Identity produces it; notifications consumes it (welcome mail).

It is a leaf package: it depends on `@platform/contracts` and third-party packages only, and other domains import identity only through it. `scripts/check-boundaries.mjs` enforces both rules.

## Usage

```ts
import {
  USER_REGISTERED_EVENT,
  IDENTITY_GRPC_PACKAGE,
  type User,
} from '@domain/identity-contracts';

connectGrpcServer(app, [IDENTITY_GRPC_PACKAGE]); // the service's main.ts
GrpcClientsModule.register({ spec: IDENTITY_GRPC_PACKAGE, url }); // an edge module's forRemote()
await kafka.publish(USER_REGISTERED_EVENT, payload, { key: payload.userId }); // the producer
// A consumer: @KafkaEventPattern(USER_REGISTERED_EVENT) + new ParseEventEnvelopePipe(USER_REGISTERED_EVENT)
```

Generated types are exported flat and as the namespace `identityV1`, the escape hatch for a later `v2` that reuses message names.

## Codegen

```bash
bun run --filter @domain/identity-contracts proto:lint   # buf lint with the shared policy (libs/contracts/buf.yaml)
bun run --filter @domain/identity-contracts proto:gen    # buf generate + the shared ESM fix (libs/contracts)
```

Check a proto change for breaking changes from this folder before releasing it:

```bash
buf breaking --config ../../../libs/contracts/buf.yaml \
  --against '../../../.git#branch=master,subdir=domains/identity/contracts/src/proto'
```

The first comparison after the move to this package must point at the old root instead (`subdir=libs/contracts/src/proto`); it also reports the other contexts' files as deleted, which is expected.
