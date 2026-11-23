# ai-service

The ai bounded context as a standalone microservice: the caller's conversations, their messages and
usage log in Postgres (under row-local RLS), and the chat turn over `@platform/ai` (OpenRouter),
plain or server-streamed. It serves **gRPC only**; the gateway exposes `/v1/ai/conversations`
(REST and SSE) and the GraphQL mirror through `AiApiModule.forRemote()`, and charges `ai:chat` and
the `ai.chat` rate limit at the edge.

| Surface | Port (default)             | What                                                                       |
| ------- | -------------------------- | -------------------------------------------------------------------------- |
| gRPC    | `GRPC_URL` `0.0.0.0:50054` | `ai.v1.AiService`, health, reflection                                      |
| HTTP    | `PORT` `3004`              | `GET /health/live`, `GET /health/ready` only                               |
| Metrics | `METRICS_PORT` `9468`      | `GET /metrics` on its own listener (`9464` in containers; never published) |
| gRPC    | client                     | identity-, notifications- and billing-service, for the model's tools       |

No Kafka and no Redis. The domain logic lives in [`@domain/ai`](../../domains/ai); this app is only
the composition root.

## Composition (`src/app.module.ts`)

| Module                                                                               | Why                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppConfigModule.forRoot()` + `ConfigModule.forFeature(grpcConfig)`                  | `app`/`observability`/`ai` + the gRPC bind namespace, validated at boot                                                                                                |
| `ObservabilityModule.forRoot({ healthContributors: [postgres] })`                    | pino JSON logs, `/metrics`, `/health/*`; OpenRouter is not a readiness dependency                                                                                      |
| `CqrsModule.forRoot()`, `RbacModule.forRoot()`                                       | the buses behind `AiPort`; permissions recomputed from the roles in the call metadata                                                                                  |
| `DatabaseModule.forRootAsync({ schema: aiSchema, migrations: DATABASE_MIGRATIONS })` | Drizzle + postgres.js pool, the units of work (transactional CLS plugin), the platform set then `ai`                                                                   |
| `AiGrpcModule`                                                                       | `AiCoreModule` (handlers, repositories, `AiModule`) + `AiGrpcController` over `AiPort` → the CQRS buses                                                                |
| `AiToolSourcesModule.forRoot()` (`src/tools/`)                                       | `AiToolSources` (`OwnerPortsAiToolSources`, from `@domain/ai`) over `UsersPort`, `NotificationsPort`, `BillingPort` bound to their gRPC adapters; `NOTIFICATIONS_RBAC` |
| `provideCommonEnhancersAsync(...)`, `CorrelationIdMiddleware`                        | problem+json on the ops port; with `inheritAppConfig` the enhancers wrap gRPC too                                                                                      |

`main.ts`: `createServiceApp(AppModule)` → `connectGrpcServer(app, [AI_GRPC_PACKAGE])` →
`startAllMicroservices()` → `listenMetrics(app)` → `listen(app)`.

| RPC                                                    | Dispatches                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `CreateConversation`, `DeleteConversation`             | `CreateConversationCommand`, `DeleteConversationCommand`                                            |
| `ListConversations`, `GetConversation`, `ListMessages` | the matching queries (keyset pages, newest first)                                                   |
| `SendMessage`                                          | `SendMessageCommand` (history window, `Idempotency-Key` replay or 409, usage row)                   |
| `StreamMessage` (server streaming)                     | `StreamMessageCommand`: `started`, then `delta`s and `done`; a cancelled call aborts the model call |

Every request carries the caller's tenant and user; the handlers check both against the principal
that `@GrpcController()` adopted from the metadata (`TENANT_MISMATCH`, `PRINCIPAL_MISSING`), and
the repositories run under RLS as that caller. The chat codes travel as `x-error-code` trailers
(`AI_DISABLED` 503, `AI_MODEL_NOT_ALLOWED` / `AI_INPUT_TOO_LARGE` 422, `AI_TIMEOUT` 504,
`AI_UPSTREAM_ERROR` 502, `CONVERSATION_NOT_FOUND` 404, `IDEMPOTENCY_KEY_REUSED` 409), so the gateway
answers exactly like the monolith.

**Streaming and cancellation.** `StreamMessage` answers a refusal as the call's status, before any
event, and otherwise sends `started`, the text deltas and one `done` (the stored reply and its
usage). When the client goes away (the gateway's SSE connection closed) or the call's deadline
passes, grpc-js cancels the call; the controller's teardown aborts the turn's signal, the model call
stops, and the reply so far is stored once as `incomplete` with an `aborted` usage row.

**Tools.** The model's read-only tools (`get_my_profile`, `list_my_notifications`,
`list_my_payments`) call identity-, notifications- and billing-service over gRPC within the turn's
CLS context, so the caller's principal travels on and each owner applies its own checks. Channels
connect on the first tool call; an unreachable owner is a tool error returned to the model, never a
failed turn.

## Configuration

`.env.example` holds only what differs per service; `bun run setup:env` copies it to `.env`.
Everything else comes from the root `.env` / the environment ([`@platform/config`](../../libs/config)):

| Variable                                                            | Value here               | Notes                                                                 |
| ------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `SERVICE_NAME`                                                      | `ai-service`             | log `service`, OTel `service.name`                                    |
| `PORT` / `GRPC_URL`                                                 | `3004` / `0.0.0.0:50054` | the gateway dials `AI_GRPC_URL`                                       |
| `METRICS_PORT`                                                      | `9468`                   | `/metrics` listener                                                   |
| `DATABASE_RUN_MIGRATIONS`                                           | `true`                   | the platform set + `ai`, as `app_owner` over `DATABASE_MIGRATION_URL` |
| `IDENTITY_GRPC_URL` / `NOTIFICATIONS_GRPC_URL` / `BILLING_GRPC_URL` | `localhost:5005x`        | the tools' upstreams                                                  |
| `AI_ENABLED`, `OPENROUTER_API_KEY`, `AI_*` (root `.env`)            | off                      | `AI_ENABLED=false`: every turn answers 503 `AI_DISABLED`              |

## Run

```bash
bun run dev:ai              # this service in watch mode (Postgres from `docker compose up -d --wait`)
bun run dev:microservices   # gateway + identity + notifications + billing + ai
bun run --filter @app/ai-service db:migrate:dev   # the platform set + ai, then exit
```

## Tests

| Spec                              | What                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `test/app.e2e-spec.ts`            | the real `AppModule` over real loopback gRPC: unary RPCs, caller checks, streaming, cancellation, tools |
| `test/env-example.spec.ts`        | `.env.example` passes every namespace and pins the ports                                                |
| `src/database.migrations.spec.ts` | owns the `ai` schema only                                                                               |

The gRPC round trip of the contract (gateway adapter ↔ controller) is
`domains/ai/src/presentation/grpc/ai-grpc.roundtrip.spec.ts`; the gateway's REST and SSE over a
stand-in ai-service are `apps/gateway/test/ai.e2e-spec.ts`.
