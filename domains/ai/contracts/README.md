# @domain/ai-contracts

The published language of the ai context: what the gateway and ai-service need to talk to each other, without loading `@domain/ai` itself.

- **gRPC**: `ai.v1` (`AiService`). The proto lives in `src/proto/ai/v1/ai.proto`, the ts-proto NestJS output in `src/generated/**` (committed, never edited by hand), and `AI_GRPC_PACKAGE` is the `GrpcPackageSpec` that `@platform/transport` takes to serve or call it.
  - Unary: `CreateConversation`, `ListConversations`, `GetConversation`, `DeleteConversation`, `ListMessages`, `SendMessage`.
  - Server-streaming: `StreamMessage` sends one `started` event once the turn began (a refusal is a gRPC status before it), then `delta` events in order and one `done` with the stored reply and its usage. Cancelling the call aborts the model call in ai-service; the reply so far is stored as `incomplete`.
  - Every request carries the caller's tenant and user; ai-service checks both against the principal in the call metadata (`x-user-id`, `x-tenant-id`, `x-user-roles`).
  - A message's content travels as JSON (`content_json`: a string, or an array of parts).
  - Only the reads (`ListConversations`, `GetConversation`, `ListMessages`) are retried on `UNAVAILABLE`.

It is a leaf package: it depends on `@platform/contracts` and third-party packages only. `scripts/check-boundaries.mjs` enforces it. ai publishes no Kafka events.

## Usage

```ts
import { AI_GRPC_PACKAGE, type StreamMessageEvent } from '@domain/ai-contracts';

connectGrpcServer(app, [AI_GRPC_PACKAGE]); // ai-service's main.ts
GrpcClientsModule.register({ spec: AI_GRPC_PACKAGE, url }); // AiApiModule.forRemote()
```

Generated types are exported flat and as the namespace `aiV1`, the escape hatch for a later `v2` that reuses message names.

## Codegen

```bash
bun run --filter @domain/ai-contracts proto:lint   # buf lint with the shared policy (libs/contracts/buf.yaml)
bun run --filter @domain/ai-contracts proto:gen    # buf generate + the shared ESM fix (libs/contracts)
```

Breaking changes are checked against the base branch on every pull request
(`node scripts/check-proto-breaking.mjs --against <base sha>`, or `bun run proto:breaking`).
