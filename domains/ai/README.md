# @domain/ai

The AI bounded context: per-tenant conversations, their messages and a usage log, on Postgres
(Drizzle), distributed by tenant on Citus and under row-local RLS. Model calls go through
[`@platform/ai`](../../libs/ai/README.md) (OpenRouter on the Vercel AI SDK).

This package holds the persistence (schema, `0000_init`, repositories, in-memory twins) and the
chat API: CQRS handlers, the REST controller (plain and Server-Sent Events streaming), the GraphQL
resolver (queries, mutations and the `aiMessageStream` subscription), the `ai:chat` permission and
the `ai.chat` rate-limit policy, and the model's read-only tools; and its gRPC surface
(`ai.v1.AiService`, [`@domain/ai-contracts`](contracts/README.md)) for the microservices topology:
`AiGrpcModule` in [ai-service](../../apps/ai-service/README.md), `AiApiModule.forRemote()` in the
gateway.

## Entry points

| Entry                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@domain/ai`         | Everything below: `AiCoreModule`, `AiGrpcModule` (the core + `ai.v1.AiService`, for ai-service), the repository ports, `aiSchema`, `aiMigrations` and the Drizzle repositories, plus `./api`.                                                                                                                                                                                                                                                                               |
| `@domain/ai/api`     | The edge surface: `AiApiModule` (`forLocal()`, `forRemote()` with `AiGrpcAdapter`, `aiGrpcClientConfig`, `AI_GRPC_UPSTREAM`), `AiPort` and its request/result/stream shapes, the stream wire names (`AI_SSE_EVENTS`, `SSE_CONTENT_TYPE`, `aiMessageStreamTrigger`, `AiMessageStreamPush`), `AI_RBAC` / `AiPermission`, `aiRateLimitConfig` / `AI_RATE_LIMITS`, `AiChatErrorCode`, `AI_LIMITS`, the record types and their value lists. No persistence is reachable from it. |
| `@domain/ai/testing` | `createInMemoryAiPersistence()` (the three twins over one store), `FakeAiToolSources` (the tools' reads in memory, with the owners' checks), `FakeAiPort` + `startFakeAiService(url, port)` (a stand-in ai-service: the real `AiGrpcController` on loopback) and the fixtures `makeConversation`, `makeMessage`, `makeUsage`. Specs and `test/` code only.                                                                                                                  |

Wiring (when an app owns the ai tables, the monolith now): `aiSchema` and `aiMigrations` go into
`DatabaseModule.forRootAsync({ schema, migrations })` and the app's `migrate.ts`; the app imports
`AiCoreModule` (the handlers, the Drizzle repositories bound to their ports, and
`AiModule.forRootAsync()`) and then `AiApiModule.forLocal()` (REST, GraphQL resolver, RBAC feature,
rate-limit policy, `AiPort` on the CQRS buses). The resolver expects the app's `AppGraphqlModule`
and `GraphqlPubSubModule`. For the tools the app binds `AiToolSources` globally to the owners'
ports (the monolith's `AiToolSourcesModule`, below); without it no tools are offered.

## Microservices topology (`ai.v1`)

- **ai-service** imports `AiGrpcModule`: `AiGrpcController` (`presentation/grpc`) serves
  `ai.v1.AiService` over `AiPort`, bound there to the CQRS buses. Payloads are zod-validated
  (`ai-grpc.schemas.ts`, the REST bounds); `@GrpcController()` adopts the caller's principal from
  the metadata and the handlers re-check tenant and user against it. Records cross as contract
  messages (`application/mappers/ai-contract.mapper.ts`: content as JSON, Dates, absent optionals).
- **The gateway** imports `AiApiModule.forRemote()`: the same controller and resolver, `AiPort` bound
  to `AiGrpcAdapter` (`AI_GRPC_URL`, deadline `GRPC_DEADLINE_MS`, or `AI_GRPC_CHAT_DEADLINE_MS` for
  `SendMessage` / `StreamMessage`, also the channel's service-config deadline; the `ai` circuit
  breaker, which does not count ai-service's own answers such as `AI_DISABLED` or `AI_TIMEOUT`).
  RBAC (`ai:chat`) and the `ai.chat` charge stay at the edge.
- **Streaming.** `StreamMessage` is server-streaming: `started` once the turn began (a refusal is the
  call's status, so `streamMessage` rejects before any event, as locally), then `delta`s and one
  `done`. The adapter resolves on `started` and yields the rest. Aborting the request's signal (the
  SSE client left) or a consumer that stops reading unsubscribes, which cancels the call; ai-service's
  controller then aborts the turn's signal and the reply so far is stored as `incomplete`.

## Chat API (REST `/v1/ai/conversations`)

Every route needs `ai:chat` (granted to members, so to admins and owners too); tenant and user come
from the token, and every handler re-checks them against the principal (403 `TENANT_MISMATCH`).

| Route                                           | What                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/ai/conversations`                     | New conversation (`title?`, `model?` = `AI_DEFAULT_MODEL`, must be allowed: 422 `AI_MODEL_NOT_ALLOWED`). 503 `AI_DISABLED` while AI is off. |
| `GET /v1/ai/conversations`                      | The caller's conversations, newest first (`limit`, `cursor`).                                                                               |
| `GET /v1/ai/conversations/:id`                  | One of them; anyone else's is 404 `CONVERSATION_NOT_FOUND`.                                                                                 |
| `DELETE /v1/ai/conversations/:id`               | Deletes it and its messages (usage rows stay). 204.                                                                                         |
| `GET /v1/ai/conversations/:id/messages`         | Its messages, newest first (`limit`, `cursor`).                                                                                             |
| `POST /v1/ai/conversations/:id/messages`        | One chat turn (`content`, `model?`), optional `Idempotency-Key`; 201 `{ message, replayed }`. Rate limited by `ai.chat`.                    |
| `POST /v1/ai/conversations/:id/messages/stream` | The same turn streamed as `text/event-stream` (see Streaming). Rate limited by `ai.chat`, charged before the call.                          |

A chat turn (`SendMessageHandler`):

1. One unit of work as the caller: the conversation (404 when it is not the caller's); with an
   `Idempotency-Key`, the stored reply for it (same request hash: returned, `replayed: true`, no model
   call; another content or model: 409 `IDEMPOTENCY_KEY_REUSED`); the `AI_HISTORY_MAX_MESSAGES`
   newest messages.
2. The model call (`AiClient.generate`) with the history window then the new user message. The window
   is also cut to `AI_HISTORY_MAX_TOKENS` (characters / 4) and to what `AI_MAX_INPUT_CHARS` leaves
   once the new message and the tool instructions are counted, measured as `AiClient` measures it
   (`aiInputChars`): the oldest messages go first, a tool call and its results together, so a long
   conversation never fails on its history; a new message too large on its own is still 422
   `AI_INPUT_TOO_LARGE`. No transaction is open during the call.
3. One unit of work as the caller: the conversation again, locked first (`findByIdForUpdate`,
   `SELECT … FOR UPDATE`; the row-local messages policy cannot check who owns the conversation a
   message names), the assistant reply carrying the key and request hash (inserted first: the unique
   key decides a concurrent replay), the user message, the usage row and the conversation's
   `updated_at`.

A failed call (502 `AI_UPSTREAM_ERROR`, 504 `AI_TIMEOUT`) stores no message and records a usage row
with outcome `error` or `timeout`; a request refused before any call (`AI_DISABLED`,
`AI_MODEL_NOT_ALLOWED`, `AI_INPUT_TOO_LARGE`) records nothing, and the user message is not stored
either way (a retry sends it again). Logs carry ids, model and token counts, never message text.

A conversation deleted during the call (the locked read in step 3 finds none) stores no message
but commits the usage row (`message_id` null: the tokens were spent) and answers 404
`CONVERSATION_NOT_FOUND`. A delete that arrives during step 3 waits for the lock, so `touch` always
finds the row and the usage is never rolled back with the reply; once step 3 commits, the delete
takes the conversation and all its messages, the new ones included. Usage rows stay either way.

`ai.chat` (`aiRateLimit` namespace): `AI_CHAT_LIMIT` messages per user per `AI_CHAT_TTL_MS`, then
`AI_CHAT_TENANT_LIMIT` per tenant per `AI_CHAT_TENANT_TTL_MS`, shared by every member (the
policy's `tenant` budget of `@platform/redis`). The send route has no handler timeout (`@Timeout(0)`):
`AI_REQUEST_TIMEOUT_MS` bounds it.

## Streaming (SSE and GraphQL)

`AiPort.streamMessage` (`StreamMessageHandler`) is the chat turn above with `AiClient.stream`: the
same read, call and write units of work, the same idempotency and the same refusals, which reject
before the stream starts (so they reach the client as plain errors). The stream yields each text
delta, then stores the reply and yields `done`.

- **SSE** (`POST …/messages/stream`): events `delta` `{ text }` in order, then exactly one `done`
  `{ message, replayed, usage }` (`message` is REST `AiMessage`; `usage` `{ inputTokens,
outputTokens, costUsd }`, `null` on a key replay) or one `error` (an RFC 9457 problem document,
  e.g. 502 `AI_UPSTREAM_ERROR`, 504 `AI_TIMEOUT`). The controller takes the reply over from Fastify
  (`@Res()` + `hijack()`), keeps the headers already set (request id, `RateLimit*`, CORS) and adds
  `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
- **Cancellation.** The response's `close` before it finished (`abortOnDisconnect`; the request's
  own `close` fires once a POST body is read, so it cannot tell) aborts an `AbortController` whose
  signal goes to `AiClient.stream`: no tokens are spent after the client left. A consumer that
  stops reading aborts the call too. A stream cut short is stored exactly once: with text received,
  the user message and an `incomplete` assistant reply (carrying the `Idempotency-Key`, so a replay
  returns it) plus a usage row (`aborted`, `error` or `timeout`, tokens 0: unknown); without any
  text, only the usage row.
- **GraphQL.** The REST API is mirrored by `aiConversations`, `aiConversation(id)`,
  `aiMessages(conversationId)`, `createAiConversation`, `deleteAiConversation(id)` and
  `sendAiMessage`; `streamAiMessage(input)` runs the streamed turn, publishes each event to the
  caller's `aiMessageStream(conversationId)` subscription (`DELTA`, then `DONE` or `ERROR`) and
  resolves with the stored reply. The PubSub trigger is per `(tenant, user, conversation)` from the
  token (`aiMessageStream:<tenantId>:<userId>:<conversationId>`) and the subscription filter checks
  the payload's tenant, user and conversation again (the `notificationCreated` pattern): another user,
  or the same user in another tenant, receives nothing. Over HTTP, closing the mutation's request
  aborts the call like SSE; over graphql-ws the call is bounded by `AI_REQUEST_TIMEOUT_MS`.

## Tools (`application/tools`)

Every chat turn, streamed or not, offers the model three read-only tools (`AI_TOOLS`), each a zod
strict input schema with no id field:

| Tool                    | Reads (through `AiToolSources`)                       | Permission           |
| ----------------------- | ----------------------------------------------------- | -------------------- |
| `get_my_profile`        | `UsersPort.getUser(caller)`: id, email, name, roles   | none (self)          |
| `list_my_notifications` | `NotificationsPort.list` of the caller's inbox        | `notifications:read` |
| `list_my_payments`      | `BillingPort.listPayments` with the caller's `userId` | none (own payments)  |

- **As the caller.** `AiChatTools.forCaller(principal)` binds the tools to the request's principal;
  a tool runs only when the context's principal is that caller (none, or another one: an error, no
  port call), takes tenant and user from it (never from the model), and reads through the owners'
  ports and their own checks (runtime pool under RLS, inbox actor, own payments): never a system
  context. A tool's permission is checked from the caller's roles (`PrincipalPermissions`).
- **Composed in the app.** ai imports no other domain: `AiToolSources` (an ai port typed with the
  owners' contracts) is bound by the composition root; the monolith's `AiToolSourcesModule`
  forwards to `UsersPort`, `NotificationsPort` and `BillingPort` (like `Payment.user`).
- **Bounded.** At most `AI_MAX_TOOL_STEPS` model steps (`stopWhen` in `@platform/ai`); each result is
  JSON, free text clipped to `AI_TOOL_LIMITS.TEXT_MAX_CHARS`, lists to `MAX_ITEMS`, the whole to
  `OUTPUT_MAX_CHARS` (items dropped from the end with `truncated: true`, else `{ truncated: true }`).
- **Always an answer.** The last step has tool choice `none` (`prepareStep` in `@platform/ai`): the
  tools stay listed but none may be called, so a model that called tools on every step before it
  answers in text there, and the stored and returned reply (and the stream's `done`) is never empty
  for want of a final step. With `AI_MAX_TOOL_STEPS=1` no tool runs. A model that calls a tool on
  that step anyway fails the turn with 502 `AI_UPSTREAM_ERROR` (the AI SDK's tool-choice check):
  no message is stored, only a usage row with outcome `error`.
- **Errors go to the model.** A refusal or failure is returned as `{ error: { code, message } }`
  (`PRINCIPAL_MISSING`, `TOOL_CALLER_MISMATCH`, `PERMISSION_DENIED`, a domain refusal's own code,
  or `TOOL_FAILED` with no detail, logged by error name only); the AI SDK answers an unknown tool or
  invalid arguments with a tool error. The client gets the model's reply.
- **Output is data.** The tools and what they read are fixed before the call; the system
  instructions (`AI_TOOLS_SYSTEM_PROMPT`) tell the model that tool results are not instructions.
- **Stored.** The steps' assistant tool calls and tool results are messages (`role` `assistant` /
  `tool`, JSON parts) between the user message and the reply, so the next turn's history replays
  them (the window keeps or drops a tool call and its results together). The reply is the last
  step's text.

## Data model (`aiSchema`, `infrastructure/persistence/ai.schema.ts`)

Schema `ai`, history in `infrastructure/persistence/migrations` (bookkeeping
`ai.__drizzle_migrations`), generated by `bun run db:generate` in this package (`drizzle.config.ts`),
studio on port 4985.

| Table              | Columns                                                                                                                                                                                   | Keys and indexes                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.conversations` | `tenant_id`, `id`, `user_id`, `title` (nullable), `model`, `created_at`, `updated_at`                                                                                                     | PK `(tenant_id, id)`; `(tenant_id, user_id, id)` for "my conversations, newest first"                                                   |
| `ai.messages`      | `tenant_id`, `id`, `conversation_id`, `user_id`, `role`, `content` (jsonb), `status`, `model`, `input_tokens`, `output_tokens`, `idempotency_key`, `request_hash`, `created_at`           | PK `(tenant_id, id)`; `(tenant_id, conversation_id, id)` for the history window; unique `(tenant_id, conversation_id, idempotency_key)` |
| `ai.usage`         | `tenant_id`, `id`, `user_id`, `conversation_id`, `message_id` (nullable), `model`, `input_tokens`, `output_tokens`, `cost_usd` (numeric, nullable), `latency_ms`, `outcome`, `created_at` | PK `(tenant_id, id)`; `(tenant_id, user_id, id)` for usage reports                                                                      |

- Enums: `ai.message_role` (`system`, `user`, `assistant`, `tool`), `ai.message_status` (`complete`,
  `incomplete`: a reply cut short, stored once), `ai.usage_outcome` (`success`, `error`, `timeout`,
  `aborted`: the `outcome` label of `ai_requests_total`).
- Ids are uuidv7 (time order, the keyset cursor). `content` is the AI SDK's `ModelMessage.content`:
  text, or JSON parts (text, tool calls, tool results).
- No foreign key: `conversation_id` and `message_id` are plain columns. Deleting a conversation
  deletes its messages in the same unit of work and keeps its usage rows.

### Distribution and row-level security (`0000_init`)

All three tables are distributed by `tenant_id` (`app.distribute_by_tenant`) right after their
`CREATE`, colocated with every other tenant table, so every query that carries `tenant_id` is a
router query to one shard.

Every row belongs to one user in one tenant: `messages` and `usage` carry the conversation owner's
`user_id`, so each policy is row-local (`tenant_id = app.tenant_id() AND user_id = app.user_id()`)
and none reads another table. RLS is enabled and forced on all three; elevation grants nothing.

| Table           | `app_runtime` grants               | Policies (all `tenant_id = app.tenant_id() AND user_id = app.user_id()`) |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `conversations` | SELECT, INSERT, UPDATE, DELETE     | select, insert, update (USING and WITH CHECK), delete                    |
| `messages`      | SELECT, INSERT, DELETE (no UPDATE) | select, insert, delete                                                   |
| `usage`         | SELECT, INSERT (append-only)       | select, insert                                                           |

`app_system` gets nothing (not even USAGE on the schema): the context has no system method.

Row-local has one consequence the application handles: the insert policy of `messages` checks the
row's own `user_id`, not the conversation's owner. A message is therefore only ever visible to the
user who wrote it, but nothing in the database stops a user from writing a row that names someone
else's `conversation_id`. So a caller loads the conversation as the principal in the same unit of
work before it appends a message to it: the chat turn's write with `findByIdForUpdate` (`null` for
anyone else's), whose row lock also needs the `UPDATE` grant and the update policy's `USING`.

## Repositories

`ConversationsRepository` (`create`, `findById`, `findByIdForUpdate`, `list`, `touch`, `delete`),
`MessagesRepository` (`append`, `findByIdempotencyKey`, `listRecent`, `list`) and `UsageRepository`
(`record`), in `application/repositories`. The Drizzle implementations run every call through
`inUnitOfWork`: they join the open unit of work or open their own with the principal's RLS context,
and without a principal they are refused before `BEGIN` (`RLS_NO_PRINCIPAL`).

- `findByIdForUpdate` is `findById` with `FOR UPDATE` by `(tenant_id, id)` (a router query on
  Citus): the row stays locked until the unit of work ends, so a concurrent `delete` or `touch`
  waits; a conversation deleted before the lock was granted reads as `null`. The in-memory twin
  has no concurrent transactions and only reads.
- A write the policies hide matches no row instead of failing: `touch` and the inserts check the row
  count (`assertRowsAffected`, `RowCountMismatchError`); `delete` returns `false`.
- `append` with an `idempotencyKey` the conversation already has inserts nothing and returns the
  stored message (`created: false`); the caller compares `requestHash`.
- `listRecent(limit)` is the history window, oldest first; `list` pages newest first with the keyset
  cursor of `@platform/database`.

## Tests

| Spec                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/persistence/ai.migrations.spec.ts`                   | Pins `0000_init`: one journal entry, statement order (tables, distribution, indexes, then RLS, grants, policies), the exact grants and policies, no FK, subquery, `CASE` or `IS NULL`.                                                                                                                                                                                                                                                                                                                                                            |
| `testing/in-memory-ai-repositories.spec.ts`                          | The shared contract (`testing/ai-repositories.contract.test.ts`) on the in-memory twins.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `infrastructure/persistence/ai.rls.int-spec.ts`                      | Citus 14.2, three roles, local execution off: distribution and colocation, forced RLS, grants, policies; per table the owner reads exactly its rows, others none, foreign inserts 42501, usage has no UPDATE or DELETE.                                                                                                                                                                                                                                                                                                                           |
| `infrastructure/persistence/ai.repositories.rls.int-spec.ts`         | The same contract on the Drizzle repositories as `app_runtime` (`findByIdForUpdate` locks for the owner, `null` for anyone else), plus one unit of work rolling back as a whole.                                                                                                                                                                                                                                                                                                                                                                  |
| `test/chat-turn-delete.int-spec.ts`                                  | The handlers on Citus (local execution off) racing a delete on a second `app_runtime` connection: a delete during the model call that commits while the turn writes ends a sent and a streamed turn with 404, no message and one usage row (`message_id` null), never a 500; a delete that arrives during the write waits for its commit, then takes the stored messages too, and the usage row stays.                                                                                                                                            |
| `application/history-window.spec.ts`                                 | Newest messages kept by count, tokens and input characters (`aiInputChars`, the guard's measure), the oldest dropped first; a tool call and its result kept or dropped together.                                                                                                                                                                                                                                                                                                                                                                  |
| `application/commands/send-message/send-message.handler.spec.ts`     | Mock model: the stored exchange, usage and `updatedAt`; the window by count and tokens, and the oldest history dropped to fit `AI_MAX_INPUT_CHARS` (a lone oversized message still 422); key replay and 409; refusals, failures and timeouts; the write locks the conversation before any row; a conversation deleted during the call (the usage row only, committed, then 404).                                                                                                                                                                  |
| `application/commands/stream-message/stream-message.handler.spec.ts` | Mock streaming models: deltas in order then `done` and the stored exchange; a client abort or a consumer that stops reading aborts the model and stores one `incomplete` reply; a disconnect during prepare ends at once; no-text aborts and failures store usage only; key replay; refusals before the stream; the oldest history dropped to fit `AI_MAX_INPUT_CHARS`, a lone oversized message still 422; the write locks the conversation before any row; a conversation deleted during the stream (404 after the deltas, the usage row only). |
| `application/tools/ai-chat-tools.spec.ts`                            | Scripted mock model: each tool reads only the caller's data and is stored; the step limit (the last step answers in text, sent and streamed; a tool call there anyway is a 502 and stores nothing); capped output; unknown tool and bad arguments; a failing port; tool output as data; no principal or another one; a missing permission; tools in a streamed turn; no sources, no tools.                                                                                                                                                        |
| `apps/monolith/test/ai-tools.e2e-spec.ts`                            | Every tool through the real identity, notifications and billing ports in the monolith: the caller's profile and inbox only, the calls and results stored.                                                                                                                                                                                                                                                                                                                                                                                         |
| `presentation/grpc/ai-grpc.roundtrip.spec.ts`                        | Real loopback gRPC, `forRemote()` adapter ↔ `AiGrpcController` over a fake port: every unary RPC returns what the local port does (Dates, nulls, JSON content), the principal travels in metadata, codes survive the hop (404, 409, 422, 502, 503); the stream's order, its refusal before any event, a failure mid-stream, and cancellation (abort, or a consumer that stops reading) reaching the service's signal.                                                                                                                             |
| `apps/ai-service/test/app.e2e-spec.ts`                               | ai-service's real `AppModule` over gRPC: caller checks, send and replay, streaming, cancellation storing `incomplete`, the tools through the owners' ports as the caller.                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/gateway/test/ai.e2e-spec.ts`                                   | The gateway's REST and SSE over a stand-in ai-service (`startFakeAiService`): RBAC at the edge, codes back, deltas then `done`, a disconnect cancelling the call.                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/monolith/test/ai-stream.e2e-spec.ts`                           | Over a real connection: SSE deltas then `done`, disconnect aborts the mock model and stores `incomplete`, an `error` event after the headers, problem+json refusals and the `ai.chat` charge before the call; the GraphQL mirror; `aiMessageStream` delivered to its owner only.                                                                                                                                                                                                                                                                  |

```bash
bunx vitest run --project ai
INTEGRATION=1 bunx vitest run --project ai:int   # needs Docker
```
