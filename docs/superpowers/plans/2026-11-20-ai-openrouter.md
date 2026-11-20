# AI through OpenRouter: plan (medium tier)

Date: 2026-11-20. Branch `feat/ai-openrouter` from `master` (e2dc393). Light plan: goals, files, acceptance tests.
One signed commit per task. Per-task review only on Tasks 2 and 5; one final `code-review high` at the end.

## Decisions (user, 2026-11-20)

- Package: Vercel AI SDK, `ai` pinned **7.0.163** (2026-11-05; 7.0.177 is two days old) and
  `@openrouter/ai-sdk-provider` **3.1.0** (peer `ai ^7`, `zod ^3.25.76 || ^4.1.8`, repo has zod 4.6.6). Root
  catalog entries; `bun install` commits `bun.lock`.
- Scope: platform lib, chat API (REST + GraphQL, streaming), conversation history, tool calling, plus the common
  production concerns below.
- Limits: a rate-limit policy (existing C framework) plus a per-request usage log and metrics. No budget.

## Common concerns built in (apply across tasks)

- **Off by default:** `AI_ENABLED=false`; with it off, nothing calls OpenRouter and the routes answer 503
  `AI_DISABLED`. `OPENROUTER_API_KEY` is required (and a known placeholder refused in production) only when enabled.
- **Model control:** a default model, an allowlist (`AI_ALLOWED_MODELS`), optional fallbacks (OpenRouter `models`
  routing); a request for a model outside the allowlist is 422.
- **Bounded cost and time:** `AI_MAX_OUTPUT_TOKENS`, `AI_REQUEST_TIMEOUT_MS` via `AbortSignal`, SDK `maxRetries` for
  429/5xx only, a history window by message count and approximate token budget, a cap on input length.
- **Cancellation:** a client that disconnects aborts the upstream call (no tokens spent after the user left); a partial
  assistant message is stored as `incomplete`.
- **Privacy:** prompts and completions are never logged; logs carry ids, model, token counts and latency only.
- **Idempotency:** `Idempotency-Key` on send-message: a replay returns the stored assistant message, a different body
  with the same key is 409.
- **Observability:** OpenTelemetry span per call (model, tokens, finish reason, no content); metrics
  `ai_requests_total{model,outcome}`, `ai_tokens_total{model,kind}`, `ai_request_duration_seconds{model}`.
- **Security:** permission `ai:chat` (member and above); tenancy and RLS like every other domain (row-local policies
  only, B3 ruling); tool calls run as the caller and are read-only (Task 5).

## Tasks

### Task 1: `@platform/ai` library

- **Goal.** A domain-free client over the AI SDK with config, guards, metrics and a test double.
- **Files.** `libs/ai/**` (package modeled on `libs/redis`; exports `.`, `./testing`), `libs/config` `ai` namespace
  (+ spec, `all-config`), root `.env.example`, `docs/CONFIGURATION.md`.
- **Interfaces.** `AiModule.forRootAsync()`, `AiClient` with `generate({ messages, model?, tools?, signal })` and
  `stream(...)` returning the SDK's stream plus a `usage` promise; `AiDisabledError`, `AiModelNotAllowedError`;
  `@platform/ai/testing` exports a mock model built on the AI SDK's test utilities.
- **Acceptance tests.** Config: defaults, allowlist parsing, timeout/token bounds, key required only when enabled,
  production placeholder refused. Client (mock model): disabled refuses before any call; disallowed model 422; abort
  signal and timeout cancel; usage and metrics recorded; nothing in logs contains the prompt text.

### Task 2: `ai` domain persistence (review)

- **Goal.** Per-tenant conversations, messages and a usage log, distributed and under RLS.
- **Files.** `domains/ai/**` (package, `drizzle.config.ts`, schema, migrations `0000_init` with distribution + RLS +
  grants, repositories, in-memory twins), `domains/ai/README.md`.
- **Tables.** `ai.conversations (tenant_id, id, user_id, title, model, created_at, updated_at)`,
  `ai.messages (tenant_id, id, conversation_id, role, content jsonb, status, model, input_tokens, output_tokens,
idempotency_key, request_hash, created_at)`, `ai.usage (tenant_id, id, user_id, conversation_id, message_id, model,
input_tokens, output_tokens, cost_usd nullable, latency_ms, outcome, created_at)`. All tenant-distributed and
  colocated; RLS row-local: `tenant_id = app.tenant_id() AND user_id = app.user_id()` (messages via conversation's
  `user_id` column copied onto the row), insert-only for usage.
- **Acceptance tests.** Int on Citus, local execution off: owner reads exactly its rows; another user in the tenant
  and another tenant read none; inserts for another user/tenant fail 42501; usage has no UPDATE/DELETE; migrations
  spec pins statement order and grants; repositories use `inUnitOfWork` and row-count asserts.

### Task 3: Conversations and non-streaming chat

- **Goal.** Create, list, read and delete conversations; send a message and get the reply.
- **Files.** `domains/ai/src/application/**` (commands/queries/handlers), REST controller and response schemas,
  `ai.permissions.ts` (`ai:chat`), rate-limit policy `ai.chat` (per user and per tenant), `AiApiModule.forLocal()`,
  monolith wiring.
- **Rules.** History window then the user message go to `AiClient.generate`; the assistant message, usage row and
  conversation `updated_at` are written in one unit of work after the call; a failed call stores no assistant message
  and records a usage row with the failure outcome. Idempotency as above.
- **Acceptance tests.** Handler specs with the mock model (window trimming, idempotent replay, 409 on a changed body,
  disabled → 503, disallowed model → 422, failure path); REST e2e in the monolith; RBAC 403 without `ai:chat`;
  429 from the policy.

### Task 4: Streaming over SSE and GraphQL

- **Goal.** Token streaming for clients.
- **Files.** `POST /v1/ai/conversations/:id/messages/stream` (SSE: `delta`, `done` with usage, `error`), GraphQL
  queries and mutations mirroring REST plus a subscription `aiMessageStream(conversationId)` over the existing PubSub,
  filtered by tenant and user (B4 pattern).
- **Rules.** Client disconnect aborts upstream (`request.raw` close → `AbortController`); the final or partial
  (`incomplete`) message is persisted once; the rate-limit charge happens before the call.
- **Acceptance tests.** SSE e2e (mock model emitting chunks) receives deltas in order and `done`; disconnect mid-stream
  aborts the mock model and stores `incomplete`; GraphQL subscription delivers only to its owner (another user or
  tenant receives nothing).

### Task 5: Tool calling (review)

- **Goal.** The model can call a few read-only app tools.
- **Files.** `domains/ai/src/application/tools/**`: a typed registry (zod input schemas) with `get_my_profile`
  (UsersPort, self), `list_my_notifications` (NotificationsPort), `list_my_payments` (BillingPort), each through the
  existing ports under the caller's principal.
- **Rules.** Tools only read, only as the caller (never system context), output size-capped and JSON-only, step limit
  (`stopWhen` / max steps, config `AI_MAX_TOOL_STEPS`); tool calls and results are stored as messages; a tool error is
  returned to the model, not thrown to the client. Tool output is treated as untrusted data (no instructions from it
  change tool permissions).
- **Acceptance tests.** Mock model that calls each tool: results scoped to the caller (another tenant's data never
  returned); step limit enforced; oversize output truncated; unknown tool or bad arguments handled; a tool cannot run
  without a principal.

### Task 6: Microservices topology

- **Goal.** The same API through the gateway.
- **Files.** `domains/ai/contracts` (proto `ai.v1`: unary RPCs plus server-streaming `StreamMessage`), new
  `apps/ai-service` (modeled on `apps/billing-service`), gateway `AiApiModule.forRemote()` adapters, compose service and
  env, topology check.
- **Acceptance tests.** gRPC round-trip spec (unary + streaming, principal metadata, cancellation propagates);
  gateway e2e for REST and SSE over the fake upstream; `check-topology` boots both topologies.

### Task 7: Docs, e2e and the README count

- **Files.** `docs/AI.md` (setup, OpenRouter key, models, limits, privacy, tools), `docs/API.md`,
  `docs/SECURITY.md` (permission, RLS rows, tool trust model), `docs/OBSERVABILITY.md` (metrics, alert on error
  rate), `docs/CONFIGURATION.md`, README.
- **Acceptance tests.** Docs specs that pin tables still pass; full gate; README count from a fresh run.

## Gates

`bun run check` (NODE_OPTIONS=--max-old-space-size=12288), `bun run db:check`, unit/e2e, every :int project one at a
time. No test calls the real OpenRouter API; a manual smoke command is documented in `docs/AI.md`.
