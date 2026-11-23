# AI chat through OpenRouter

The boilerplate ships an AI chat feature: per-user conversations with a language model, plain or streamed replies, a
history window, read-only tools that answer questions about the caller's own data, a usage log and metrics. Model calls
go through [OpenRouter](https://openrouter.ai) on the Vercel AI SDK (`ai` 7, `@openrouter/ai-sdk-provider` 3).

It is **off by default** (`AI_ENABLED=false`): nothing calls OpenRouter and every AI route answers 503 `AI_DISABLED`.

| Piece                                                       | What                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@platform/ai`](../libs/ai/README.md) (`libs/ai`)          | `AiClient` (`generate`, `stream`): the switch, the model allowlist, the caps, cancellation, metrics and a span per call. Names no domain             |
| [`@domain/ai`](../domains/ai/README.md) (`domains/ai`)      | conversations, messages and the usage log (Postgres, schema `ai`, row-local RLS), the chat API (REST, SSE, GraphQL), `ai:chat`, `ai.chat`, the tools |
| [`@domain/ai-contracts`](../domains/ai/contracts/README.md) | `ai.v1.AiService` (gRPC, unary RPCs plus the server-streaming `StreamMessage`) for the microservices topology                                        |
| [ai-service](../apps/ai-service/README.md)                  | the microservices home of the domain: gRPC `ai.v1.AiService` on `50054` (host dev), behind the gateway's `AiApiModule.forRemote()`                   |

In the monolith the chat API runs in-process (`AiCoreModule` + `AiApiModule.forLocal()`). In the microservices topology
the gateway serves the same REST, SSE and GraphQL surface and calls ai-service over gRPC; RBAC and the rate limit stay at
the edge. The routes, GraphQL fields and RPCs are listed in [API.md](API.md#rest-endpoints).

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys). OpenRouter bills per token, so set a credit
   limit on the key itself: the boilerplate caps each call (below) but keeps no budget.
2. Turn the feature on for the process that runs the domain (the monolith, or ai-service), in the root `.env`:

   ```bash
   AI_ENABLED=true
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

   `OPENROUTER_API_KEY` is required only when `AI_ENABLED=true`; a missing key fails the boot. With `NODE_ENV=production`
   a known placeholder is refused (unless `ALLOW_KNOWN_LOCAL_SECRETS=true`) and `OPENROUTER_BASE_URL` (default
   `https://openrouter.ai/api/v1`) must be https on a non-loopback host. The key is never logged.

3. Migrate: `bun run db:migrate` applies ai's `0000_init` after identity and billing (the monolith also does it at boot
   with `DATABASE_RUN_MIGRATIONS=true`; ai-service runs its own history the same way).
4. Nothing to grant: `ai:chat` is a default grant of `member`, so every member, admin and owner can chat. Move the
   grant from `member` to `admin` in `AI_RBAC` (`domains/ai/src/ai.permissions.ts`) to limit the feature to admins and
   owners.

Docker Compose passes `AI_ENABLED` and `OPENROUTER_API_KEY` through to the monolith and ai-service (the `x-env-ai`
anchor); every other `AI_*` variable keeps its default there unless you add it. In the gateway, set `AI_GRPC_URL`
(default `localhost:50054`; compose `ai-service:50051`) and keep `AI_GRPC_CHAT_DEADLINE_MS` (default 70000) above
ai-service's `AI_REQUEST_TIMEOUT_MS`, so the model's own timeout (504 `AI_TIMEOUT`) answers first. See
[CONFIGURATION.md](CONFIGURATION.md#ai--llm-calls-through-openrouter).

## Models

| Variable             | Default              | What                                                                                                                         |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AI_DEFAULT_MODEL`   | `openai/gpt-4o-mini` | The model of a conversation or message that names none. An OpenRouter id: `<vendor>/<model>[:variant]`                       |
| `AI_ALLOWED_MODELS`  | empty                | CSV of the other models a request may name. The default model is always allowed; anything else is 422 `AI_MODEL_NOT_ALLOWED` |
| `AI_FALLBACK_MODELS` | empty                | CSV for OpenRouter's `models` routing, tried in order when the requested model fails. Each must be allowed                   |

- A conversation stores its model (`POST /v1/ai/conversations` with `model?`); a message may name another allowed model
  for one turn. Creating a conversation with a model outside the list is refused too, so no conversation is bound to a
  model that cannot be called.
- The tools are offered on every turn, so list only **tool-capable** models: OpenRouter must show both "tools" and
  "tool_choice" among a model's supported parameters (OpenRouter drops a parameter a provider does not support). OpenRouter refuses a tool call to a model without tool support, and the turn fails with 502
  `AI_UPSTREAM_ERROR`. The last tool step sends `tool_choice: none` (below); a model that calls a tool there anyway
  fails the turn with 502 too.
- The `model` label of the metrics is the requested model, so the allowlist also bounds their cardinality.

## Limits

| Variable                  | Default | What                                                                                                                             |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AI_MAX_OUTPUT_TOKENS`    | `1024`  | Output cap of one call (1-32768)                                                                                                 |
| `AI_REQUEST_TIMEOUT_MS`   | `60000` | Deadline of one call, a whole stream and its tool steps included. The upstream call is aborted; the caller gets 504 `AI_TIMEOUT` |
| `AI_MAX_RETRIES`          | `2`     | AI SDK retries of retryable failures only (429, 5xx, network), 0-5. After them: 502 `AI_UPSTREAM_ERROR`                          |
| `AI_MAX_INPUT_CHARS`      | `32000` | Characters one call sends, history and tool instructions included; the history is trimmed to fit (below)                         |
| `AI_HISTORY_MAX_MESSAGES` | `20`    | The history window: the newest N messages of the conversation                                                                    |
| `AI_HISTORY_MAX_TOKENS`   | `8000`  | Approximate token budget of that window (characters / 4), newest kept                                                            |
| `AI_MAX_TOOL_STEPS`       | `3`     | Model steps of one turn when it calls tools (1-10); the last may not call one, so it answers in text (1: no tool runs)           |
| `AI_CHAT_LIMIT`           | `20`    | `ai.chat` rate limit: chat turns per user per `AI_CHAT_TTL_MS` (default 60000)                                                   |
| `AI_CHAT_TENANT_LIMIT`    | `200`   | `ai.chat`: chat turns per tenant per `AI_CHAT_TENANT_TTL_MS` (default 60000), shared by every member, after the user budget      |

- `ai.chat` is charged by the send and stream routes and the `sendAiMessage` / `streamAiMessage` mutations, before the
  model call (429 `RATE_LIMITED` with `Retry-After`). Reads and conversation management only count towards the global
  budgets. In the microservices topology the gateway charges it.
- A single message is at most 100000 characters (400 `VALIDATION_FAILED`); a title 200.
- The history window holds what all three history limits allow: at most `AI_HISTORY_MAX_MESSAGES`, within
  `AI_HISTORY_MAX_TOKENS`, and within what `AI_MAX_INPUT_CHARS` leaves once the new message and the tool instructions
  are counted (as `AiClient` counts them: text, tool calls and results as JSON). The oldest messages go first, and a
  tool call and its results are kept or dropped together, so a long conversation is never refused for its history;
  only a new message that is over the cap on its own (with the instructions) is 422 `AI_INPUT_TOO_LARGE`.
- A cut exchange that was asked again is left out of the history: an `incomplete` reply (a stream cut short, below)
  and the user message right before it are not sent when the next user message after the reply, stored or the one
  being sent, has the same text. So a retry after a cut sends its question once, never twice with half an answer
  between, in its own turn and in every later one. A cut the user did not retry stays in the history, so the model can
  go on from it. Both questions and the partial reply stay stored and listed; only what the model receives changes.
- The chat routes have no handler timeout (`@Timeout(0)`): `AI_REQUEST_TIMEOUT_MS` bounds them.
- **Known limit:** a `streamAiMessage` turn sent over graphql-ws (a WebSocket) is bounded only by
  `AI_REQUEST_TIMEOUT_MS`. Closing the socket does not abort the upstream call, because the mutation has no HTTP request
  to cancel; over HTTP POST, closing the request aborts it as for the SSE route. Prefer the SSE route for streams a user
  may abandon, and keep `AI_REQUEST_TIMEOUT_MS` and `AI_MAX_OUTPUT_TOKENS` modest.

Every response carries one of these codes when a call is refused or fails (REST problem+json, GraphQL
`extensions.code`, gRPC `x-error-code`, the SSE `error` event):

| Code                     | Status | When                                                                                                                  |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `AI_DISABLED`            | 503    | `AI_ENABLED=false`; checked before anything else, nothing is stored                                                   |
| `AI_MODEL_NOT_ALLOWED`   | 422    | the model is not `AI_DEFAULT_MODEL` nor in `AI_ALLOWED_MODELS` (`details.model`)                                      |
| `AI_INPUT_TOO_LARGE`     | 422    | the new message plus the tool instructions (when tools are on) is over `AI_MAX_INPUT_CHARS` (`details.maxInputChars`) |
| `AI_TIMEOUT`             | 504    | the call ran longer than `AI_REQUEST_TIMEOUT_MS` (`details.timeoutMs`)                                                |
| `AI_UPSTREAM_ERROR`      | 502    | OpenRouter or the model failed after the retries; the upstream message is never returned                              |
| `CONVERSATION_NOT_FOUND` | 404    | no conversation with this id among the caller's (another user's is never visible)                                     |
| `IDEMPOTENCY_KEY_REUSED` | 409    | an `Idempotency-Key` replayed with a different message (content or model)                                             |
| `TENANT_MISMATCH`        | 403    | the request names a tenant or user other than the caller's principal (gRPC callers)                                   |

A refusal before the call (`AI_DISABLED`, `AI_MODEL_NOT_ALLOWED`, `AI_INPUT_TOO_LARGE`) stores nothing. Neither does a
streamed turn whose client left before the model call (while the history was read): it makes no call, so no usage row
and no metric are recorded, and its stream ends with the abort at once. A failed call
(`AI_TIMEOUT`, `AI_UPSTREAM_ERROR`) stores no message but a usage row with outcome `timeout` or `error`, because tokens
may have been spent. A streamed turn the client abandons (it disconnects, or closes the GraphQL request) aborts the
upstream call: no tokens are spent after the client left. The reply so far, if any text arrived, is stored once as an `incomplete`
message, and a usage row records the outcome `aborted`. A stream that fails after some text (`AI_UPSTREAM_ERROR`,
`AI_TIMEOUT`) is cut the same way, with the outcome `error` or `timeout`. A cut reply never holds the turn's
`Idempotency-Key` (below).

The usage row of a failed or cut turn holds what OpenRouter billed for it: the tokens and `cost_usd` of every model step
(one request to OpenRouter) that ended before the failure, metered by `@platform/ai` as each one ends (`aiUsageOf`). A
tool loop that times out, fails upstream, is abandoned, or ends on a model that calls a tool on its last step anyway
therefore records the steps it paid for, and `ai_tokens_total` counts the same tokens. A step cut mid-answer (a timeout
or abort) reports no usage, so a turn cut during its first step records 0 tokens and no cost. A step the provider fails
mid-answer counts when its usage arrives after the error, as OpenRouter's can. A consumer that stops reading after the
call already failed (its deadline, or an upstream error) records that failure's outcome and billed usage, as the metrics
do.

A conversation deleted while one of its turns runs ends the turn with 404 `CONVERSATION_NOT_FOUND` (streamed: the
`error` event after the deltas). No message is stored, but the usage row is (`message_id` null), because the tokens were
spent. The turn's write locks the conversation first (`SELECT … FOR UPDATE` by `(tenant_id, id)`), so a delete that
arrives during the write waits for it and then deletes the turn's messages with the rest; the usage row stays either way.

`Idempotency-Key` (8-255 characters of `[A-Za-z0-9._:-]`) on send makes retries safe: the key is stored on the assistant
reply, unique per conversation, and a replay with the same content and model returns the stored reply
(`replayed: true`) without calling the model again. Only a complete reply holds the key. A stream cut short stores its
`incomplete` reply without the key or the request hash, so a retry with the same key runs a new turn and gets a full
answer, which then holds the key; a call that fails before any text stores no reply at all. Until a complete reply
holds it, the key is free: a request with it and another body is a new turn, not a 409. The retry's question is
stored next to the cut one, and the history rule above sends it once.

## Privacy

- **Prompts and completions are never logged** and never put on spans. Logs carry ids, the model, token counts,
  latency and the outcome only. A failure logs the error name and the upstream HTTP status, never the upstream message
  (a provider may echo the prompt in it). Tool failures are logged by error name only.
- Message text is stored in `ai.messages` (`content`, jsonb), readable only by the user who wrote the conversation
  (row-local RLS, [SECURITY.md](SECURITY.md#row-level-security)). Deleting a conversation deletes its messages; the
  usage rows (ids, model, tokens, cost, latency, outcome; no text) stay, append-only.
- What OpenRouter and the model provider keep is governed by your OpenRouter account settings (data policy, provider
  filters). Every turn sends the history window and the tools' results to OpenRouter, so the caller's own profile,
  inbox or payments can leave the cluster when the model asks for them. Remove a tool (below) if that is not acceptable.

Observability, with no content in any of it:

| Signal                                                   | What                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ai_requests_total`                                      | counter by `model`, `outcome` (`success`, `error`, `timeout`, `aborted`)                         |
| `ai_tokens_total`                                        | counter by `model`, `kind` (`input`, `output`), every outcome (a failed call: its ended steps)   |
| `ai_request_duration_seconds`                            | histogram by `model` (a whole stream for streamed calls)                                         |
| `AiErrorRate` alert                                      | `error` and `timeout` above 10 % of a model's calls for 10 minutes (ticket); aborts are excluded |
| span `ai.generate` / `ai.stream` (tracer `@platform/ai`) | `gen_ai.request.model`, `gen_ai.request.max_tokens`, token usage, finish reason, outcome         |
| `ai.usage` table                                         | one row per chat turn: tokens, `cost_usd` (OpenRouter usage accounting), latency, outcome        |

See [OBSERVABILITY.md](OBSERVABILITY.md#outbox-ledger-and-ai-alerts).

## Tools

Every chat turn, streamed or not, offers the model three read-only tools. Each runs **as the caller**: tenant and user
come from the request's principal, never from the model, and each reads through the owning domain's port with that
domain's own checks (RLS, the inbox owner, own payments). Their input schemas are strict and hold no id.

| Tool                    | Reads                                                                     | Permission           |
| ----------------------- | ------------------------------------------------------------------------- | -------------------- |
| `get_my_profile`        | the caller's id, email, display name, roles in the active workspace       | none (self)          |
| `list_my_notifications` | the caller's inbox in the active workspace, newest first (`limit` 1-20)   | `notifications:read` |
| `list_my_payments`      | the caller's own payments in the active workspace, newest first (`limit`) | none (own payments)  |

- **Trust model.** Tool results are **untrusted data**, not instructions: they can carry text other users or Stripe
  wrote (a notification title, for instance). `AI_TOOLS_SYSTEM_PROMPT` tells the model so and tells it never to ask for
  another user or workspace; whatever the model asks, the tools can only read the caller's own data, because the
  identity they read with is fixed before the call. A prompt injection can therefore at most make the model misquote
  what the caller could read anyway.
- **Errors go to the model**, never to the client, as `{ error: { code, message } }`: `PRINCIPAL_MISSING` (no principal
  in the context), `TOOL_CALLER_MISMATCH` (the context's principal is not the caller the tools were built for),
  `PERMISSION_DENIED` (the caller lacks the tool's permission), a domain refusal's own code, or `TOOL_FAILED` (anything
  else, with no detail). Unknown tools and invalid arguments are answered by the AI SDK as tool errors.
- **Bounded.** At most `AI_MAX_TOOL_STEPS` model steps; each result is JSON, free text clipped to 500 characters, at
  most 20 items, the whole at most 8000 characters (`AI_TOOL_LIMITS`).
- **Always an answer.** The last of those steps is sent with `tool_choice: none` (the tools still listed): the model
  must answer in text there, so a turn whose model called tools on every step before still gets a reply, and the
  stored reply, the response and the stream's `done` event are never empty for want of a final step. With
  `AI_MAX_TOOL_STEPS=1` no tool runs. A model that calls a tool on that step anyway fails the turn with 502
  `AI_UPSTREAM_ERROR`: no message is stored, only a usage row with outcome `error` and every step billed, that one
  included. A streamed turn that already sent text is a cut stream instead: that text is stored as an `incomplete`
  reply that does not hold the key, so a retry runs the turn again, as a sent turn's retry does after the same 502.
- **Stored.** The tool calls and results become messages (`assistant` / `tool`) between the user message and the reply,
  so the next turn's history replays them.
- **Wiring.** ai imports no other domain: the composition root binds `AiToolSources` to the owners' ports (the
  monolith's `AiToolSourcesModule` in-process; ai-service's over the identity, notifications and billing gRPC clients,
  forwarding the caller's principal). Without a binding no tools are offered. To add a tool, add it to `AI_TOOLS`
  (`domains/ai/src/application/tools/ai-tools.ts`) with a strict schema, a caller-scoped read and, when its REST twin has
  one, the same permission; to drop one, remove it there.

## Manual smoke test

No test calls OpenRouter: the specs and e2e suites use the AI SDK's mock models (`@platform/ai/testing`) or a stand-in
ai-service. To try the real thing once by hand, with a key that has a small credit limit:

```bash
AI_ENABLED=true OPENROUTER_API_KEY=sk-or-v1-... bun run dev   # monolith on :3000 (infra up, migrated)

TOKEN=$(curl -s http://localhost:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ai-smoke@example.com","password":"correct horse battery staple","displayName":"AI Smoke"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

CONVERSATION=$(curl -s http://localhost:3000/v1/ai/conversations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"smoke"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# One turn (201 { message, replayed }); the same Idempotency-Key again returns the stored reply
curl -s http://localhost:3000/v1/ai/conversations/$CONVERSATION/messages -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: smoke-1' -d '{"content":"Say hello in five words."}'

# Streamed (Server-Sent Events: delta..., then done); exercises a tool call
curl -sN http://localhost:3000/v1/ai/conversations/$CONVERSATION/messages/stream -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"content":"What is my display name?"}'

curl -s http://localhost:9464/metrics | grep '^ai_'
```

Expect a short reply, a stream of `event: delta` lines ending with `event: done`, and `ai_requests_total` counting two
successful calls (a turn that used a tool is still one call, of several model steps). With `AI_ENABLED=false` the first call answers 503
`AI_DISABLED`; that is what `bun run docker:smoke` checks in both topologies.
