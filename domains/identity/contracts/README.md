# @domain/identity-contracts

The published language of the identity context: everything another context, a service image or the gateway needs to talk to identity, without loading `@domain/identity` itself.

- **gRPC**: `identity.v1` (`AuthService` and `UsersService`). The proto lives in `src/proto/identity/v1/identity.proto`, the ts-proto NestJS output in `src/generated/**` (committed, never edited by hand), and `IDENTITY_GRPC_PACKAGE` is the `GrpcPackageSpec` that `@platform/transport` takes to serve or call it.
- **Kafka**: three tenant-scoped events, each with its zod payload schema (`userRegisteredPayload` / `UserRegisteredPayload` and so on). Identity produces them; the producer must set the envelope `tenantId`, and the record key is the user id.
  - `USER_REGISTERED_EVENT` (`identity.user-registered.v1`): an account was created; envelope tenant = its personal workspace. Notifications consumes it (welcome mail).
  - `MEMBERSHIP_CREATED_EVENT` (`identity.membership-created.v1`): a user became a member of the envelope's tenant (register, a login that creates a missing personal workspace, a new tenant, an accepted invitation).
  - `MEMBERSHIP_REMOVED_EVENT` (`identity.membership-removed.v1`): a membership ended (removed, or left).

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
await kafka.publish(USER_REGISTERED_EVENT, payload, { key: payload.userId, tenantId }); // the producer
// A consumer: @KafkaEventPattern(USER_REGISTERED_EVENT) + new ParseEventEnvelopePipe(USER_REGISTERED_EVENT)
```

Generated types are exported flat and as the namespace `identityV1`, the escape hatch for a later `v2` that reuses message names.

## Codegen

```bash
bun run --filter @domain/identity-contracts proto:lint   # buf lint with the shared policy (libs/contracts/buf.yaml)
bun run --filter @domain/identity-contracts proto:gen    # buf generate + the shared ESM fix (libs/contracts)
```

Breaking changes are checked against the base branch on every pull request (CI runs
`node scripts/check-proto-breaking.mjs --against <base sha>` for every contracts package). Run it
locally from the repo root before you push:

```bash
bun run proto:breaking   # buf breaking against origin/master (git fetch origin master first)
```
