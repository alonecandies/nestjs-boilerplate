# Audit follow-ups: plan

## Goal

Close the 52 Minor and deferred findings left open by the audit-fixes program
(`docs/superpowers/plans/2026-11-23-audit-fixes.md`, landed as `ce248db`, `1bfded7` and `713dfef`).
The inventory numbers them B1-1 to B1-14, B2-1 to B2-22 and B3-1 to B3-16 after the batch that
raised them. The inventory and the research behind this plan are in
`docs/superpowers/plans/program-work/follow-ups/` of the main checkout. That folder is git-excluded
and does not exist in a lane worktree, so each task below carries what a lane needs.

Tier: large and high-risk in parts (gRPC auth, Kafka delivery, ledger verification). Three tasks get
a review of their own; each batch ends with one final review.

Of the 52 items, 47 become part of the 30 tasks, 5 are decided as no change (section "Decided: no
change") and 4 decisions are surfaced to the user with a default the plan proceeds on (section
"Needs a user decision"). The table at the end maps every item.

The work lands in three batches, grouped by the files the tasks share and not by the batch that
raised the item. Each batch is merged and pushed on its own after its gate and review:

- **Batch 1, delivery, alerts and test hygiene:** B3-6, B3-7, B3-8, B3-1, B3-2, B3-3, B3-4, B3-5,
  B3-9, B3-10.
- **Batch 2, gRPC principal, WebSockets and auth config:** B2-1 to B2-22, and B1-3 (it edits the
  file B2-1 edits).
- **Batch 3, migrations, ledger and CI:** B1-2, B1-4, B1-5, B1-7 to B1-14, B3-11, B3-12, B3-13.

### Verified before designing

Checked at `713dfef` on 2026-11-24. "Read" means read in the code or in `node_modules`; "probe"
means run in a throwaway container, removed afterwards; UNTESTED means not run.

1. **Kafka consumer timing (read: kafkajs 2.2.4, `@nestjs/microservices` 12.1.2; UNTESTED at
   runtime).**
   - `libs/transport/src/kafka/kafka.options.ts` sets `sessionTimeout` 30 s, `heartbeatInterval`
     3 s, `rebalanceTimeout` 60 s. `maxWaitTimeInMs` is the kafkajs default, 5 s.
   - kafkajs heartbeats only between messages. The first message of a batch can start about
     3 + 5 = 8 s after the last heartbeat, so a handler has about 22 s, not 30 s.
   - kafkajs hands `eachMessage` a `heartbeat()` function and Nest exposes it as
     `KafkaContext.getHeartbeat()`. It sends at most once per `heartbeatInterval`, shares one
     promise between callers, and rejects during a rebalance (after committing the resolved
     offsets).
   - `KafkaProducer.publish` has no client deadline: one produce request is bounded by
     `KAFKA_REQUEST_TIMEOUT_MS` (30 s) and the producer retries it (5 retries by reading the code,
     UNTESTED), about 200 s in the worst case. The dead-letter send in `KafkaDeadLetterFilter` uses
     the consumer's own producer with the same behaviour, inside the same `eachMessage`.
   - `KafkaRetryInterceptor` runs 4 attempts with at most 0.25 + 0.5 + 1 = 1.75 s between them.
     Worst case today: 4 × 200 + 1.75 + 200 ≈ 1,000 s.
   - Bounding the publish alone is not enough. The dead-letter send is unbounded, Cassandra's
     request timeout is 12 s, and `MailService.enqueue` waits out a Redis outage
     (`maxRetriesPerRequest: null`; its exact behaviour is UNTESTED). A deadline-only design must
     keep 4 attempts plus the dead-letter send inside about 15 s, which gives about 3 s per attempt:
     below the Cassandra timeout, so slow but healthy attempts would be abandoned and dead-lettered.
   - The other consumers. `LedgerPostingConsumer` calls Stripe (`STRIPE_TIMEOUT_MS` 20 s, 2 SDK
     retries, up to 3 fetches with 1 s and 2 s waits) and immudb (`IMMUDB_TIMEOUT_MS` 5 s), and
     turns outage-like errors into `KafkaRetriableException`, so they are redelivered and never
     dead-lettered. `NotificationPushConsumer` (gateway, monolith) does one Redis `SET NX`, one
     Socket.IO emit and one PubSub publish.
   - An rxjs `timeout` or `withTimeout` abandons the wait and does not cancel the work.
   - Offsets are committed at the end of a batch and after a failed message: `autoCommitInterval`
     and `autoCommitThreshold` are unset. kafkajs calls `commitOffsetsIfNecessary` after every
     message, so `run.autoCommitInterval` (in Nest's `run` options) makes it commit during a batch.
2. **Circuit breakers (read: opossum 10.0.0).**
   - `GrpcCircuitBreakers.get(name)` creates a breaker on its first call and listens to `open`,
     `halfOpen` and `close` for logs only. Upstream names: `identity`, `notifications`, `billing`,
     `billing-stripe`, `ai`.
   - Events: `reject` (open, or half-open after the probe slot was taken), `failure` (an unfiltered
     error; a failed half-open probe emits `failure`, never `reject`), `success` (also for an error
     the `errorFilter` filtered out, that is a caller error from a healthy upstream).
   - From closed, a breaker opens only once the 10 s window holds 10 calls (`volumeThreshold`), so
     traffic below that never opens it and no rule joined on the state can fire for it.
   - `grpc_client_handled_total` has no `upstream` label, and adding one would end every existing
     series. No Grafana dashboard reads it; `AUDIT_SERIES` in `scripts/prometheus-rules.spec.ts`
     does not list it.
   - No promtool test file is committed. The compose file pins `prom/prometheus:v3.15.0`.
3. **kafka-exporter (probe against `apache/kafka:4.3.1`).**
   - `danielqsj/kafka-exporter:v1.11.0` (2026-10-23), multi-arch index digest
     `sha256:54d4296c5b8ce01232f6762e06cbc3eec25887c0b5c5940ccb9e891ac7fc51d8`. Compose pins tags,
     not digests (`postgres-exporter`, `redis_exporter`).
   - With `--kafka.version=2.0.0` and `4.0.0` it exported `kafka_consumergroup_lag`,
     `kafka_consumergroup_current_offset` (both `consumergroup, topic, partition`) and
     `kafka_consumergroup_members` (`consumergroup`). `--kafka.version=4.3.1` is UNTESTED.
     Defaults: `--kafka.server=kafka:9092`, port 9308, groups without members are reported too.
   - `scripts/prometheus-rules.spec.ts`: every name an `expr` reads must be in `METRIC_NAMES`
     (after stripping `_bucket`, `_sum`, `_count`); identifiers outside `PROMQL_WORDS` count as
     series (`delta`, `and`, `on`, `sum`, `increase`, `rate`, `max` are words; `group_left`,
     `changes`, `label_replace` are not); `EXPECTED` pins the alert set and severities.
4. **Maintenance switch (read).** `MAINTENANCE_MODE` (`boolean | (() => boolean)`) is provided only
   in the root module by `provideCommonEnhancers*`, so a provider in another module that injects it
   with `@Optional()` gets `undefined`, which reads as off. `ModuleRef.get(token, { strict: false })`
   finds it across modules and throws when it is absent. Both WebSocket transports read the boot
   boolean `appConfig.maintenanceMode`. Global guards run per Socket.IO message; with
   `inheritAppConfig` they also wrap Kafka and gRPC handlers.
5. **gRPC principal (read).**
   - Only `writePrincipal` marks a principal token-verified: `JwtAuthGuard` for HTTP and GraphQL,
     and `PrincipalContextInterceptor` for Socket.IO messages and graphql-ws operations. So every
     edge path that reaches a gRPC adapter today holds a marked principal.
   - `callerContextFromCls` call sites: identity and AI pass no override, billing passes `{}`,
     notifications passes `{ userId }` (the inbox owner, the same user as the principal).
   - A verifier accepts until `exp` + 10 s. `GRPC_PRINCIPAL_ASSERTION_TTL_SEC` is 10 to 3600,
     default 120; `AI_GRPC_CHAT_DEADLINE_MS` is 1,000 to 900,000, default 70,000.
   - The refusal's `details.reason` travels in the `x-error-details-bin` trailer and the gateway
     rebuilds the exception with it, so it can reach a public 401 body. No spec asserts the string.
   - `GrpcClientOptions.methodDeadlines` exists (billing uses it); the AI adapter already applies
     `GRPC_DEADLINE_MS` locally to non-chat calls, so only the deadline sent to the server is wrong.
6. **Mail dedupe (read: BullMQ 6.3.12).** A custom `jobId` deduplicates while the job is kept: 24 h
   or the last 10,000 completed jobs. `.dlq` topics keep records 14 days
   (`docker/kafka/topics.txt`). BullMQ's own `deduplication.ttl` key is deleted when its job is
   removed (`removeDeduplicationKeyIfNeededOnRemoval`); whether the `removeOnComplete` clean-up
   takes that path is UNTESTED. `libs/mailer` does not depend on `@platform/redis`; the queue's own
   connection is `queue.client`.
7. **Ledger re-anchor (read).** `ref.postedAt` is the app clock (`post-ledger-entry.handler.ts`),
   `reanchor.at` the database clock (`created_at`). A re-anchor stores `readAt = lostFrom`, so the
   first run after it lists refs from the lost-from time; later runs list
   `min(from, readAt)`, the 72 h lookback. `readTrustedState` returns the latest re-anchor only.
8. **Citus (read).** `startTestPostgres({ workers: 1 })` (`@platform/testing/postgres`) starts a
   coordinator plus one worker with the roles on both. No int spec uses it.
9. **Tests (read).** Ten specs bind port 0, close and reuse the number; five copies of
   `withBoundGrpcPort` exist; `@platform/transport/testing` exists. Sleeps that prove an absence or
   order events remain in `apps/monolith/test/ai-stream.e2e-spec.ts`,
   `libs/outbox/test/outbox-kafka-delivery.int-spec.ts` and `libs/redis/src/redis.int-spec.ts`.
10. **CI images (probe, Trivy 0.76.2 with CI's flags).** `redis:8.10.2-alpine3.23` has 3 fixable
    HIGH findings (musl, musl-utils, zlib); `redis:8.10.3-alpine3.23` has none. Trivy's secret
    scanner flags `sk_test_placeholder` in the billing-service and monolith images; only the
    billing-service image was ever scanned for secrets on purpose.
11. **Docs anchor (read).** `#outbox-ledger-and-ai-alerts` has 12 links in 8 files outside
    `docs/superpowers`, and `scripts/docs-ai.spec.ts` pins the heading text.

## Global Constraints

- One branch per batch from `master`: `fix/followups-b1`, `fix/followups-b2`, `fix/followups-b3`; a
  batch starts when the one before it is merged and pushed. Lanes are worktrees under the session
  scratchpad, merged into the batch branch with `--no-ff -S`. At most 4 lanes run at once. Never
  `git stash` in a worktree.
- One GPG-signed commit per task, with the message the task gives (header at most 100 characters,
  body lines at most 100; every header below passed `commitlint`). A reviewed task may add one fix
  commit. No `--no-verify`. No attribution or co-author lines: this overrides the older conventions
  map. Signed commits need the sandbox off.
- Behaviour changes and bug fixes are test-first: the acceptance test fails at the base for the
  stated reason, then passes. Refactors, tests and docs get the guard or characterisation test
  named. A characterisation test that fails is a finding: stop and report it, do not bend the test.
  Where a task changes an existing assertion on purpose, it says which.
- The host is short on memory, so a lane runs scoped checks on the changed files and touched
  packages: `biome ci`, `eslint --max-warnings=0`, `prettier --check`, `tsc -p` per touched
  package, `node scripts/check-boundaries.mjs`. The whole-repo `bun run check` runs once per lane
  merge and at the batch gate.
- Vitest runs with `--maxWorkers=2`. An `:int` project runs only where a task names it, with
  `INTEGRATION=1 TEST_POSTGRES_STARTUP_TIMEOUT_MS=360000 --maxWorkers=1`, and `REDIS_URL` and
  `INTEGRATION_REDIS_URL` pointing at a throwaway Redis the main loop runs on `127.0.0.1:16399`
  (never `localhost:6379`). A container start or hook timeout under load is re-run alone before it
  counts as a failure. e2e and gRPC round-trip specs need the sandbox off.
- Docker: only containers the task starts, removed afterwards; never the developer's Postgres,
  Redis or MySQL containers or the default `boilerplate` compose project.
- No new npm dependency. One lockfile change: Task 1's int spec needs `testcontainers` (already in
  the catalog) as a dev dependency of `libs/transport`; the main loop adds it and runs
  `bun install` before lane events starts. `bun install` runs in the main loop only.
- No test calls the real OpenRouter or Stripe API.
- Mixed versions: every wire or config change must work while old and new replicas run side by
  side, and a configuration that boots today must still boot unless the task says it is refused and
  why. Each such task names its mixed-version acceptance.
- Docs and doc comments change in the same commit as the behaviour they describe. The README test
  count is refreshed by the main loop at each batch gate.
- Every alert rule that is added or changed gets a `promtool test rules` case, run with the
  `prom/prometheus:v3.15.0` image the compose file pins.
- This plan and every file it adds use repo-relative paths only (the repository is public).
- Batch gate: `bun run check`, the full `vitest run`, `bun run build`, the `:int` projects the
  batch's tasks name, and:
  - batch 1: `scripts/docker/validate-compose.sh`, `scripts/docker/check-prometheus-rules.sh`, and
    `node scripts/docker/check-topology.ts up` for `monolith` and `microservices`;
  - batch 2: both topology smokes (the microservices one runs `enforce`);
  - batch 3: `validate-compose.sh`, `check-infra.sh`, the six image builds with the Trivy scan CI
    runs, and both topology smokes.

## Review Focus

Each batch ends with one final review: `code-review high` for batches 1 and 2, `code-review medium`
for batch 3. Critical and Important findings are fixed; Minor ones are listed. One re-review at
most, scoped to the fixes. Three tasks get a review of their own (marked **review**):

- **Task 1 (Kafka delivery, covers Tasks 1 and 2):** no path lets one message's in-process work
  outlast the budget; a heartbeat rejection never dead-letters a message; the ledger consumer never
  dead-letters on a timeout; an abandoned attempt that finishes late, next to its redelivery, cannot
  double-post a ledger entry or push twice; the dead-letter path still works when the send is slow.
- **Task 15 (gRPC principal, covers Tasks 11 to 15):** identity headers leave a process only for a
  principal it verified from a token or received on the call it is serving; no override widens what
  is sent; a reused assertion always belongs to the same frozen principal and is never older than
  the reuse window; `enforce` behaves as before for every valid caller; an old gateway is never
  refused by a new verifier.
- **Task 26 (ledger verification):** the change only widens what R5 verifies; a healed ref still
  verifies; no ref that was verified before is skipped now.

The batch-2 final review looks hard at Task 18 (a bug there leaves revoked sockets open) and
Task 17 (the failure mode is a silent "off").

## Interfaces

- **Env:** no new variable.
- **Wire:**
  - The gRPC metadata keys `x-user-id`, `x-tenant-id`, `x-user-roles` and `x-staff` are sent only
    for a vouchable principal (Task 11).
  - A verifier refuses an assertion whose `exp - iat` exceeds 3600 s (Task 13).
  - The `INVALID_PRINCIPAL` refusal carries no `details.reason` (Task 13).
  - AI RPCs other than `SendMessage` and `StreamMessage` are sent with `GRPC_DEADLINE_MS`
    (Task 15).
- **New boot refusals** (defaults pass): `GRPC_PRINCIPAL_ASSERTION_TTL_SEC` minus the 5 s reuse
  window below `AI_GRPC_CHAT_DEADLINE_MS` on a signing gateway (Task 15); a secret listed twice in
  `JWT_*_VERIFY_SECRETS` (Task 20); an online migration step whose number is not its migration's
  (Task 22).
- **Kafka:** `KafkaRetryOptions.budgetMs` (40,000) and `onBudgetExceeded`
  (`'dead-letter' | 'redeliver'`, default `'dead-letter'`); the dead-letter send deadline (5,000);
  `run.autoCommitInterval` 5,000; the consumer timing constants exported from `kafka.options.ts`.
- **Metrics and alerts:** `grpc_client_circuit_breaker_events_total{upstream,event}` with `event`
  one of `success`, `failure`, `reject`; `GrpcCircuitBreakerOpen` joined on `(service, upstream)`;
  new `GrpcUpstreamFailing` (ticket) and `KafkaConsumerGroupStalled` (page); `cache_requests_total`
  labels at most 32 distinct cache names per process.
- **Compose:** service `kafka-exporter` (profile `observability`), scrape job `kafka` with
  `service="kafka"`; Redis image `redis:8.10.3-alpine3.23`.
- **Redis keys:** the mail queue's `mail-sent:<jobId>` marker, kept 14 days (Task 3).
- **Libraries:** `@platform/transport/testing` exports `withBoundGrpcPort`; `@platform/redis` gains
  a channel-subscription helper and `InMemoryRedis.pipeline()`; `@platform/common` gains
  `createCliLogger`, a run-time reader of the maintenance switch and a WebSocket maintenance guard;
  billing's `LedgerSystemRepository.readTrustedState` returns every re-anchor.
- **Tooling:** `docker/prometheus/tests/*.test.yml` and `scripts/docker/check-prometheus-rules.sh`
  (run by CI's `compose` job); the first `transport:int` spec.
- **Database:** no migration.

## Shared files

Tasks that touch the same file sit in the same lane, in order:

- `libs/transport/src/kafka/*`, the Kafka consumers, `libs/mailer/src/*`: Tasks 1 → 2 → 3 → 4
  (lane events).
- `docker/prometheus/**`, `scripts/prometheus-rules.spec.ts`, `docker-compose.yml`,
  `.github/workflows/ci.yml`, `libs/redis/src/cache/cache.service.*`: Tasks 5 → 6 → 7 → 8
  (lane obs).
- `scripts/spec-hygiene.spec.ts`, `libs/transport/src/testing/*`, the spec files of Tasks 9 and 10:
  Tasks 9 → 10 (lane tests). Task 9's guard allowlists two files that keep a chosen host port: the
  outbox Kafka int spec and Task 1's `libs/transport/test/support/kafka-container.ts`. That file
  exists only in lane events, so the main loop re-runs `scripts/spec-hygiene.spec.ts` on the batch
  branch once both lanes are merged.
- `libs/transport/src/grpc/*`, `libs/config/src/namespaces/grpc.config.ts`,
  `domains/ai/src/ai-api.module.ts` and the AI gRPC adapter: Tasks 11 → 12 → 13 → 14 → 15 → 16
  (lane mesh).
- `libs/auth/src/ws/*`, `libs/auth/src/tokens/access-token-denylist.service.ts`, the WebSocket
  entry points, `libs/redis/src/cache/cache.service.ts` (batch 2): Tasks 17 → 18 → 19 (lane ws).
- `libs/config/src/namespaces/auth.config.ts`, `domains/identity/src/testing/*`: Tasks 20 → 21
  (lane id).
- `libs/database/**`: Tasks 22 → 23 → 24 → 25 (lane db). Task 24 also edits one function in
  `libs/transport/src/kafka/dlq-replay-cli.ts` and
  `domains/billing/src/presentation/cli/ledger-reanchor-cli.ts`, and Task 25 one comment in
  `domains/billing/src/presentation/grpc/billing-grpc.controller.ts`; lane bill touches none of
  them.
- `domains/billing/src/application/**`, `domains/billing/README.md`: Tasks 26 → 27 (lane bill).
- `.github/workflows/ci.yml`, `docker-compose.yml`, `scripts/int-images.mjs`,
  `scripts/docker/assemble-image.mjs`: Tasks 28 → 29 → 30 (lane ci).
- Across lanes of one batch, only docs overlap, on different sections or tables. The main loop
  resolves those at merge time. Prettier re-pads a whole Markdown table, so two lanes never edit
  the same table.
  - Batch 1: `docs/OBSERVABILITY.md` (Task 3; Tasks 5 to 8), `libs/transport/README.md` (Task 1;
    Task 5), `docs/TESTING.md` (Tasks 1, 5 and 9: the int table, the CI scripts, the toolbox).
  - Batch 2: `docs/SECURITY.md` (Tasks 11 and 13; Task 18; Task 20), `docs/CONFIGURATION.md`
    (Tasks 15, 17 and 20), `libs/common/README.md` (Tasks 11 and 17).
  - Batch 3: `docs/CONFIGURATION.md` (Tasks 25, 27 and 29), `docs/RELEASING.md` (Tasks 25 and 28,
    and the commit of decision 1), `docs/TESTING.md` (Tasks 23 and 30).
- A new config case goes in a new spec file next to its namespace, and a new e2e case that another
  lane's suite would also need goes in a new e2e file.

## Lanes and files

| Batch | Lane   | Worktree branch  | Tasks                                                                                                                                                    |
| ----- | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | events | `lane/f1-events` | 1 Kafka budget and heartbeat (review, covers 1 and 2), 2 interim commits, 3 mail dedupe, 4 unused event                                                  |
| 1     | obs    | `lane/f1-obs`    | 5 breaker events and rules, 6 kafka-exporter, 7 cache name cap, 8 alerts heading                                                                         |
| 1     | tests  | `lane/f1-tests`  | 9 bound gRPC ports, 10 sleeps                                                                                                                            |
| 2     | mesh   | `lane/f2-mesh`   | 11 vouchable identity, 12 assertion reuse, 13 verifier, 14 settings, 15 AI deadlines and TTL check (review, covers 11 to 15), 16 enforce e2e on two hops |
| 2     | ws     | `lane/f2-ws`     | 17 maintenance over WebSockets, 18 sweeper, 19 Redis channel helper                                                                                      |
| 2     | id     | `lane/f2-id`     | 20 JWT verify list, 21 fake members port                                                                                                                 |
| 3     | db     | `lane/f3-db`     | 22 online step anchor, 23 Citus cluster int spec, 24 CLI logger, 25 docs                                                                                 |
| 3     | bill   | `lane/f3-bill`   | 26 R5 and every re-anchor (review), 27 Stripe deadline warning                                                                                           |
| 3     | ci     | `lane/f3-ci`     | 28 Redis image, 29 Stripe placeholder, 30 Ryuk image and CLI filter                                                                                      |

Mechanical tasks (9, 24, 25, 28, 30) suit a `sonnet` implementer; the others `opus`.

## Task 1: B3-6, one message's in-process work is bounded and heartbeats while it runs (**review**, covers Tasks 1 and 2)

- **Goal:** no handler, retry or dead-letter send can outlast the consumer session or delay a
  rebalance, for any consumer, without dead-lettering slow but healthy work.
- **Design:** verified point 1. A combination, because neither part works alone: a deadline alone
  forces about 3 s per attempt, and a heartbeat alone makes a hung handler invisible.
  - **Budget.** `KafkaRetryInterceptor` gives all in-process work of one message (every attempt and
    every delay) one deadline, `budgetMs`, default 40 s. When it ends, the wait is abandoned with an
    `OperationTimeoutException` that names the budget, and no further attempt starts. One total
    deadline is chosen over a per-attempt one: it makes the bound independent of the attempt
    count, and it starts no attempt that overlaps an abandoned one.
  - **Heartbeat.** While that work runs, the interceptor calls `KafkaContext.getHeartbeat()` once
    at the start and then every 3 s (the consumer's `heartbeatInterval`, exported as a constant).
    A rejection is swallowed and logged at debug; after a rebalance-type rejection the timer stops.
    kafkajs reports the rebalance itself after the message. A context without the function (a
    unit fake) skips heartbeats.
  - **Dead-letter send.** `sendToDeadLetter` waits at most 5 s. On expiry the existing branch runs:
    the original error is rethrown and the message is redelivered.
  - **Worst case.** T = 40 + 5 = 45 s per message, whatever the attempt count, the Cassandra
    timeout, the producer's retry count or BullMQ's behaviour in a Redis outage. The session
    (30 s) cannot expire: kafkajs skips a call made just under 3 s after the last heartbeat, so a
    heartbeat is at most about 6 s old. T stays 15 s below
    `rebalanceTimeout` (60 s), so a member always rejoins a rebalance in time. Today T is about
    1,000 s.
  - **What a spent budget becomes.** Default: the error reaches `KafkaDeadLetterFilter` and the
    message is dead-lettered, as a transient failure is after its retries today.
    `onBudgetExceeded: 'redeliver'` throws `KafkaRetriableException` instead.
    `LedgerPostingConsumer` sets it, because it never dead-letters an outage (verified point 1).
    A slow but successful attempt there (one Stripe request up to its 20 s timeout, then immudb
    and Postgres) fits the default budget; one that needs Stripe's SDK retries can exceed it and
    is redelivered, where today it would outlast the session. `NotificationPushConsumer` and the
    notifications consumers keep the defaults.
  - **Idempotency.** An abandoned attempt may still finish. Handlers already tolerate that: the
    notification id is derived, the mail job is deduplicated, the edge claims `push:dedupe:<id>`,
    ledger entry ids are deterministic.
  - No env knob: the existing per-controller `retry` option carries the two new fields.
  - Docs: the consumer table in `docs/PERFORMANCE.md` ("handlers must finish well within 30 s"
    becomes the budget rule), the gotcha in `libs/transport/README.md`, the ledger posting section
    of `domains/billing/README.md`, the interceptor's doc comment.
- **Files:** `libs/transport/src/kafka/kafka-retry.interceptor.ts` and spec,
  `kafka-dead-letter.filter.ts`, `dead-letter.ts` and specs, `kafka.options.ts` and spec,
  `kafka-consumer.decorator.ts`, `domains/billing/src/presentation/messaging/ledger-posting.consumer.ts`
  and spec, new `libs/transport/test/kafka-consumer-session.int-spec.ts` and
  `libs/transport/test/support/kafka-container.ts`, `libs/transport/package.json` (the dev
  dependency, by the main loop), `scripts/int-images.mjs` and its spec (the new image constant),
  `docs/PERFORMANCE.md`, `docs/TESTING.md` (the int table and "Known gaps"),
  `libs/transport/README.md`, `domains/billing/README.md`.
- **Acceptance:**
  - Unit, fake timers, each failing at the base: a handler that never settles is rejected at
    `budgetMs` (at the base the test times out) with the heartbeat called at the start and every
    3 s; the budget ending during a delay starts no further attempt; a rejecting heartbeat changes
    no outcome; a dead-letter send that never settles rethrows the original error after 5 s and
    counts `redelivery`; with `onBudgetExceeded: 'redeliver'` the spent budget is a
    `KafkaRetriableException` and nothing is dead-lettered (ledger consumer spec).
  - A spec computes, from the exported constants and for every `@KafkaConsumerController` option
    in the repo, that `budgetMs` + the dead-letter deadline + 10 s is at most `rebalanceTimeout`
    and that three heartbeat intervals fit in `sessionTimeout`.
  - Characterisation, green before and after: the existing retry, dead-letter and ledger consumer
    specs (4 attempts, the delays, what is retriable).
  - `transport:int`, a real broker and a real Nest consumer with a 10 s session: a handler that
    runs 15 s is invoked once and its offset is committed. At the base the member is evicted and
    the message is handled twice. This is the only runtime evidence for the heartbeat hook.
- **Commit:** `fix(transport,billing,docs): bound a kafka message's in-process work and heartbeat meanwhile`

## Task 2: B3-3 (first part), offsets are committed while a batch is processed

- **Goal:** the committed offset of a healthy consumer moves during a long batch, so a flat offset
  means a stalled consumer (Task 6's alert) and a crash replays less.
- **Design:** `run.autoCommitInterval: 5_000` in `createKafkaServerOptions`. kafkajs then commits
  the resolved offsets after a message once 5 s have passed since the last commit. Only resolved
  offsets are committed, so delivery stays at-least-once. No knob.
- **Files:** `libs/transport/src/kafka/kafka.options.ts` and spec,
  `libs/transport/test/kafka-consumer-session.int-spec.ts`, `docs/PERFORMANCE.md`.
- **Acceptance:** the options spec pins the value (absent at the base). `transport:int`: with four
  queued messages of 3 s each in one batch, the group's committed offset has advanced before the
  last message is handled; at the base it moves only at the end.
- **Commit:** `fix(transport,docs): commit kafka offsets every 5 s while a batch is processed`

## Task 3: B3-7, a replayed event does not send its mail again

- **Goal:** a redelivery or a dead-letter replay inside the `.dlq` retention (14 days) enqueues no
  second mail.
- **Design:** verified point 6. Task 18 of the previous plan made dead letters after a sent mail
  more likely, and replays later than 24 h are normal. For a mail with an `idempotencyKey`,
  `MailService.enqueue` checks a marker key in the queue's own Redis and key space
  (`mail-sent:<jobId>`, through `queue.client`), skips the add when it exists, and sets it for 14
  days after a successful add. Check, add, then set: a crash between add and set is covered by the
  job id for 24 h. The marker means "enqueued", so a job that ran out of attempts is not sent by a
  replay either (`MailJobsFailed` tickets on it; retry the failed job). BullMQ's
  `deduplication.ttl` was not chosen: its key appears to go with the job. Docs: the three places
  that state the 24 h and 10,000 limits.
- **Files:** `libs/mailer/src/mail.service.ts` and spec, `mailer.constants.ts`,
  `libs/mailer/README.md`, `domains/notifications/README.md`, `docs/OBSERVABILITY.md`,
  `docs/ARCHITECTURE.md`.
- **Acceptance:** unit, failing at the base: after the job was removed from the queue (the 24 h
  case), a second `enqueue` with the same key adds nothing; without a key nothing changes; a failed
  add sets no marker. `redis:int` is not needed (the queue is faked in the unit spec).
- **Commit:** `fix(mailer,docs): keep the mail dedupe for the dlq retention, not only while the job is kept`

## Task 4: B3-8, the unused domain event goes

- **Goal:** no event is raised that nothing handles, so nobody adds a second publish path to it.
- **Design:** remove `NotificationCreatedEvent`, its raise in `Notification`, and the references in
  the create command, specs and docs. The Kafka event `notifications.notification-created.v1` and
  its contract are untouched.
- **Files:** `domains/notifications/src/domain/events/notification-created.event.ts` (deleted),
  `domain/notification.entity.ts` and spec, `application/commands/create-notification/*`,
  `domains/notifications/README.md`, `docs/ARCHITECTURE.md`.
- **Acceptance:** `rg NotificationCreatedEvent` finds nothing outside `docs/superpowers`.
  Characterisation, green before and after: the notifications unit specs and the three monolith
  realtime e2e suites.
- **Commit:** `refactor(notifications,docs): drop the notification-created domain event that nothing handles`

## Task 5: B3-1 and B3-2, breaker alerts per upstream

- **Goal:** the page names the upstream that fails, an idle breaker of the same service stays
  silent, and failing calls on a path too quiet to open its breaker raise a ticket.
- **Design:** verified point 2.
  - A new counter `grpc_client_circuit_breaker_events_total{upstream, event}`, incremented in
    `GrpcCircuitBreakers.get()` from the opossum `success`, `failure` and `reject` events and set
    to 0 for the three events when the breaker is created. `grpc_client_handled_total` is not
    changed. Limit to state, not to hide: a breaker is created by its first call, so its first
    event is counted by `increase()` only when a scrape saw the zero first.
  - `GrpcCircuitBreakerOpen` (page, `for: 5m`): the state join as today, then
    `and on (service, upstream)` the summed `rate(...{event=~"reject|failure"}[2m]) > 0`. The
    failed half-open probes of sparse traffic now count. The window stays shorter than the `for`,
    so one burst followed by silence never pages. It covers traffic of at least about one call a
    minute.
  - New `GrpcUpstreamFailing` (ticket, `for: 5m`), without the state join: per
    `(service, upstream)`, at least 3 failures in 15 minutes and more failures than successes in
    the same window. It covers traffic below the breaker's volume threshold. Counts instead of a
    ratio, so one blip cannot fire it and no division by zero arises.
  - Documented limits: fewer than 3 calls in 15 minutes raise nothing; `reject` is not in the
    ticket rule (those calls never reached the upstream).
  - promtool tests are committed in `docker/prometheus/tests/platform.rules.test.yml` and run by a
    new `scripts/docker/check-prometheus-rules.sh` (`promtool check rules` and `test rules` in the
    image tag read from `docker-compose.yml`), added as a step of CI's `compose` job.
  - `scripts/prometheus-rules.spec.ts`: the counter joins `METRIC_NAMES`, `GrpcUpstreamFailing`
    joins `EXPECTED`, and the `GrpcCircuitBreakerOpen` threshold case pins the new join.
- **Files:** `libs/transport/src/grpc/grpc-circuit-breakers.ts`, `grpc-metrics.ts` and their specs,
  `docker/prometheus/rules/platform.rules.yml`, `docker/prometheus/tests/platform.rules.test.yml`,
  `scripts/docker/check-prometheus-rules.sh`, `scripts/prometheus-rules.spec.ts`,
  `.github/workflows/ci.yml`, `docs/OBSERVABILITY.md`, `docs/TESTING.md`,
  `libs/transport/README.md`.
- **Acceptance:** unit, failing at the base: a new breaker exposes the three series at 0; a
  rejected call, a failed call and a filtered caller error increment `reject`, `failure` and
  `success`. promtool cases, with the output in the commit body: a hung upstream with traffic pages
  after 5 minutes and resolves on recovery; of two upstreams of one service, an idle half-open one
  stays silent while the refusing one pages (fails with the base rule); probes failing once a
  minute page (fails with the base rule); a burst then silence never pages; 4 failures in 15
  minutes below the volume threshold raise the ticket; one failure does not.
- **Commit:** `feat(transport,docker,ci,docs): count breaker events per upstream and alert on them`

## Task 6: B3-3, a broker-side lag source and the stalled-consumer alert

- **Goal:** a consumer group whose live members stop committing while messages wait pages someone.
- **Design:** verified point 3.
  - Compose service `kafka-exporter`, `danielqsj/kafka-exporter:v1.11.0` (tag pin, as the other
    exporters), profile `observability`, network `backend`, `depends_on` a healthy `kafka`, the
    exporters' 0.25 CPU and 64M limits, no host port, so no variable and no `.env.example` line.
    `--kafka.server=kafka:9092`, and `--kafka.version` set to the broker's version if the probe in
    the acceptance shows the series with it, else `4.0.0` (probed); a comment ties it to the
    `kafka` image tag.
  - Scrape job `kafka`: target `kafka-exporter:9308`, `labels: { service: kafka }`.
  - `KafkaConsumerGroupStalled` (page, `for: 5m`): `kafka_consumergroup_lag > 0`, and on
    `(consumergroup, topic, partition)` the committed offset did not move in 10 minutes
    (`delta(...[10m]) == 0`), and on `(consumergroup)` the group has members. Task 2 makes a moving
    offset the sign of progress. It also fires for a redelivery loop, which is intended.
  - The members filter is a choice: without it a group left behind by the other topology (or a
    decommissioned one) would page for ever. The limit to document: a group with no member at all
    (the consumer is down or was evicted) fires nothing here; that is a stopped service. The
    member count is per group, not per topic: a live group that left committed offsets on a topic
    it no longer reads would page, so the runbook line says to delete those offsets.
  - The rules spec gets a second list, the exporter series, admitted only while `prometheus.yml`
    has the `kafka` job and `docker-compose.yml` the service; `EXPECTED` gains the alert.
  - Docs: the image and resource tables in `docs/DOCKER.md`; the scrape jobs, the alert table and
    the lag rule's "a follow-up" sentence in `docs/OBSERVABILITY.md`, plus one line that a
    production cluster needs the same exporter for this rule; the rule comment.
- **Files:** `docker-compose.yml`, `docker/prometheus/prometheus.yml`,
  `docker/prometheus/rules/platform.rules.yml`, `docker/prometheus/tests/platform.rules.test.yml`,
  `scripts/prometheus-rules.spec.ts`, `docs/DOCKER.md`, `docs/OBSERVABILITY.md`.
- **Acceptance:** the rules spec fails at the base (no alert, no job). promtool cases: lag with a
  flat offset and a member pages after 15 minutes; a moving offset, a group without members and a
  partition without lag stay silent. Probe, in an isolated compose project: the exporter reports
  the three series for a connected group with the chosen `--kafka.version`.
  `scripts/docker/validate-compose.sh` passes.
- **Commit:** `feat(docker,docs): add kafka-exporter and page on a consumer group that stops committing`

## Task 7: B3-4, the cache label has a hard ceiling

- **Goal:** a caller that derives a cache name from a tenant or an id cannot create a series per
  value.
- **Design:** `AppCacheService` remembers the distinct `cache` label values it has used, at most
  32 per process. A further name counts as `other` and one warning is logged. The charset rule and
  the key-prefix fallback stay. No registration API: the only shipped caller passes a constant.
- **Files:** `libs/redis/src/cache/cache.service.ts` and spec, `libs/redis/README.md`,
  `docs/OBSERVABILITY.md`.
- **Acceptance:** unit, failing at the base: the 33rd distinct name is counted under `other` and
  logged once; the first 32 keep their label.
- **Commit:** `fix(redis,docs): cap the distinct cache names the hit and miss counter can label`

## Task 8: B3-5, the alerts section is named for what it holds

- **Goal:** the heading covers all five rule files, and no existing link breaks.
- **Design:** rename `### Outbox, ledger and AI alerts` to `### Alert rules` and put
  `<a id="outbox-ledger-and-ai-alerts"></a>` above it, so the 12 links keep resolving and only two
  files change. Updating 8 files for a heading was not worth their merge conflicts.
- **Files:** `docs/OBSERVABILITY.md`, `scripts/docs-ai.spec.ts`.
- **Acceptance:** the docs spec pins the new heading and that the old anchor id is still in the
  file (the second assertion is new).
- **Commit:** `docs(docs,tooling): rename the alerts section to cover every rule file; keep the old anchor`

## Task 9: B3-10, gRPC test servers keep the port they bind

- **Goal:** no spec finds a free port, closes it and binds it again.
- **Design:** one `withBoundGrpcPort` in `@platform/transport/testing`; the five copies
  (`apps/{identity,billing,notifications,ai}-service/test/support/free-port.ts`,
  `domains/identity/test/free-port.ts`) go and their importers change. The inline helpers are
  replaced in `domains/{billing,ai,notifications}/src/presentation/grpc/*-grpc.roundtrip.spec.ts`,
  `domains/billing/src/infrastructure/adapters/grpc/billing-grpc-deadlines.roundtrip.spec.ts` and
  `libs/transport/src/grpc/{grpc-retry,grpc-tls,grpc-roundtrip}.spec.ts`. Two specs must know the
  URL before their imports: `apps/ai-service/test/principal-assertion.e2e-spec.ts` starts its
  stand-in server inside `vi.hoisted` on port 0, keeps it, and builds the environment from the
  bound port, with its own `GRPC_URL` on port 0; `apps/gateway/test/ai.e2e-spec.ts` uses the dead
  port 1 the other specs use, or the same pattern if it needs a live server. The guard in
  `scripts/spec-hygiene.spec.ts` changes from "at least five `free-port.ts`" to: exactly one
  definition of `withBoundGrpcPort`, and no spec or test helper that listens on port 0 and closes
  the listener to return its number, except the two Kafka container bootstraps (a container's
  advertised listener needs the port before it starts).
- **Files:** `libs/transport/src/testing/*`, the specs and helpers above,
  `scripts/spec-hygiene.spec.ts`, `docs/TESTING.md` (the toolbox row).
- **Acceptance:** the guard fails at the base and lists the ten files. Every touched spec passes
  three times in a row with `--maxWorkers=2` (sandbox off).
- **Commit:** `test(repo): bind grpc test servers on port 0 through one helper; guard inline free ports`

## Task 10: B3-9, the remaining absence and ordering sleeps

- **Goal:** these specs cannot pass vacuously on a slow host or fail from load alone.
- **Design:**
  - `apps/monolith/test/ai-stream.e2e-spec.ts`: the four `QUIET_MS` waits become the fence the
    realtime suites use (a later event on the same channel proves the earlier one would have
    arrived) or an awaited server-side completion; the `wait(50)` after subscribing becomes a
    sentinel publish that every subscription must receive before the mutation runs. `wait` then
    has no importer and leaves `libs/testing/src/realtime/socket-client.ts`.
  - `libs/outbox/test/outbox-kafka-delivery.int-spec.ts`: the 1 s sleep becomes a read up to the
    topic's high watermark, or the relay tick's result.
  - `libs/redis/src/redis.int-spec.ts`: the 200 ms and 100 ms sleeps become `vi.waitFor` on the
    subscriber count and on the L1 state. The TTL-expiry and redlock sleeps stay: real time must
    pass there.
  - Guard: no e2e spec defines `QUIET_MS`, `@platform/testing` exports no `wait`, and the two int
    specs join the fixed-sleep list where it applies.
- **Files:** the three specs, `libs/testing/src/realtime/socket-client.ts`,
  `scripts/spec-hygiene.spec.ts`.
- **Acceptance:** the guard fails at the base. The e2e spec passes three times in a row;
  `outbox:int` and `redis:int` pass (Docker; the throwaway Redis).
- **Commit:** `test(repo): replace the remaining absence and ordering sleeps with signals`

## Task 11: B2-5 to B2-9, caller identity leaves a process only for a principal it can vouch for

- **Goal:** what goes out in plain headers is exactly what could be signed, in every mode, so a
  future consumer or `runWithPrincipal` caller is anonymous everywhere instead of trusted under
  `off` and refused under `enforce`.
- **Design:** verified point 5. In `callerContextFromCls`, the user, tenant, roles and staff flag
  are taken only from a vouchable principal: one this process marked token-verified, or the CLS
  principal of the gRPC call being served when it names the incoming caller's user. They are
  computed once (B2-9) and used for the headers and the assertion.
  - An unmarked principal outside a gRPC call sends no identity (B2-6).
  - An override can no longer set tenant, roles or staff (B2-7), and an override `userId` that no
    vouchable principal covers is dropped. Request and correlation ids are unaffected. The four
    call sites: identity and AI pass none; billing passes `{}`; notifications passes the
    principal's own user id, so its calls are unchanged.
  - Whenever identity is dropped, one throttled warning says so without naming the user (B2-7,
    B2-8), so a lost mark on an edge with a signing key is visible locally.
  - `markTokenVerified` also requires `isPrincipal` (B2-5).
  - Mixed versions: no shipped path sends an unmarked identity (verified point 5), so old and new
    replicas put the same bytes on the wire today.
  - Specs that seed a plain `createPrincipal` at the edge and expect identity headers switch to a
    marked principal, which is what the edge holds. Docs: the Kafka consumers and overrides
    paragraphs of `libs/transport/README.md`, `libs/common/README.md`, "Known gaps" in
    `docs/SECURITY.md`.
- **Files:** `libs/transport/src/grpc/grpc-caller-context.ts` and its specs,
  `grpc-roundtrip.spec.ts`, `libs/common/src/tenancy/principal-context.ts` and spec, the adapter
  specs under `domains/*/src/infrastructure/adapters/grpc/`, `libs/transport/README.md`,
  `libs/common/README.md`, `docs/SECURITY.md`.
- **Acceptance:** unit, each failing at the base: an unmarked CLS principal outside a gRPC call
  yields no identity header and one warning; an override of tenant, roles or staff changes nothing
  that is sent; an override naming another user sends no `x-user-id`; a frozen non-principal object
  cannot be marked. Changed on purpose: the cases in `grpc-roundtrip.spec.ts`,
  `grpc-principal.spec.ts`, `grpc-principal-assertion.spec.ts` and
  `domains/ai/src/presentation/grpc/ai-grpc.roundtrip.spec.ts` that seed an unmarked edge principal
  now mark it. New, because the gateway e2e binds `FakeNotificationsPort` and so never crosses the
  one override call site: in the context `writePrincipal` leaves for a Socket.IO message, the
  notifications gRPC adapter's `markRead` sends the user, the tenant and, with a signing key, the
  assertion. Characterisation, green before and after: a service forwards the caller's identity
  and the same assertion bytes (round-trip spec); both `principal-assertion.e2e-spec.ts` files.
- **Commit:** `fix(transport,common,docs): forward caller identity only for a principal the process can vouch for`

## Task 12: B2-3, one signature per principal, not per call

- **Goal:** a GraphQL operation that fans out to N gRPC calls signs once.
- **Design:** a `WeakMap` from the marked principal object to its last assertion. A call reuses it
  while it is at most 5 s old (an exported constant), else signs again. The key is the frozen
  object the claims are computed from, so an assertion can never be served for another principal,
  and the entry dies with the request. An entry is used only with the signing key that made it, so
  a `configurePrincipalAssertions` swap (specs change keys) signs again. The age limit matters for
  a graphql-ws operation, which
  keeps one principal for hours: a reused assertion has at least TTL minus 5 s left, which Task 15
  checks against the longest deadline.
- **Files:** `libs/transport/src/grpc/grpc-caller-context.ts` and spec, `libs/transport/README.md`.
- **Acceptance:** unit, failing at the base: two calls for one principal within 5 s carry the same
  bytes and sign once; a call 6 s later carries a new assertion; an equal but distinct principal
  object gets its own.
- **Commit:** `perf(transport): reuse a principal's signed assertion for up to five seconds`

## Task 13: B2-2, B2-10 and B2-11, verifier hardening

- **Goal:** a long-lived assertion is refused, a refused caller learns nothing about why, and a
  rollout in `warn` does not log one line per call.
- **Design:**
  - `verifyPrincipalAssertion` returns `invalid` when `exp - iat` exceeds 3600 s, the maximum of
    `GRPC_PRINCIPAL_ASSERTION_TTL_SEC`, shared as one constant from `@platform/config`. No valid
    gateway, old or new, signs longer.
  - The `INVALID_PRINCIPAL` exception carries no `details.reason` (verified point 5: it can reach
    a public 401 body). The outcome stays in the verifier's log and in
    `grpc_principal_assertions_total`. See "Needs a user decision" 2.
  - The warning for an outcome other than `valid` is throttled to one line per outcome and handler
    per minute, with the number suppressed. In both modes: under `enforce` a peer could otherwise
    flood the log.
- **Files:** `libs/transport/src/grpc/grpc-principal-assertion.ts`, `grpc-principal.ts`,
  `grpc-context.interceptor.ts` and their specs, `libs/config/src/namespaces/grpc.config.ts`,
  `libs/transport/README.md`, `docs/SECURITY.md`.
- **Acceptance:** unit, failing at the base: a correctly signed assertion with a 2 h lifetime is
  `invalid`; one with 3600 s is `valid`; the refusal's details hold no reason; 100 `missing` calls
  to one handler log once and count 100. Mixed version: an assertion signed with every allowed TTL
  still verifies.
- **Commit:** `fix(transport,config,docs): cap assertion lifetime, hide the refusal reason, throttle its log`

## Task 14: B2-4, the principal keys are read once and a bad key fails the boot

- **Goal:** key files are read once per config parse, and the process-wide settings come from the
  configuration the app validated, at boot.
- **Design:** the `grpc` schema resolves the signing key and the public keys once and passes the
  result from its checks to its transform. `GrpcClientsModule` and the gRPC server bootstrap each
  hand the injected `grpcConfig` to the settings holder at module init, so a key that
  `createPrivateKey` or `createPublicKey` refuses stops the boot instead of failing the first
  call. The lazy parse from the environment stays only for code that runs without either (unit
  specs). `configurePrincipalAssertions` keeps working for tests.
- **Files:** `libs/config/src/namespaces/grpc.config.ts` and its spec file,
  `libs/transport/src/grpc/grpc-principal-assertion.ts`, `grpc-clients.module.ts`, the server
  bootstrap helper and their specs, `libs/transport/README.md`.
- **Acceptance:** unit, failing at the base: parsing the namespace with `_FILE` keys reads each
  file once (twice at the base); a module compiled with a PEM that is not a P-256 key rejects at
  init (at the base it compiles and the first call throws). Characterisation: the round-trip spec
  and both topologies' e2e suites.
- **Commit:** `fix(transport,config): read the principal keys once and build the settings at boot`

## Task 15: B2-1 and B1-3, AI deadlines per method and a TTL that covers a chat turn (**review**, covers Tasks 11 to 15)

- **Goal:** ai-service sees the right deadline for every RPC, and a gateway whose assertions would
  expire during a chat turn does not start.
- **Design:** verified point 5.
  - `AiApiModule.forRemote()` registers the channel with the default deadline and
    `methodDeadlines` for `SendMessage` and `StreamMessage` (`AI_GRPC_CHAT_DEADLINE_MS`), as
    billing does for its Stripe-backed methods.
  - `AiGrpcAdapter.onModuleInit` throws when a signing key is configured and
    `(GRPC_PRINCIPAL_ASSERTION_TTL_SEC - 5) * 1000 < AI_GRPC_CHAT_DEADLINE_MS`, naming both
    variables; 5 s is Task 12's reuse window. The 10 s verifier skew is not counted. Without a
    signing key nothing is signed and nothing is checked. Defaults pass (115 s against 70 s).
  - This is a new boot refusal for a configuration that fails late today (a tool call late in a
    turn is refused `INVALID_PRINCIPAL` under `enforce`). `docs/CONFIGURATION.md`,
    `apps/ai-service/README.md` and `libs/transport/README.md` say so.
- **Files:** `domains/ai/src/ai-api.module.ts`,
  `domains/ai/src/infrastructure/adapters/grpc/ai-grpc.adapter.ts` and spec,
  `domains/ai/src/presentation/grpc/ai-grpc.roundtrip.spec.ts`, `docs/CONFIGURATION.md`,
  `apps/ai-service/README.md`, `libs/transport/README.md`.
- **Acceptance:** round trip (sandbox off), failing at the base: the server reads a deadline of
  about `GRPC_DEADLINE_MS` for a list call and about the chat deadline for `SendMessage` (both the
  chat deadline at the base). Unit: TTL 60 with the default chat deadline rejects at init naming
  both variables; the same without a signing key starts; the defaults start.
- **Commit:** `fix(ai,docs): send per-method ai deadlines and refuse an assertion ttl below the chat deadline`

## Task 16: B2-12, the notifications and billing hops cross the wire under `enforce`

- **Goal:** each owning service's rule under `enforce` is pinned by a test that makes a real gRPC
  call, not by reading.
- **Design:** `principal-assertion.e2e-spec.ts` in both services, modelled on identity-service's,
  with Task 9's helper. Notifications: plain headers naming a `(tenant, user)` are refused
  `UNAUTHENTICATED`; the same call with a test-signed assertion reads that inbox. Billing: plain
  headers asserting a role that grants `billing:read-all` are refused; signed, they list; the
  anonymous signed webhook still passes; an expired assertion is refused.
- **Files:** new `apps/notifications-service/test/principal-assertion.e2e-spec.ts` and
  `apps/billing-service/test/principal-assertion.e2e-spec.ts`, `docs/TESTING.md`.
- **Acceptance:** both specs pass (characterisation: the code is expected to be right already).
- **Commit:** `test(notifications-service,billing-service): cross the wire under enforce on both hops`

## Task 17: B2-18 and B2-19, WebSockets follow the maintenance switch at run time

- **Goal:** a switch given as a function refuses WebSocket traffic when it turns on, as it refuses
  HTTP, without touching Kafka or gRPC handlers.
- **Design:** verified point 4.
  - **Reading it.** One helper in `@platform/common`, next to the middleware, resolves
    `MAINTENANCE_MODE` through `ModuleRef.get(…, { strict: false })` on first use and then answers
    `isMaintenanceEnabled`; a missing token reads as off (services, unit specs). Chosen over a
    global module, which would mean re-homing the token in six app modules, and over module
    options, which cannot carry a DI-built function. `NotificationsGateway` and the GraphQL
    factory use the helper instead of `appConfig.maintenanceMode`.
  - **Socket.IO.** A `WsMaintenanceGuard` (same helper; passes anything that is not `ws`) goes
    first in the gateway's own `@UseGuards` list, so every message, `ping` included, is answered
    with the 503 problem. It is gateway-scoped, not an `APP_GUARD`, so it cannot wrap a Kafka or
    gRPC handler. `pushToUser` returns without emitting while maintenance is on: it never throws,
    because it runs inside the push consumer and a throw would dead-letter the event.
  - **graphql-ws.** `onConnect` and `onSubscribe` read the helper. `onNext` during maintenance
    closes that connection with the code a refused `onConnect` uses and delivers nothing.
  - **Open sockets** are not hunted down: there is no change event and a poll is not worth a
    timer. An idle socket stays connected and inert until its next message or event, or until its
    token expires. Docs say so.
- **Files:** `libs/common/src/middlewares/` (the helper, the guard, specs, the index),
  `libs/graphql/src/graphql.module.ts`, `apollo-config.factory.ts` and spec,
  `domains/notifications/src/presentation/ws/notifications.gateway.ts` and spec,
  `apps/monolith/test/maintenance.e2e-spec.ts`, new `apps/gateway/test/maintenance.e2e-spec.ts`,
  `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `libs/common/README.md`.
- **Acceptance:** e2e in both topologies, the real `AppModule` with
  `overrideProvider(MAINTENANCE_MODE)` set to a function, failing at the base (the sockets read the
  boot boolean): with the function off, a socket and a subscription connect; after it turns on,
  `markRead` is answered 503 and writes nothing, a push reaches no socket and the push consumer's
  handler still resolves, the open subscription is closed at its next event, and new connections
  are refused. Characterisation: the existing boot-boolean cases stay green.
- **Commit:** `fix(common,graphql,notifications,docs): read the maintenance switch at run time on websockets`

## Task 18: B2-20 and B2-22, the sweeper indexes by token and closes the handshake window

- **Goal:** an announcement costs one lookup, and a token revoked between the handshake's denylist
  check and `track()` does not wait for the sweep.
- **Design:** sessions are kept in a map from jti to its sessions, used by the announcement and by
  the sweep. `track()` registers the session and then starts one `isDenied` for its jti; a denied
  one is ended at once. The order is the invariant: tracked first, then checked, so a revocation
  is seen either by the check or by the announcement. A denylist error leaves the session to the
  sweep. Cost: one more `EXISTS` per connection. `docs/SECURITY.md` drops the handshake sentence
  from "Known gaps"; the missed-announcement fallback stays.
- **Files:** `libs/auth/src/ws/revocation-sweeper.ts`, its spec and int spec, `libs/auth/README.md`,
  `docs/SECURITY.md`.
- **Acceptance:** unit, failing at the base: a jti denied before `track()` returns, with no
  announcement, is ended without a sweep; an announcement for one jti among 10,000 tracked
  sessions reads one map entry (asserted on the structure, not on time). Changed on purpose: the
  cases in `revocation-sweeper.spec.ts` that count `isDenied` calls (one per sweep, none without a
  sweep) now allow for the one check per tracked session; the gateway and graphql-ws specs that
  count calls on a fake denylist follow. Characterisation: every other sweeper, gateway and
  graphql-ws case; `auth:int` (throwaway Redis).
- **Commit:** `fix(auth,docs): index tracked sessions by jti and re-check the denylist after tracking`

## Task 19: B2-21, one channel subscription helper, and a revocation in one round trip

- **Goal:** the subscribe, listen and unlisten code exists once, and `deny()` costs one round trip.
- **Design:** `@platform/redis` exports a small helper that attaches a message listener for one
  channel to the shared subscriber connection, subscribes without awaiting (logging a failure) and
  returns its removal. `AppCacheService` and `AccessTokenDenylist` use it. `deny()` sends `SET`
  and `PUBLISH` in one pipeline and keeps today's contract: a failed `SET` throws, a failed
  `PUBLISH` is logged. `InMemoryRedis` gains `pipeline()` for the commands it already has. Mixed
  versions: the key and the message are unchanged.
- **Files:** `libs/redis/src/` (the helper, index, `testing/in-memory-redis.ts`, specs),
  `libs/redis/src/cache/cache.service.ts`, `libs/auth/src/tokens/access-token-denylist.service.ts`
  and specs, `libs/redis/README.md`.
- **Acceptance:** unit: `deny()` issues one pipeline and no separate command (two awaits at the
  base); a `SET` error rejects; a `PUBLISH` error resolves and logs. Changed on purpose: the
  denylist spec's assertions on the recorded `set` and `publish` calls and its `publish` spy read
  the pipeline instead. Characterisation, green before and after: every other denylist case, the
  cache invalidation specs, `redis:int` and `auth:int`.
- **Commit:** `refactor(redis,auth): share the channel subscription; announce a revocation in one round trip`

## Task 20: B2-13 to B2-15, the JWT verify list

- **Goal:** every issue names the entry it is about, a secret cannot hide under a second key id,
  and the refresh path has the old-replica test the access path has.
- **Design:** the known-local-secret issue of a verify-list entry names the entry position, like
  the other issues. A secret that appears twice in one list is refused in every environment
  (dropping one key id would otherwise not retire the secret); the message names both positions
  and no value. This is a new boot refusal; the variables are two days old. B2-15 is narrower than
  the inventory says: `token-issuer.service.spec.ts` already covers both refresh rotation phases,
  and only the case "a single-secret verifier of the previous version accepts a refresh token
  that carries a `kid`" is missing.
- **Files:** `libs/config/src/namespaces/auth.config.ts` and its spec file,
  `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts`,
  `token-issuer.service.spec.ts`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`.
- **Acceptance:** unit, failing at the base: a production config with a known local secret as
  entry 2 reports "entry 2"; `k1:S,k2:S` is refused naming entries 1 and 2. The refresh
  old-replica case passes at the base (characterisation).
- **Commit:** `fix(config,identity): name the verify-list entry, refuse a repeated secret; pin refresh rotation`

## Task 21: B2-16 and B2-17, the fake members port answers as the handler does

- **Goal:** a gateway e2e that passes against the fake would pass against the real service, and
  one test runs the real chain for a withheld member.
- **Design:** `FakeMembersPort.listMembers` follows `ListMembersHandler`: no principal is the
  handler's 401 `PRINCIPAL_MISSING`, a principal of the tenant without a membership is refused as
  the handler refuses it, and a staff switch-in takes its roles from the token. The fake's spec
  seeds a display name that differs from the email, so a leak through the name would show. One
  contract spec runs the same cases against the handler (in-memory tenancy) and the fake. For the
  chain, the identity gRPC round-trip spec gains a case: `ListMembers` through the real controller
  and the gateway's gRPC adapter and REST mapper returns `null` email and roles for a withheld
  member.
- **Files:** `domains/identity/src/testing/fake-tenancy-ports.ts` and spec, a new contract spec
  beside it, `domains/identity/src/presentation/grpc/identity-grpc.roundtrip.spec.ts`,
  `domains/identity/README.md`.
- **Acceptance:** the contract spec fails at the base on the missing principal and the staff
  cases. The round-trip case passes at the base (characterisation). The gateway tenancy e2e suites
  stay green.
- **Commit:** `test(identity): make the fake members port answer as the handler does; cross grpc once`

## Task 22: B1-5, an online step's number must be its migration's

- **Goal:** a hand-edited journal cannot make an online step run after the wrong migration.
- **Design:** `migration-files.ts` also requires the numeric prefix of `entries[anchor].tag` to
  equal the step's number, and fails naming the step and the tag. All 15 journals satisfy it.
- **Files:** `libs/database/src/migrator/migration-files.ts` and spec, `libs/database/README.md`.
- **Acceptance:** unit, failing at the base: a fixture journal whose second entry is tagged
  `0005_x` with an online step `0001_y.sql` is refused; the repo's own sets load.
- **Commit:** `fix(database): refuse an online step whose anchor is not its migration's number`

## Task 23: B1-7 and B1-8, lock waits and online steps on a coordinator plus worker

- **Goal:** the three sentences marked UNTESTED in `libs/database/README.md` are replaced by a
  spec.
- **Design:** verified point 8. A new `libs/database/test/citus-cluster.int-spec.ts` on
  `startTestPostgres({ workers: 1 })`:
  - a blocker held on a worker shard only makes the run fail with 55P03 within seconds and apply
    once the blocker commits during the backoff;
  - an online `CREATE INDEX CONCURRENTLY` on a distributed table waits out a blocker on the worker
    with the online timeout at 0, ends valid on the shards, and a new worker connection shows the
    role default back at the run's value afterwards;
  - a failed online build on a distributed table is dropped and retried by the next run (B1-8).
    The single-node form of this case also goes into `citus.int-spec.ts`.
  - Cost: two Citus containers of an image CI already pulls, started in parallel; expected one to
    three minutes in CI's integration job (30-minute limit). Locally the image is emulated, so only
    the main loop runs it, alone. See "Needs a user decision" 3.
- **Files:** `libs/database/test/citus-cluster.int-spec.ts`, `libs/database/test/citus.int-spec.ts`,
  `libs/database/README.md`, `docs/TESTING.md`.
- **Acceptance:** `database:int`, both files. These are characterisation tests of shipped
  behaviour: a failure is a finding to report, and its fix is its own commit. The commit body
  records the cluster spec's duration.
- **Commit:** `test(database,docs): cover lock waits and online steps on a citus coordinator plus worker`

## Task 24: B1-4, one logger factory for the one-off CLIs

- **Goal:** the JSON-or-pretty `ConsoleLogger` choice is written once.
- **Design:** `createCliLogger(context, pretty)` in `@platform/common`; the migrate, dead-letter
  replay and ledger re-anchor CLIs call it and lose their copies. Output is unchanged. All three
  packages already depend on `@platform/common`.
- **Files:** `libs/common/src/` (the factory, index, spec),
  `libs/database/src/migrator/cli-logger.ts` and its callers,
  `libs/transport/src/kafka/dlq-replay-cli.ts`,
  `domains/billing/src/presentation/cli/ledger-reanchor-cli.ts`.
- **Acceptance:** characterisation, green before and after: the three CLI specs. Unit: JSON
  without colours by default, colours when `pretty`.
- **Commit:** `refactor(common,database,transport,billing): share the one-off cli logger`

## Task 25: B1-9, B1-10 and B1-14, three docs corrections

- **Goal:** the docs state the boot-time migration budget, the `lock_timeout` precedence and who
  calls the services.
- **Design:**
  - B1-9: `libs/database/README.md` and `docs/RELEASING.md` say that boot-time migrations
    (`DATABASE_RUN_MIGRATIONS`) give up after the 5-minute advisory-lock wait while a long online
    build holds the lock, so long online steps belong in the release job.
  - B1-10: `docs/CONFIGURATION.md` says the per-database `lock_timeout` setting of the role takes
    precedence when there is one, as the library README does.
  - B1-14: "only the gateway" becomes "the gateway and ai-service" in
    `apps/identity-service/README.md`, the comment in `billing-grpc.controller.ts` and
    `docs/DEVELOPMENT.md`.
- **Files:** those six files, `scripts/docs-audit.spec.ts`.
- **Acceptance:** docs spec cases, failing at the base: no doc or source comment says "only the
  gateway calls it" or "only the gateway … can reach this port"; `libs/database/README.md` names
  the 5-minute budget next to `DATABASE_RUN_MIGRATIONS`.
- **Commit:** `docs(repo,billing): migration lock budget, lock_timeout precedence and the grpc callers`

## Task 26: B1-11 and B1-12, R5 honours every re-anchor (**review**)

- **Goal:** a ref lost in an earlier restore and still unhealed keeps being verified, and
  reported, after a second re-anchor.
- **Design:** verified point 7. Fix rather than keep the documented limit: the change is small and
  can only add verifications. `readTrustedState` returns every re-anchor of the database (one row
  per restore), and a ref is from a lost history when the existing rule holds for any of them. A
  healed ref still matches and still verifies by entry id and payload hash, as today.
  - What stays, and is documented in `domains/billing/README.md` and `docs/OPERATIONS.md` (B1-11,
    checked in the code, no code change): (a) the rule compares the app clock (`posted_at`) with
    the database clock (the re-anchor row), so stop the posting consumers before a restore and a
    re-anchor; (b) a lost-history ref is verified on every run that lists it, by design; (c) only
    the first run after a re-anchor lists from the lost-from time, later runs list the 72 h
    lookback, so an older unhealed ref is reported by that first run and then only kept as its
    stored finding. The sentence "R5 honours only the latest re-anchor" goes.
- **Files:** `domains/billing/src/application/repositories/ledger.system-repository.ts`,
  `infrastructure/persistence/drizzle-ledger.system-repository.ts`,
  `application/commands/reconcile-ledger/checks/r5-verification.ts` and spec (the only reader of
  the field), `domains/billing/src/testing/in-memory-ledger-store.ts`,
  `domains/billing/test/ledger-reanchor.int-spec.ts`, `domains/billing/README.md`,
  `docs/OPERATIONS.md`.
- **Acceptance:** R5 spec, failing at the base: with two re-anchors, a ref posted before the first
  whose tx id is below the second's state is verified and reported `verification_failed`; at the
  base it is skipped. Characterisation, green before and after: every existing R5 case.
  `billing:int`: two re-anchors through the system method are both returned, and the existing
  re-anchor journey stays green.
- **Commit:** `fix(billing,docs): verify lost-history refs against every re-anchor, not only the latest`

## Task 27: B1-2, a Stripe deadline below the default is reported

- **Goal:** an operator who sets `BILLING_GRPC_STRIPE_DEADLINE_MS` below `GRPC_DEADLINE_MS` sees
  it at boot.
- **Design:** the billing gRPC adapter logs one warning at module init naming both variables and
  values. A warning, not a refusal: the setting is odd but works, and a configuration that boots
  today must still boot. `docs/CONFIGURATION.md` states the expectation.
- **Files:** `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts` and spec,
  `docs/CONFIGURATION.md`.
- **Acceptance:** unit, failing at the base: 2,000 against 5,000 logs the warning once; the
  defaults log nothing.
- **Commit:** `fix(billing,docs): warn when the stripe grpc deadline is below the default deadline`

## Task 28: B3-12, Redis 8.10.3

- **Goal:** no pinned Redis image has a fixable HIGH finding.
- **Design:** verified point 10. Every pin moves from `8.10.2-alpine3.23` to `8.10.3-alpine3.23`:
  `.github/workflows/ci.yml` (the integration job's service), `docker-compose.yml` (three places),
  `scripts/docker/check-infra.sh`, `scripts/docker/check-topology.ts`,
  `libs/outbox/test/outbox-relay.int-spec.ts`, and the rows in `docs/DOCKER.md` and
  `docs/RELEASING.md`. No image gate is added for third-party images: an upstream CVE would turn
  CI red with nothing in the repo to fix. The 8.12 line is out of scope.
- **Files:** those files.
- **Acceptance:** `rg --hidden '8\.10\.2'` finds nothing outside `docs/superpowers`. Trivy 0.76.2
  with CI's flags reports 0 on the new tag (output in the commit body). `redis:int` and
  `outbox:int` pass on it; `validate-compose.sh` passes.
- **Commit:** `build(docker,ci,docs): bump redis to 8.10.3-alpine3.23`

## Task 29: B3-13, a Stripe placeholder the secret scanner does not flag

- **Goal:** the images hold nothing Trivy's secret scanner reports, so CI can scan for secrets.
- **Design:** `PLACEHOLDER_STRIPE_SECRET_KEY` gets a value that still matches the schema's
  `^(sk|rk)_(test|live)_` pattern and `KNOWN_LOCAL_SECRET` (so production still refuses it twice)
  and that Trivy 0.76.2 does not flag. The value is chosen by a probe, not from memory: scan a file
  holding each candidate with `--scanners secret`. `.env.example`, `docs/CONFIGURATION.md`,
  `docs/API.md` and the specs follow. Turning the scanner on in CI is "Needs a user decision" 1 and
  a commit of its own.
  - Mixed versions: the old value `sk_test_placeholder` stays refused in production exactly as
    today, `ALLOW_KNOWN_LOCAL_SECRETS=true` included (the exact-match placeholder check covers both
    the old and the new value), so an environment that copied the old default is still refused.
- **Files:** `domains/billing/src/infrastructure/stripe/stripe.config.ts` and spec,
  `libs/config/src/env/production-guards.spec.ts`, `.env.example`, `docs/CONFIGURATION.md`,
  `docs/API.md`.
- **Acceptance:** the probe output for the chosen value and for the old one is in the commit body.
  Unit: the new placeholder is the development default, is refused in production, and
  `isKnownLocalSecret` is true for it; the old value is refused in production with and without
  `ALLOW_KNOWN_LOCAL_SECRETS`. At the gate: a record-only secret scan of all six images.
- **Commit:** `fix(billing,config,docs): use a stripe placeholder the secret scanner does not flag`

## Task 30: B3-11 and B1-13, the Ryuk image variable and CLIs named `*-test`

- **Goal:** the pre-pull list follows `RYUK_CONTAINER_IMAGE` when it is set, and a CLI called
  `load-test.ts` ships in its image.
- **Design:** `scripts/int-images.mjs` prints `RYUK_CONTAINER_IMAGE` when it is set and non-empty,
  else the library default, as testcontainers resolves it. The CLI filter in
  `scripts/docker/assemble-image.mjs` excludes only the repo's spec suffixes (`.d.ts`, `.spec.ts`,
  `.test.ts`, `.int-spec.ts`, `.e2e-spec.ts`), not every name ending in `-test` or `-spec`.
- **Files:** `scripts/int-images.mjs` and spec, `scripts/docker/assemble-image.mjs` and spec,
  `docs/TESTING.md`.
- **Acceptance:** spec cases, failing at the base: with the variable set, the list and `--names`
  show its value; an app with `src/cli/load-test.ts` gets `dist/cli/load-test.js` among its
  entrypoints, and `src/cli/x.spec.ts` gets none.
- **Commit:** `fix(tooling,docker): honour RYUK_CONTAINER_IMAGE in int-images; ship clis named *-test`

## Decided: no change

- **B1-1** (`ObservabilityModule.forRoot` parses app config at module definition): by design, and
  the comment says why. Terminus takes the drain delay when the module is defined.
- **B1-6** (bookkeeping reads outside the 55P03 retry): only a migrator locks a bookkeeping table,
  and the reader holds the same advisory lock. A lock timeout there means a foreign session locked
  the table, which a retry would not fix; the run fails with a clear error and is run again.
- **B3-14** (specs read private fields by name; the realtime revocation tests accept a close
  within 20 s): accepted. A positive control guards the first, and the 20 s is a hang bound, not
  the assertion.
- **B3-15** (`redis-store.util.spec.ts` stubs a private method of `@keyv/redis`): accepted. A
  rename makes `vi.spyOn` throw, so it fails loudly at the next upgrade.
- **B3-16** (billing README's key-rule prose): nothing to do, the public contract is unchanged.

## Needs a user decision

Each has a default, and the plan proceeds on it unless the user says otherwise. No other task
depends on the answers.

1. **Secret scanning of the images in CI (after Task 29).** Options: (a) set
   `scanners: vuln,secret` in the image job, with `scripts/ci-gates.spec.ts` and
   `docs/RELEASING.md`, if the record-only scan of all six images at the batch-3 gate is clean;
   (b) keep `scanners: vuln`. Default and recommendation: (a), as
   `ci(ci,docs): scan the images for secrets too`. If any image is not clean, stay on (b) and
   report the findings.
2. **The refusal reason (Task 13).** Removing `details.reason` changes what a refused caller, and
   through the gateway possibly an API client, reads in a 401. Options: (a) remove it; (b) keep it.
   Default and recommendation: (a). The outcome is in the service's log and counter, and no client
   can rely on a string that only a misconfigured or hostile peer triggers.
3. **The Citus cluster spec in CI (Task 23).** Options: (a) part of `database:int`, so every CI
   run pays one to three minutes; (b) skipped unless `CITUS_CLUSTER=1`, run by hand before a
   release that changes the migrator. Default and recommendation: (a); switch to (b) if the first
   CI run shows more than three minutes.
4. **New refusals at start.** Task 15 (assertion TTL below the chat deadline on a signing gateway)
   and Task 20 (a secret listed twice in a verify list) stop a process that boots today. Task 22
   refuses a migration set only when its journal was edited by hand; every set in the repo passes.
   Default and recommendation: refuse. Each configuration is broken in a way that otherwise shows
   up late, and the defaults pass. The alternative is a warning, as Task 27 uses.

## Coverage

| Item  | Where                   | Item  | Where   | Item  | Where               |
| ----- | ----------------------- | ----- | ------- | ----- | ------------------- |
| B1-1  | no change               | B2-1  | Task 15 | B3-1  | Task 5              |
| B1-2  | Task 27                 | B2-2  | Task 13 | B3-2  | Task 5              |
| B1-3  | Task 15                 | B2-3  | Task 12 | B3-3  | Tasks 2 and 6       |
| B1-4  | Task 24                 | B2-4  | Task 14 | B3-4  | Task 7              |
| B1-5  | Task 22                 | B2-5  | Task 11 | B3-5  | Task 8              |
| B1-6  | no change               | B2-6  | Task 11 | B3-6  | Task 1              |
| B1-7  | Task 23, decision 3     | B2-7  | Task 11 | B3-7  | Task 3              |
| B1-8  | Task 23                 | B2-8  | Task 11 | B3-8  | Task 4              |
| B1-9  | Task 25                 | B2-9  | Task 11 | B3-9  | Task 10             |
| B1-10 | Task 25                 | B2-10 | Task 13 | B3-10 | Task 9              |
| B1-11 | Task 26 (docs, no code) | B2-11 | Task 13 | B3-11 | Task 30             |
| B1-12 | Task 26                 | B2-12 | Task 16 | B3-12 | Task 28             |
| B1-13 | Task 30                 | B2-13 | Task 20 | B3-13 | Task 29, decision 1 |
| B1-14 | Task 25                 | B2-14 | Task 20 | B3-14 | no change           |
|       |                         | B2-15 | Task 20 | B3-15 | no change           |
|       |                         | B2-16 | Task 21 | B3-16 | no change           |
|       |                         | B2-17 | Task 21 |       |                     |
|       |                         | B2-18 | Task 17 |       |                     |
|       |                         | B2-19 | Task 17 |       |                     |
|       |                         | B2-20 | Task 18 |       |                     |
|       |                         | B2-21 | Task 19 |       |                     |
|       |                         | B2-22 | Task 18 |       |                     |

52 items: 14 + 22 + 16. 47 in tasks, 5 no change.
