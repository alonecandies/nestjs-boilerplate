# Review minors and the d866cdf security finding: plan

## Goal

Close the minor findings that the B3, B4+C, outbox+ledger and AI final reviews listed for the user,
and the important memory leak found by the security pass on `d866cdf`. Every item was re-verified
at `71161c6` first. The verified designs, with file and line evidence, are in the git-excluded
research reports: read the named section before starting a task.

- `docs/superpowers/plans/program-work/minors/research-ai.md` (AI-2 … AI-7)
- `docs/superpowers/plans/program-work/minors/research-rl.md` (RL-1 … RL-5, RL-X1 … RL-X4)
- `docs/superpowers/plans/program-work/minors/research-id-lb.md` (ID-1 … ID-3, LB-1 … LB-3)
- `docs/superpowers/plans/program-work/minors/security-d866cdf.md` (S1)

Those paths are relative to the main checkout (git-excluded, so they are not in a clone); they do
not exist in a lane worktree.

Out of scope: ID-3 (stale since `9e6e02d`), RL-X2 (not reproducible with zod 4.6.6), metering a call
cut mid-answer (needs OpenRouter's generation stats and a key), the `notification_recipients`
backfill (needs a deployment decision), and the documented `aiUsageOf` contract for primitive or
shared abort reasons.

## Global Constraints

- Base: `fix/review-minors` at `71161c6`. One GPG-signed commit per task, with the message the task
  gives (header at most 100 characters, body lines at most 100). Reviewed tasks may add one fix commit.
- Behaviour changes and bug fixes are test-first: the acceptance test fails at the base for the
  stated reason, then passes. Refactors and moves get the guard or characterisation test named.
- Docs and doc comments change in the same commit as the behaviour they describe. Do not touch the
  README test count (it is refreshed once at the end).
- No test may call the real OpenRouter API.
- `:int` projects: run only the one the task names, with `INTEGRATION=1` and
  `TEST_POSTGRES_STARTUP_TIMEOUT_MS=360000`. Other lanes run in parallel on an emulated Citus, so a
  container start or hook timeout is load: re-run that project alone before treating it as a failure.
- Keep `bun run check` green: biome, eslint, prettier, tsc, `check-boundaries`, `check-api-subpaths`,
  libs-vocabulary. Cross-domain imports stay forbidden.

## Review Focus

Four tasks are high-risk and get their own review (marked **review**):

- **Task 6 (S1, memory):** no call stays reachable after it settles (GC test), abort semantics
  unchanged (deadline gives `AiTimeoutError`, a caller abort gives its reason), `aiUsageOf` still
  works after the call ended, no unhandled rejection, the residual for a shared signal documented.
- **Task 8 (ID-1, RLS):** always fail-closed; the restore only ever lowers the elevation flag;
  proven with real roles in `database:int`.
- **Task 11 (RL-3, connection caps):** never over-admit (slots held ≥ live counted sockets, so the
  cap holds exactly once Redis answers); acquire and release idempotent; bounded by the TTL; the
  Lua script atomic; the documented fail-open while Redis is unusable unchanged.
- **Task 16 (LB-1, money):** no missed finding: a refund landing on a charge an earlier run already
  reconciled is still reported; a failing check does not stop the others; R5 keeps its own listing.

## Shared files

Tasks that touch the same file sit in the same lane, in order:

- `stream-message.handler.ts`, `docs/AI.md`, `domains/ai/README.md`: Tasks 1 → 2 → 3 (lane ai).
- `libs/ai/src/ai.client.ts`, `ai.client.spec.ts`, `libs/ai/README.md`: Tasks 6 → 7 (lane core).
- `connection-caps.ts`, `notifications.gateway.ts`: Tasks 11 → 12 → 13 → 14 (lane ws).
- reconciliation `checks/r3-payments.ts`, `checks/r4-stripe.ts`, `domains/billing/README.md`:
  Tasks 15 → 16 → 17 (lane bill).
- Across lanes, only docs overlap on different lines: `docs/CONFIGURATION.md` and
  `libs/redis/README.md` (Tasks 11, 14, 20). The main loop resolves those at merge time.

## Interfaces

- Task 3 adds a root export to `@domain/ai`: a plain delegate class over structurally typed owner
  ports (names per research-ai.md AI-2). `./api` stays as pinned by `api-surface.spec.ts`.
- Task 5 adds an abort signal for the graphql-ws connection to the WS `GqlContext`.
- Task 11 changes the connection-cap API: an acquire returns a per-socket slot id that the matching
  release takes.
- Task 16 adds a memoized ref loader to the reconciliation run context.
- Task 17 adds a counter `billing_checkout_paid_without_owner_total` and its DI token.

## Lanes and files

| Lane | Worktree branch | Tasks                                                         |
| ---- | --------------- | ------------------------------------------------------------- |
| ai   | `lane/m-ai`     | 1 AI-6, 2 AI-4, 3 AI-2, 4 AI-3, 5 AI-7                        |
| core | `lane/m-core`   | 6 S1 (review), 7 AI-5, 8 ID-1 (review), 9 ID-2, 10 RL-X4      |
| ws   | `lane/m-ws`     | 11 RL-3 (review), 12 RL-5, 13 RL-X1, 14 RL-X3                 |
| bill | `lane/m-bill`   | 15 LB-2, 16 LB-1 (review), 17 LB-3, 18 RL-4, 19 RL-1, 20 RL-2 |

## Task 1: AI-6, a stream cut before the model call stores and meters nothing

- **Goal:** follow the A1 ruling ("stores nothing") in both topologies. A request whose signal is
  aborted after prepare and before `AiClient.stream` is called makes no model call, records no
  metric and stores no usage row. An abort after the call started keeps its `aborted` row.
- **Design:** research-ai.md AI-6. Return an async iterable that rejects with the abort reason on
  its first read; do not throw from `execute()`, and do not use a generator that only throws.
- **Files:** `stream-message.handler.ts` and its spec, `docs/AI.md`, `domains/ai/README.md`,
  optionally the `ai.port.ts` doc and `docs/OBSERVABILITY.md`.
- **Acceptance:** flip the spec case at about :358 (drain shape) to no usage row and no `doStream`
  call; add the gRPC shape (`return()` before the first `next()`), with no row and no `doStream`.
- **Commit:** `fix(ai,docs): make a stream cut before the model call store and meter nothing`

## Task 2: AI-4, a timed-out stream keeps its outcome and usage when its reader stops

- **Goal:** when the deadline already failed the call and the consumer then stops reading, the cut
  row says `timeout` with the billed usage, the same as the metrics.
- **Design:** research-ai.md AI-4: keep the error `call.usage` rejected with; in `finally`, when it
  exists, compute the outcome before `turn.cancel.abort()` and store the cut with that error.
- **Files:** `stream-message.handler.ts`, `ai-chat-tools.spec.ts`, `docs/AI.md` (replace the "One
  known gap" sentences), `domains/ai/README.md`, and the handler's doc comments.
- **Acceptance:** in `ai-chat-tools.spec.ts`, "the deadline while the consumer holds a delta, then it
  stops reading": one row `{outcome: 'timeout', ...billed(1)}`, the reply stored incomplete, and
  `ai_tokens_total` 1000/50. At the base the row is `aborted` 0/0/null.
- **Commit:** `fix(ai,docs): keep a timed-out stream's outcome and usage when its reader stops`

## Task 3: AI-2, one shared tool-sources delegate

- **Goal:** replace the two byte-identical `PortsAiToolSources` classes with one ai-owned delegate
  over structurally typed owner ports, built by a `useFactory` provider in each app.
- **Design:** research-ai.md AI-2, option B.
- **Files:** `domains/ai/src/application/tools/ai-tool-sources.ts` (and a new spec),
  `domains/ai/src/index.ts`, both apps' `ai-tool-sources.module.ts`,
  `apps/ai-service/test/app.e2e-spec.ts`, `docs/AI.md`, `domains/ai/README.md`,
  `apps/ai-service/README.md`.
- **Acceptance:** the new spec (each method passes its argument through and returns the owner's
  promise) fails at the base because the class does not exist; the ai-service e2e,
  `node scripts/check-boundaries.mjs` and `node scripts/check-api-subpaths.mjs --require-all` pass.
- **Commit:** `refactor(ai,monolith,ai-service): share one tool-sources delegate between the apps`

## Task 4: AI-3, the SSE error event uses the configured problem type base URL

- **Goal:** a REST problem and the SSE `error` event from the same app share the same `type` URL
  when `problemTypeBaseUrl` is set. GraphQL errors and the notifications WebSocket keep the default;
  document that scope.
- **Design:** research-ai.md AI-3, option B. Plain `@Optional()` injection resolves to undefined in
  a feature module; read the options through `ModuleRef.get(..., { strict: false })` or another way
  the e2e proves.
- **Files:** `domains/ai/src/presentation/http/ai.controller.ts`, the JSDoc in
  `libs/common/src/providers/common-enhancers.ts`, the docs that describe the option.
- **Acceptance:** a monolith e2e booting the real module graph with
  `problemTypeBaseUrl: 'https://errors.example.test/'` and a failing mock model: the SSE `error`
  event's `type` is `https://errors.example.test/ai-upstream-error`. Fails at the base.
- **Commit:** `fix(ai,common,docs): build the SSE error event's problem type from the base url`

## Task 5: AI-7, cancel a graphql-ws AI turn when its socket closes

- **Goal:** parity with SSE and gRPC: closing the WebSocket aborts a running `streamAiMessage` turn,
  which is stored incomplete with an `aborted` row instead of running until the timeout.
- **Design:** research-ai.md AI-7, the optional parity enhancement. One `AbortController` per
  graphql-ws connection, created at connect and aborted at close; its signal on the WS context;
  combined with the HTTP disconnect signal in the resolver. Leave the slot bookkeeping in
  `subscription-auth.ts` to Task 11.
- **Files:** `libs/graphql/src/apollo-config.factory.ts`,
  `libs/graphql/src/context/graphql-context.factory.ts`, `domains/ai/src/presentation/graphql/ai.resolver.ts`,
  `apps/monolith/test/ai-stream.e2e-spec.ts`, `docs/AI.md` (the Known limit at about :93-96).
- **Acceptance:** monolith e2e: `streamAiMessage` over graphql-ws with a hanging mock model; close
  the socket after the first delta; the model call is aborted, the reply stored incomplete, one
  `aborted` row. At the base the turn runs until the timeout.
- **Commit:** `feat(ai,graphql,docs): cancel a graphql-ws ai stream when its socket closes`

## Task 6: S1, finished AI calls no longer stay in memory (**review**)

- **Goal:** give the SDK one plain per-call `AbortController` that the deadline and the caller's
  signal abort, instead of an `AbortSignal.any` composite that Node keeps alive through the client's
  never-removed listener.
- **Design:** security-d866cdf.md S1, including its four caveats (keep an abort observer after the
  call ends; retarget the d866cdf test at about :305; gate with the domain stream, send, chat-tools
  and gRPC round-trip specs; document "a per-request signal" on `AiCallInput.signal`).
- **Files:** `libs/ai/src/ai.client.ts`, `libs/ai/src/ai.client.spec.ts`, the `AiCallInput` doc.
- **Acceptance:** in `ai.client.spec.ts`, 20 streamed calls each with a fresh mock model and its own
  caller signal (once plain, once an `AbortSignal.any` of two controllers), a `WeakRef` on each
  `call.usage`, at least 3 rounds of `gc()` plus a sleep, deref in a later task: 0 alive (20/20 at
  the base). Follow the report's trap note about deref timing.
- **Commit:** `fix(ai): stop finished ai calls from staying in memory through their abort signal`

## Task 7: AI-5, generate throws the caller's abort reason during retry backoff

- **Goal:** a caller abort during the SDK's retry backoff makes `generate` throw the caller's reason
  (as `stream` rejects with it) and `aiUsageOf(reason)` read the billed calls.
- **Design:** research-ai.md AI-5 (the zero-risk variant also keeps registering the SDK's error).
- **Files:** `libs/ai/src/ai.client.ts`, `libs/ai/src/ai.client.spec.ts`, `libs/ai/README.md`.
- **Acceptance:** `it.each(KINDS)` "a caller abort during the SDK retry backoff": error `toBe(reason)`,
  `aiUsageOf(reason)` 1000/50/0.01, metrics aborted 1. Fails at the base for `generate`.
- **Commit:** `fix(ai): throw the caller's abort reason when generate is aborted during a retry`

## Task 8: ID-1, restore the elevation flag when a nested savepoint rolls back (**review**)

- **Goal:** a rejected `Nested` call restores the transaction's elevation `permanent` flag it had
  before, so a later `justified()` elevates again; the restore only ever lowers the flag.
- **Design:** research-id-lb.md ID-1 (not "justified() always sends ON", which fails open).
- **Files:** `libs/database/src/drizzle/drizzle-transactional.adapter.ts`,
  `libs/database/src/rls/rls-elevation.service.ts` and its spec,
  `libs/database/test/rls-elevation.int-spec.ts`.
- **Acceptance:** `database:int`, inside `describe.each('DATABASE_PREPARE=%s')`, as app_runtime:
  the four-step sequence in the report. Step 3 is red at the base; the fail-closed pin (step 2) and
  the guard case stay green. Unit companion: the statement list in `rls-elevation.service.spec.ts`.
- **Commit:** `fix(database): restore the rls elevation flag when a nested savepoint rolls back`

## Task 9: ID-2, the session refresh read phase runs in one transaction

- **Goal:** one `TransactionRunner.run` for the read phase instead of three standalone transactions;
  the rotation, `rejection()` and the membership-gone revoke keep their own units.
- **Design:** research-id-lb.md ID-2.
- **Files:** `refresh-session.handler.ts` and its spec.
- **Acceptance:** with `passThroughTransaction()`, a successful refresh has `runner.runs === 1` and
  the three reads inside it, before the rotation. `identity:int` `describe('refresh')` of
  `identity-flows.rls.int-spec.ts` stays green.
- **Commit:** `perf(identity): run the session refresh read phase in one transaction`

## Task 10: RL-X4, the removed THROTTLE_AUTH_* check moves into identity

- **Goal:** `libs/config` stops naming identity variables; the identity rate-limit namespace refuses
  `THROTTLE_AUTH_*` with the same message.
- **Design:** research-rl.md RL-X4.
- **Files:** `libs/config/src/namespaces/throttle.config.ts`, `namespaces.spec.ts`,
  `domains/identity/src/presentation/rate-limit/identity-rate-limit.config.ts` and its spec,
  `scripts/libs-vocabulary.spec.ts`.
- **Acceptance:** a new libs-vocabulary case over non-test sources in `libs/config/src` fails at the
  base; `identityRateLimitConfig.parse({ THROTTLE_AUTH_LIMIT: '7' })` fails naming
  `IDENTITY_CREDENTIALS_LIMIT`, and a blank value counts as unset.
- **Commit:** `refactor(config,identity): move the removed throttle_auth variable check into identity`

## Task 11: RL-3, per-socket connection slots (**review**)

- **Goal:** replace the per-user counter with per-socket slots (a sorted set per user, a Lua acquire,
  an idempotent release), so lost replies, resends and not-ready releases can leak at most until a
  slot's deadline and never over-admit.
- **Design:** research-rl.md RL-3 (slot ids generated per acquire, not `socket.id`; key expiry set to
  the highest member deadline, never shortened; the fail-open fast path kept).
- **Files:** `libs/redis/src/throttler/conn-count.command.ts`, `connection-caps.ts` and spec,
  `libs/redis/src/testing/in-memory-redis.ts`, `libs/redis/src/redis.int-spec.ts`,
  `notifications.gateway.ts` and spec, `libs/graphql/src/auth/subscription-auth.ts` and spec,
  `libs/redis/README.md`, `docs/CONFIGURATION.md`.
- **Acceptance:** the four fault scenarios in the report against a fault wrapper over
  `InMemoryRedis`, asserting after every step that held slots ≥ live counted sockets ≤ cap; the
  same steps in `redis:int` against real Redis; the callers' specs check acquire and release carry
  the same slot id.
- **Commit:** `fix(redis,notifications,graphql): count connection slots per socket; faults never over-admit`

## Task 12: RL-5, connection-cap commands have a timeout

- **Goal:** acquire and release settle within `THROTTLE_REDIS_TIMEOUT_MS`: an acquire that times out
  fails open, a release that times out logs a throttled warning.
- **Design:** research-rl.md RL-5 (`withTimeout` from `@platform/common`; after Task 11).
- **Files:** `connection-caps.ts` and spec.
- **Acceptance:** a stalled fake Redis with `THROTTLE_REDIS_TIMEOUT_MS=50` and fake timers: both
  resolve after 50 ms. At the base both stay pending.
- **Commit:** `fix(redis): bound the connection-cap redis commands by the redis timeout`

## Task 13: RL-X1, no slot for a socket that closed during the handshake

- **Design:** research-rl.md RL-X1.
- **Files:** `notifications.gateway.ts` and spec.
- **Acceptance:** `verifyAccessToken` marks the socket closed: `authenticate` resolves an error and
  neither `acquireSocket` nor `releaseSocket` runs. At the base each runs once.
- **Commit:** `fix(notifications): skip the connection slot for a socket closed during the handshake`

## Task 14: RL-X3, the mark-read policy leaves presentation/ws

- **Design:** research-rl.md RL-X3 (`git mv` to `presentation/rate-limit/`, five imports, the docs link).
- **Acceptance:** the moved spec passes unchanged, plus a case asserting no source under
  `presentation/http` or `presentation/graphql` imports from `../ws/` (fails at the base).
- **Commit:** `refactor(notifications,docs): move the mark-read rate-limit policy out of presentation/ws`

## Task 15: LB-2, one keyset iterator for the reconciliation checks

- **Design:** research-id-lb.md LB-2 (billing-local `checks/keyset-pages.ts`, not `@platform/database`).
- **Acceptance:** new `keyset-pages.spec.ts` (page 2 asked with the last row's cursor; stops after a
  short page and on an empty page); the existing pagination cases in r3/r4/r5 specs stay green.
- **Commit:** `refactor(billing): share one keyset iterator across the reconciliation checks`

## Task 16: LB-1, one ref read per run for R3 and R4 (**review**)

- **Goal:** one memoized ref read per run shared by R3 and R4 (plus R4's small top-up), keeping the
  72 h lookback; no watermark. R5 keeps its own listing.
- **Design:** research-id-lb.md LB-1 (cache only a successful read; R3 filters to its own window).
- **Files:** `reconcile-ledger.command.ts`, `reconcile-ledger.handler.ts` and spec,
  `checks/r3-payments.ts` and spec, `checks/r4-stripe.ts` and spec, `domains/billing/README.md`.
- **Acceptance:** one run reads `listEntryRefs` from `from - 24h` once, and R4 adds only the top-up;
  a failing first read fails R3 while R4 still runs on its own read; the hard-constraint guard in
  `r3-payments.spec.ts` (a refund after a clean run is reported on the next run, both directions),
  green before and after. `billing:int` `reconcile-ledger.int-spec.ts` stays green.
- **Commit:** `perf(billing,docs): read the ledger refs once per reconciliation run for r3 and r4`

## Task 17: LB-3, count paid checkouts recorded without an owner

- **Design:** research-id-lb.md LB-3 (a sibling counter, not a label on the amount counter).
- **Files:** `billing.constants.ts`, `billing-core.module.ts`, `handle-stripe-webhook.handler.ts`
  and spec, `domains/billing/src/index.ts`, `test/stripe-webhook.flow.spec.ts`,
  `docs/OBSERVABILITY.md`, `domains/billing/README.md`.
- **Acceptance:** a paid `checkout.session.completed` with a nil-UUID user increments the counter
  once; a duplicate delivery, a user-less `expired` and an `unpaid` completed session do not.
- **Commit:** `feat(billing,docs): count paid checkout sessions recorded without an owner`

## Task 18: RL-4, the RateLimit header reports the most restrictive decision per policy

- **Design:** research-rl.md RL-4 (`collectDecision`: blocked first, then lower remaining, then
  larger reset).
- **Acceptance:** `rate-limit-headers.spec.ts`: `{r=4}` then `{r=99}` for one name gives `r=4` in
  either order (the base gives `r=99`); a blocked decision wins in either order.
- **Commit:** `fix(redis,docs): report the most restrictive rate-limit decision per policy`

## Task 19: RL-1, resolve a route policy once and charge its buckets in order

- **Design:** research-rl.md RL-1 (`bucketsFor()`; behaviour unchanged; the AUTH lockout untouched).
- **Acceptance:** `app-throttler.guard.spec.ts`: one tenant-budget request calls
  `RateLimitPolicyRegistry.require` once (twice at the base); the existing tenant-policy cases stay
  green unchanged.
- **Commit:** `refactor(redis): resolve a route policy once and charge its buckets in order`

## Task 20: RL-2, refuse `@Throttle()` overrides at boot

- **Design:** research-rl.md RL-2 (drop the `Throttle` re-export, keep `SkipThrottle`; the boot
  validator rejects `THROTTLER:LIMIT*` / `THROTTLER:TTL*` metadata, also from direct imports).
- **Acceptance:** `app-throttler.module.spec.ts`: a handler with `@Throttle(...)` imported from
  `@nestjs/throttler` makes the application context fail to boot with the new message; at the base
  it boots.
- **Commit:** `fix(redis,docs): refuse @Throttle overrides at boot instead of rewriting the bucket`
