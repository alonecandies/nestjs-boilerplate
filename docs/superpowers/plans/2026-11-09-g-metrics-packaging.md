# G Metrics and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Executive summary

- Scope: G-11 (domain `./api` entries + barrel clean-up; merges FU-2, B1FU-1, B1FU-2), G-12 (assemble-image file
  tracing + specs; B1FU-7), G-4 (`/metrics` on `METRICS_PORT` 9464), G-5..G-8 (gRPC, breaker, Kafka, DB pool
  metrics), AUDIT-F28 and the G-13 docs for these. Out of scope: G-1..G-3 (outbox), G-9, G-10.
- 11 tasks in two lanes. Lane P (packaging): Tasks 1-5. Lane M (metrics): Tasks 6-10. Task 11 (docs) after both.
- **Tasks 1-4 (all of G-11) must merge before B2 executes**, in order, each green on `bun run check`: the shared
  import tracer + `scripts/check-api-subpaths.mjs` guard, identity `./api`, the other three domains' `./api`
  (the guard then runs with `--require-all`), the libs `./testing` subpaths. B2 imports against the "Target export
  map", unchanged by the 2026-11-09 review (one clarifying note: lane C's rate-limit config namespaces go in `./api`).
- Decisions (controller-ruled): every domain gets `./api` → `src/api/index.ts`; the root re-exports it plus core,
  persistence, commands, queries and domain types; the gateway's `src/` imports a domain only via `@domain/<x>/api`.
  `XApiModule.forLocal()` no longer imports `XCoreModule`; the monolith imports the three Core modules itself.
  `TokenIssuer` → `@domain/identity/testing`; `PasswordHasher`, `DEV_JWT_REFRESH_SECRET`, `MAX_PASSWORD_LENGTH` leave
  every public entry; `FakeKafkaProducer`, `makeAuthUser`, `InMemoryStorageService` move to `@platform/<lib>/testing`.
- G-12: `assemble-image.mjs` traces `main.js`, `instrument.js`, `migrate.js` (workspace `dist/` file by file through
  the `exports` maps, third-party by manifest closure), deletes the rest, keeps non-JS assets of traced packages and
  load-checks `dist/app.module.js`. Escape hatch `--build-arg TRACE_FILES=false`.
- G-4: a `node:http` listener on `METRICS_PORT` (9464; host dev 9464 monolith/gateway, 9465 identity, 9466
  notifications, 9467 billing); `listenMetrics(app)` in every `main.ts`; the cluster primary serves the worker
  aggregate; the API port answers 404 for `/metrics`; `PrometheusModule` is replaced by our default-metrics collector.
- Metric names (contract for G-9/G-10 and dashboards): `grpc_{client,server}_handled_total{grpc_service,
grpc_method,grpc_code}`, `grpc_{client,server}_handling_seconds{grpc_service,grpc_method}` (`grpc_service` = the
  fully qualified proto service, e.g. `billing.v1.BillingService`; Task 7 normalizes billing's adapter),
  `grpc_client_circuit_breaker_state{upstream,state}`, `kafka_consumer_messages_total{topic,outcome}`,
  `kafka_consumer_retries_total{topic}`, `kafka_consumer_lag{group,topic,partition}` (from `END_BATCH_PROCESS`),
  `db_pool_connections_in_use{pool}`, `db_pool_operations_waiting{pool}`, `db_pool_connections_max{pool}`
  (`PoolUsage` counts operations; B3-10 adds `pool="system"`). Helpers: `getOrCreateCounter/Gauge/Histogram`.
- Review (review:g, 2026-11-10, see "Plan review"): Task 1's scripts re-run on the repo and on a lane-C
  tree with Tasks 2-3 applied (`API subpaths OK (4/4)`), commitlint on all 11 messages, anchors re-checked
  at `13030b0`. Fixed: `docs/TESTING.md` and two lib READMEs still naming the old double import paths (and missing from Task 4's
  `git add`); three stale "Api imports Core" comments (Task 3); the cluster primary now refuses
  `METRICS_PORT == PORT` (Task 6); the `grpcCall` `operation` convention (Task 7); the shared-files rows for
  lane C (executed, unmerged), E's unmerged tail, L-7 and the READMEs. Third-pass fixes kept (four forgotten
  specs, two lint failures, the vocabulary literals). Target export map unchanged.
- No new dependencies, no `bun install`. Commits: one GPG-signed commit per task, no attribution lines.
- Needs Docker or the sandbox off: image measurement and traced-image boot (Task 5), the pool int spec (Task 10),
  e2e and every spec that binds 127.0.0.1.

## Global Constraints

- **Node:** prefix every command (tooling, tests, `git commit`) with
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;` (the shell starts on Node
  20, where the pre-commit hook fails to load `lint-staged.config.ts`).
- **Branches:** lane worktrees under the session scratchpad (never inside the repo), branched off
  `feat/domains-tenancy`: Lane P `g-pack`, Lane M `g-metrics`. The controller merges each lane with
  `git merge --no-ff -S` and subject `chore(repo): merge <branch> — <summary>`; it predicts conflicts with
  `git merge-tree --write-tree feat/domains-tenancy <branch>` first. Never push, never open a PR.
- **Commits:** one GPG-signed commit per task (`git commit -S`), never `--no-verify`, **no attribution lines** (no
  `Co-Authored-By`; this overrides `conventions.md:536-537` and the B1 plan). Header `<type>(<scopes>): <subject>`
  ≤ 100 chars, subject starts lower-case, no trailing period; body lines ≤ 100. Types: `build chore ci docs feat fix
perf refactor revert style test`. Scopes used here (all valid at `9600510`): `identity`, `billing`,
  `notifications`, `files`, `monolith`, `gateway`, `identity-service`, `notifications-service`, `billing-service`,
  `auth`, `storage`, `transport`, `observability`, `bootstrap`, `config`, `database`, `docker`, `tooling`, `repo`,
  `docs`. `scripts`, `g`, `metrics` are NOT scopes. Pre-check: `printf '%s\n' "<header>" | npx commitlint`.
- **Search:** `rg` and `fd` (never `grep`/`find`); `jaq` for JSON (never `jq`).
- **Tests:** one project: `npx vitest run --project <name> <file filter>` (projects are folder names: `identity`,
  `billing`, `notifications`, `files`, `transport`, `observability`, `bootstrap`, `config`, `database`, `auth`,
  `storage`, `monolith`, `gateway`, `scripts`; e2e: `<app>:e2e`). Int specs: `INTEGRATION=1 npx vitest run --project
database:int <filter>`. Full run `bun run test` with the sandbox off (e2e, gRPC and the metrics listener bind
  127.0.0.1). Gate before every commit: `bun run check` (biome ci, eslint `--max-warnings=0`, prettier, tsc,
  boundaries, and after Task 1 the api-subpath check). Env drift: `node scripts/check-env-example.mjs`.
- **Formatting:** after editing TypeScript or `.mjs` run `npx biome check --write <files>` (it also orders exports);
  after Markdown/YAML run `npx prettier --write <files>`. Line numbers in this plan are hints: match the quoted text.
  This plan file is itself Prettier-formatted (`prettier --check .` covers it), which re-indents fragments of
  indented code to column 0: when a block replaces or inserts code inside a function, keep the indentation the file
  has at that spot.
- **Layering** (`scripts/check-boundaries.mjs`): `apps → domains → contracts → libs`; a domain imports another domain
  only via `@domain/<y>-contracts`; `libs/` names no domain; `@<scope>/<pkg>/testing` and `@platform/testing` are
  importable only from test code (`*.spec.ts`, `test/**`, `src/testing/**`).
- **Env:** every new key of a scanned namespace (`libs/config/src/namespaces/*.config.ts`) appears in the root
  `.env.example` above `# docker compose ONLY` as `KEY=` or `# KEY=`; each app's `.env.example` is pinned by its
  `test/env-example.spec.ts`.
- **Dependencies:** none added. Every import used here is already declared (`prom-client`, `@willsoto/nestjs-prometheus`
  in `@platform/observability`; `kafkajs`, `@nestjs/microservices`, `opossum`, `lodash-es`, `rxjs` in
  `@platform/transport`; `postgres`, `@testcontainers/postgresql` (dev) in `@platform/database`). Packages call
  `prom-client` only through `@platform/observability` helpers (Task 7), so no manifest changes. No `bun install`.
- **Metrics naming:** Prometheus base units (`_seconds`, `_total`), snake_case labels, no `service` label
  (Prometheus adds the target identity; `libs/observability/src/metrics/metrics.module.ts:27-28`). Metrics created
  outside DI go through `getOrCreateCounter/Gauge/Histogram` (prom-client's global registry rejects duplicates).
- **Docker:** never touch the developer's containers or the `boilerplate` compose project. Image builds in Task 5 use
  tags `g12-<app>:before` / `g12-<app>:after`; remove them afterwards with `docker image rm`.

## Review Focus

The five input classes most likely to bite users that no task's happy-path tests exercise, and the test that now
covers each:

1. **`METRICS_PORT` collisions.** `METRICS_PORT` equal to `PORT`, two host-dev apps on the same metrics port, or a
   port already in use must fail the boot loudly, not silently serve nothing. Tests: Task 6
   `metrics-listener.spec.ts` ("refuses METRICS_PORT equal to PORT", "rejects when the port is taken") and the
   per-app `.env.example` pins (9464-9467).
2. **Scrapes that must not be answered.** Missing/wrong bearer token, a different path, `POST`, a query string, or
   `METRICS_ENABLED=false` must all answer 404 (the listener reveals nothing), and a throwing collector 500. Tests:
   Task 6 `metrics-server.spec.ts`.
3. **`./api` graph regressions from B2.** A new export that drags a core module, handler, persistence, Stripe or
   security file into `./api`, including through a dynamic `import()`, a multi-line import or a re-export, while
   comments and `import type` must not count. Tests: Task 1 `scripts/check-api-subpaths.spec.ts` fixtures.
4. **`forLocal()` without its Core module.** After Task 2/3 `XApiModule.forLocal()` no longer imports
   `XCoreModule`; an app that forgets it boots but every command fails at runtime. Tests: Task 2/3 monolith e2e
   "imports every Core module" and the `forLocal()` assertions in each `api-surface.spec.ts`.
5. **Traced images missing a runtime file.** Non-JS assets (`.proto`, `.sql`, `.hbs`, `.cql`, migration `meta/`),
   packages loaded by string (`createRequire(...).resolve('pino-pretty')`), optional peers (`@nestjs/core` →
   `@nestjs/microservices`), nested `node_modules` versions, and computed specifiers. Tests: Task 5
   `assemble-image.spec.ts` (assets, `.resolve()`, peers, nested, the load check failing on a computed import).

## Lane and files

**Lane P (packaging, branch `g-pack`)** owns exclusively:
`scripts/docker/trace-imports.mjs`, `scripts/check-api-subpaths.mjs`, `scripts/check-api-subpaths.spec.ts`,
`scripts/docker/assemble-image.mjs`, `scripts/docker/assemble-image.spec.ts`, `domains/*/src/api/**`,
`domains/*/src/index.ts`, `domains/*/src/*-api.module.ts`, `domains/*/package.json` (exports only),
`domains/identity/src/testing/**`, `domains/{identity,billing,notifications}/src/*{api,modules}.module.spec.ts`,
`libs/transport/src/testing/**`, `libs/storage/src/testing/index.ts`, `libs/auth/src/testing/index.ts`,
`libs/{transport,storage,auth}/package.json` (exports only), `libs/{auth,storage}/src/index.ts`,
`apps/gateway/src/**`, `apps/gateway/test/support/gateway-e2e-app.ts`, `apps/monolith/test/support/**`, domain and
lib READMEs it touches, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`,
`docs/superpowers/plans/2026-11-09-g-metrics-packaging/artifacts/**`.

**Lane M (metrics, branch `g-metrics`)** owns exclusively: `libs/observability/src/metrics/**`,
`libs/observability/src/index.ts`, `libs/observability/src/observability.module.spec.ts`,
`libs/observability/README.md`, `libs/config/src/namespaces/observability.config.ts` (+ spec),
`libs/config/src/namespaces/namespaces.spec.ts` (the observability defaults only),
`libs/bootstrap/src/**`, `libs/transport/src/grpc/**`, `libs/transport/src/kafka/{kafka-metrics,instrumented-server-kafka,kafka-context.interceptor,kafka-retry.interceptor,kafka-dead-letter.filter,kafka.options}*.ts`,
`libs/transport/src/hybrid/**`, `libs/database/src/**`, `libs/database/test/pool-usage.int-spec.ts`,
`libs/database/README.md`, `libs/transport/README.md` (its new metrics rows; Task 4 edits the `:41` cell), `docker/prometheus/prometheus.yml`, `docs/OBSERVABILITY.md`,
`docs/CONFIGURATION.md`, and one line of `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts`
(Task 7, `grpc_service` normalization; Lane P does not touch that file).

**Shared files** (exact change per task; the controller predicts conflicts with `merge-tree` first). Other lanes:
C = `2026-11-09-c-rate-limiting.md`, E = `2026-11-09-e-tests-ci-wave1.md`, S = `2026-11-09-s-sharding-wave0.md`,
L = `2026-11-09-ledger-wave0.md`. Whoever merges second resolves as stated in the last column.

| File                                                                                                                                 | G task                     | G change                                                                                                                                                                          | Other lanes, merge rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root `package.json`                                                                                                                  | 1, 3                       | `check` script: Task 1 appends `&& node scripts/check-api-subpaths.mjs`; Task 3 adds `--require-all`                                                                              | C (catalog), E (`db:check`, `proto:breaking` scripts), S, L edit other keys: no overlap; keep every lane's keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bun.lock`                                                                                                                           | —                          | unchanged (no dependency changes)                                                                                                                                                 | C, E, S, L regenerate it: controller runs `bun install` after each of their merges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Dockerfile`                                                                                                                         | 5                          | `assemble` stage: second COPY source, `ARG TRACE_FILES=true`, `--trace` / `--verify-load` flags                                                                                   | none known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/monolith/src/app.module.ts`                                                                                                    | 2, 3                       | `@domain/*` import lines (`:1-9`); doc-comment line `:51` (Task 2); the "Bounded contexts" block (Core modules before Api modules)                                                | C3 adds `IpThrottlerModule` (redis import, module list) and rewrites comment `:47-50`, which ends with ``(their `Api` ``; G rewrites only `:51`. Adjacent lines conflict in git: keep C3's `:47-50` and G's `:51`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/gateway/src/app.module.ts`, `apps/gateway/src/graphql/payment-user.resolver.ts`                                                | 2, 3                       | `@domain/<x>` → `@domain/<x>/api` (`:1-4`, `:1-2`)                                                                                                                                | C3 adds `IpThrottlerModule` (`:36-38`, `:51`): different hunks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `domains/identity/src/identity-api.module.ts`                                                                                        | 2                          | drop `IdentityCoreModule` (import + `forLocal` `imports`), doc comment                                                                                                            | C2 adds `IdentityRateLimitModule` to both `imports:` arrays: result `forLocal` → `[GraphqlLoadersModule, IdentityRateLimitModule]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `domains/notifications/src/notifications-api.module.ts`                                                                              | 3                          | drop `NotificationsCoreModule` (import + `forLocal` `imports`), doc comment                                                                                                       | C1 adds `NotificationsRateLimitModule`: result `forLocal` → `imports: [NotificationsRateLimitModule]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `domains/{identity,notifications,billing,files}/src/index.ts`, `domains/*/src/api/index.ts`, `domains/*/src/api/api-surface.spec.ts` | 2, 3                       | root rewritten (`export * from './api/index.js'` + root-only); `./api` entries and their exact-surface specs created                                                              | C1-C3 are executed on `lane/c-w1` (`8c22b9c`, `93ed074`, `c566f08`), not merged: C1 appends `notificationsRateLimitConfig` / `type NotificationsRateLimitConfig` to the notifications root, C2 appends `identityRateLimitConfig` / `type IdentityRateLimitConfig` to the identity root. L (L-8a/b, L-9) appends billing exports. G after C: Task 2 Step 4 / Task 3 Step 4 move each into `src/api/index.ts` (edge config, placement rule) and add the value name to `API_VALUES`. C after G: git reports a conflict (G rewrote the whole root, C appended at its end); the resolver keeps G's root, adds the C export block to `src/api/index.ts` of that domain (not the root) and appends `identityRateLimitConfig` / `notificationsRateLimitConfig` to `API_VALUES` of the matching `api-surface.spec.ts`, which pins the exact `./api` surface |
| `domains/billing/package.json`                                                                                                       | 3                          | `exports["./api"]` after `"."`                                                                                                                                                    | L-8b adds `exports["./testing"]`, L-8a/L-9 deps; E `db:check`; S devDeps. Key order `.`, `./api`, `./testing`, `./package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `domains/identity/package.json`                                                                                                      | 2                          | `exports["./api"]` between `"."` and `"./testing"`                                                                                                                                | E `db:check` script; S devDeps: different keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `libs/storage/package.json`                                                                                                          | 4                          | `exports["./testing"]`                                                                                                                                                            | E Task 7 (lane `e-storage`) adds the `testcontainers` devDependency: different keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts`                                                           | 7                          | `:103` operation → `${BILLING_GRPC_PACKAGE.package}.${BILLING_SERVICE_NAME}/${method}`                                                                                            | B2 billing tasks may edit the adapter: keep the normalized operation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `domains/billing/src/billing-core.module.ts`                                                                                         | 3                          | class doc comment (`:18-20`, "monolith via `BillingApiModule.forLocal()`")                                                                                                        | L-7 adds two `makeCounterProvider` entries to `providers` (`:39-43`): different hunks; keep both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `domains/billing/README.md`, `domains/notifications/README.md`                                                                       | 3                          | billing `:26`, `:72`, notifications `:31`, `:73`; an "Entry points:" paragraph below each module table                                                                            | C edits billing `:102`, `:323` (`@SkipRateLimit`); L edits billing `:106`, `:196` and adds a "Ledger (immudb)" section: different hunks; keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `libs/storage/README.md`, `libs/transport/README.md`                                                                                 | 4 (and 7, 9 for transport) | Task 4 (lane P): the `InMemoryStorageService` / `FakeKafkaProducer` first cells name their `./testing` subpath; Tasks 7, 9 (lane M): new transport metrics rows in the same table | G P and G M touch the same transport table: whoever merges second keeps both (predict with `merge-tree`). E Task 7 (lane `e-storage`) adds a testing paragraph at the end of `libs/storage/README.md`: keep both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/*/src/main.ts` (5)                                                                                                             | 6                          | `await listenMetrics(app);` before `await listen(app);`; service comments                                                                                                         | none known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/{identity,notifications,billing}-service/src/app.module.ts`                                                                    | 6                          | doc comment: `/metrics` is on `METRICS_PORT`                                                                                                                                      | none known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/*/test/app.e2e-spec.ts` (5)                                                                                                    | 2, 3, 4, 6                 | Tasks 2/3: monolith Core-import test; Task 4: `FakeKafkaProducer` import; Task 6: `/metrics` tests                                                                                | C adds separate `rate-limit.e2e-spec.ts` files: no overlap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/*/test/support/*`                                                                                                              | 2, 4                       | Task 2 `gateway-e2e-app.ts` `TokenIssuer` import; Task 4 test-double imports                                                                                                      | C edits `apps/{gateway,monolith}/test/support/e2e-env.ts`: different files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `libs/bootstrap/src/integration.smoke.spec.ts`                                                                                       | 6                          | import + the two `/metrics` assertions (`:211-225`, `:385`)                                                                                                                       | C edits its rate-limiting block (`:56-128`, `:366-375`): adjacent to `:385`; keep both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `libs/transport/src/index.ts`                                                                                                        | 4, 7, 9                    | Task 4 deletes the last line (`fake-kafka-producer`); Task 7 inserts two `grpc/` lines; Task 9 two `kafka/` lines (alphabetical, never at the end)                                | none known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `libs/transport/src/hybrid/connect-microservices.spec.ts`                                                                            | 9                          | Kafka assertions on `strategy.kafkaOptions`                                                                                                                                       | E Task 2 (merged at `13030b0`) already renamed its literals to `alerts-service`; G's blocks use them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `libs/config/src/namespaces/namespaces.spec.ts`                                                                                      | 6                          | `metricsPort: 9464` in the "observability" `toEqual` (`:50-58`)                                                                                                                   | C1 adds the `throttleConfig` import and assertion, E Task 2 (merged) reworded the stripe test, L adds immudb: other hunks; keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `libs/bootstrap/src/http/create-http-app.spec.ts`                                                                                    | 6                          | `MetricsListener` import, `GET /v1/ping/large` route, three metrics tests                                                                                                         | none known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `libs/transport/src/grpc/grpc-enhancers.spec.ts`                                                                                     | 7                          | `GrpcMetricsInterceptor` in the controller-scope interceptor expectation                                                                                                          | E Task 2 (merged) renamed literals in other tests: no overlap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `libs/database/src/database.module.spec.ts`                                                                                          | 10                         | `getOrCreateGauge` stub in the `@platform/observability` mock (`:30`)                                                                                                             | none known (S Task 1 moves int specs, not this unit spec)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docker/prometheus/prometheus.yml`                                                                                                   | 6                          | header comment, `nestjs-apps` port 9464, `host-apps` targets 9464-9467 and comment                                                                                                | L-6 appends job `immudb` after `jaeger`: different hunk; keep both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `libs/database/package.json`, `libs/database/test/*`                                                                                 | 10                         | new `test/pool-usage.int-spec.ts`                                                                                                                                                 | S Task 1 swaps the devDependency to `@platform/testing` and moves int specs to `startTestPostgres()`; Task 10 Step 5 has both variants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `.env.example`                                                                                                                       | 6                          | `# METRICS_PORT=9464` block after `# METRICS_BEARER_TOKEN=`                                                                                                                       | C, E, S, L add other keys and sections: keep all; run `node scripts/check-env-example.mjs` after each merge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/*/.env.example`, `apps/*/test/env-example.spec.ts`                                                                             | 6                          | `METRICS_PORT=946x` after `PORT=`; one `metricsPort` assertion                                                                                                                    | C edits the gateway/monolith env-example specs' imports: different lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docker-compose.yml`                                                                                                                 | 6                          | `x-env-base`: `METRICS_PORT: "9464"` (`:35`)                                                                                                                                      | S (Citus postgres, PgBouncer), L (immudb), E: other services; keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs/OBSERVABILITY.md`                                                                                                              | 6-10                       | metrics port, exported series, follow-ups                                                                                                                                         | E Task 8 adds an upstream re-check note: different section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/CONFIGURATION.md`                                                                                                              | 6                          | `METRICS_PORT` row                                                                                                                                                                | C, L add rows; E (`lane/e-ci` after `5419e7b`, unmerged: `271eb91`, `61f9744`) rewrites env-checker notes: keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/DOCKER.md`, `docs/SECURITY.md`, `docs/PERFORMANCE.md`                                                                          | 11                         | metrics port, traced images                                                                                                                                                       | C, S, L edit other sections (spec §16 serializes `docs/DOCKER.md` across S and L): keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/TESTING.md`                                                                                                                    | 4, 11                      | Task 4: the import-path cells of the `FakeKafkaProducer`, `InMemoryStorageService`, `makeAuthUser` rows (`:91-93`); Task 11: toolbox / int-spec rows                              | E (`lane/e-ci`, unmerged) edits `:43` and adds a section after `:232`; C, S, L edit other sections: keep all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `README.md`                                                                                                                          | 3, 11                      | `:229` topology row; `:63` test count                                                                                                                                             | E Task 8 also rewrites the `:63` count: the later merge recounts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`                                                                                        | 3                          | `./api` entry points, Core wiring                                                                                                                                                 | C (`ARCHITECTURE.md:386`), E, S (DEVELOPMENT) edit other lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Target export map

Interface contract for B2's planners (copied verbatim into `interfaceContracts`). After Task 4, every entry point is
exactly this. "Root" means the package's `.` export; **the root re-exports everything in `./api`** (`export * from
'./api/index.js'`), so any symbol listed under `./api` can also be imported from the root. Apps that must stay small
(the gateway) import only `./api`. Types are marked `type`.

Placement rule for new symbols (B2 and later): presentation (controllers, resolvers, models, DTOs, WS gateways,
push consumers), ports, local and remote adapters, `*-grpc-client.config.ts` namespaces and edge constants →
`src/api/index.ts`; commands, queries, handlers, domain aggregates/events/errors, persistence (schema, migrations,
repositories), Core/Grpc/Messaging modules, security services, domain config namespaces → root `src/index.ts` only;
in-memory fakes and test signers → `src/testing/index.ts`. A file reachable from `src/api/index.ts` must never
import a root-only file (`node scripts/check-api-subpaths.mjs --require-all` enforces it).

Lane C's edge config namespaces follow the rule: `notificationsRateLimitConfig` / `type
NotificationsRateLimitConfig` (C1) and `identityRateLimitConfig` / `type IdentityRateLimitConfig` (C2) belong in
their domain's `./api` (and so also on the root), whichever of G and C merges second.

### `@domain/identity`

- `./api` (`src/api/index.ts`): `AuthPort`, `UsersPort`, `IdentityApiModule` (`forLocal()`, `forRemote(options?)`),
  `IDENTITY_LIMITS`, `IdentityErrorCode`, `USER_CACHE_TTL_MS`, `USERS_LOADER`, `userCacheKey`,
  `type IdentityGrpcClientConfig`, `identityGrpcClientConfig`, `identityGrpcClientEnvSchema`, `AuthPayloadModel`,
  `UserModel`, `UserConnectionModel`, `RoleEnum`, `UsersLoaderRegistrar`, `UserResponse`.
- root only: `LoginCommand`, `LogoutCommand`, `PurgeExpiredSessionsCommand`, `RefreshSessionCommand`,
  `RegisterUserCommand`, `UpdateUserRolesCommand`, `type NewSession`, `type RotateSessionInput`,
  `type SessionRecord`, `SessionsRepository`, `TransactionRunner`, `type ListUsersCriteria`, `type UserRecord`,
  `UsersRepository`, `GetUserByIdQuery`, `GetUsersByIdsQuery`, `ListUsersQuery`, `normalizeEmail`,
  `UserRegisteredEvent`, `UserRolesChangedEvent`, `CannotRemoveLastAdminException`,
  `CannotRevokeOwnAdminRoleException`, `EmailAlreadyTakenException`, `InvalidCredentialsException`,
  `InvalidRefreshTokenException`, `InvalidRolesException`, `InvalidUserException`,
  `RefreshTokenReuseDetectedException`, `SessionExpiredException`, `UserAggregate`, `type UserSnapshot`, `isUserRole`,
  `USER_ROLES`, `type UserRole`, `IDENTITY_COMMAND_HANDLERS`, `IDENTITY_EVENT_HANDLERS`, `IDENTITY_QUERY_HANDLERS`,
  `IdentityCoreModule`, `IdentityGrpcModule`, `identityMigrations`, `type IdentitySchema`, `identitySchema`,
  `sessions`, `sessionsRelations`, `userRole`, `users`, `usersRelations`, `type PasswordConfig`, `passwordConfig`,
  `type RefreshTokenConfig`, `refreshTokenConfig`.
- removed from every entry point: `PasswordHasher`, `DEV_JWT_REFRESH_SECRET`, `MAX_PASSWORD_LENGTH` (internal to
  identity; import them relatively inside the package).
- `./testing` (`src/testing/index.ts`): everything from `./fake-identity-ports.js` and `./in-memory-identity.js`
  (unchanged: `FakeIdentityState`, `FakeAuthPort`, `FakeUsersPort`, `createInMemoryIdentityPersistence` and their
  types) plus `TokenIssuer`.

### `@domain/billing`

- `./api`: `BillingPort`, `BillingApiModule` (`forLocal()`, `forRemote()`), `BILLING_GRPC_UPSTREAM`, `BILLING_LIMITS`,
  `BillingErrorCode`, `IDEMPOTENCY_KEY_PATTERN`, `STRIPE_SIGNATURE_HEADER`, `BILLING_LOG_REDACT_PATHS`,
  `isPaymentStatus`, `PAYMENT_STATUSES`, `PaymentStatus`, `BillingGrpcAdapter`, `normalizePayment`,
  `type BillingGrpcClientConfig`, `billingGrpcClientConfig`, `billingGrpcClientEnvSchema`, `BillingLocalAdapter`,
  `BillingResolver`, `CheckoutSessionModel`, `PaymentConnectionModel`, `PaymentModel`, `PaymentStatusGraphqlEnum`,
  `toPaymentConnectionModel`, `toPaymentModel`, `BillingController`.
- root only: `CreateCheckoutSessionCommand`, `HandleStripeWebhookCommand`, `ListPaymentsQuery`, `toPaymentContract`,
  `toPaymentListContract`, `PAID_WITHOUT_CURRENCY_METRIC`, `PURGE_STRIPE_EVENTS_BATCH_SIZE`,
  `PURGE_STRIPE_EVENTS_LOCK`, `PURGE_STRIPE_EVENTS_LOCK_TTL_MS`, `STRIPE_EVENTS_RETENTION_DAYS`, `BillingCoreModule`,
  `BillingGrpcModule`, `BillingGrpcController`, `CheckoutSessionMismatchException`, `CheckoutUrlMissingException`,
  `IdempotencyKeyReusedException`, `InvalidPaymentException`, `PaymentConcurrentlyModifiedException`,
  `PaymentNotFoundException`, `PaymentSucceededEvent`, `Payment`, `type CheckoutCompletion`,
  `type CheckoutSessionDetails`, `type InitiatePaymentProps`, `type PaymentSnapshot`, `normalizeCurrency`,
  `billingMigrations`, `type BillingSchema`, `billingSchema`, `type PaymentRow`, `paymentStatusEnum`, `payments`,
  `type StripeEventRow`, `stripeEvents`, `PLACEHOLDER_STRIPE_SECRET_KEY`, `PLACEHOLDER_STRIPE_WEBHOOK_SECRET`,
  `type StripeConfig`, `stripeConfig`, `stripeEnvSchema`, `InjectStripe`, `STRIPE_APP_INFO`, `STRIPE_CLIENT`,
  `STRIPE_WEBHOOK_TOLERANCE_SEC`, `toPaymentDomainException`, `StripeModule`, `createStripeClient`, `StripeService`,
  `type StripeCheckoutSessionInput`.
- no `./testing` (billing's fakes stay in `domains/billing/test/billing-test.utils.ts`).

### `@domain/notifications`

- `./api`: `NotificationsPort`, `type NotificationsGrpcClientConfig`, `notificationsGrpcClientConfig`,
  `notificationsGrpcClientEnvSchema`, `NotificationsGrpcAdapter`, `NotificationsLocalAdapter`,
  `DEFAULT_NOTIFICATIONS_PAGE_SIZE`, `MAX_NOTIFICATIONS_PAGE_SIZE`, `NOTIFICATION_CREATED_TRIGGER`,
  `NOTIFICATIONS_WS_EVENTS`, `NOTIFICATIONS_WS_NAMESPACE`, `notificationCreatedTrigger`, `PAGE_STATE_MAX_LENGTH`,
  `PAGE_STATE_PATTERN`, `userRoom`, `NotificationsApiModule` (`forLocal()`, `forRemote()`),
  `NotificationConnectionModel`, `NotificationModel`, `NotificationTypeEnum`, `isOwnNotification`,
  `NotificationsResolver`, `toCreatedNotificationModel`, `toNotificationConnection`, `NotificationsController`,
  `type ListNotificationsQueryParams`, `listNotificationsQuerySchema`, `type NotificationPageResponse`,
  `type NotificationResponse`, `notificationIdParamSchema`, `notificationPageResponseSchema`,
  `notificationResponseSchema`, `toNotificationPageResponse`, `toNotificationResponse`, `NotificationPushConsumer`,
  `PUSH_DEDUPE_TTL_SEC`, `NotificationsGateway`, `type NotificationsNamespace`, `type NotificationsSocket`,
  `type NotificationsSocketData`, `WS_REVOCATION_SWEEP_INTERVAL_MS`.
- root only: `CreateNotificationCommand`, `type CreateNotificationInput`, `MarkNotificationReadCommand`,
  `PublishNotificationCreatedCommand`, `SendDailyDigestCommand`, `type SendDailyDigestOptions`,
  `type DailyDigestResult`, `SendPaymentReceiptCommand`, `type SendPaymentReceiptInput`, `WelcomeUserCommand`,
  `type WelcomeUserInput`, `type DailyDigestMailContext`, `type DigestItem`, `NOTIFICATIONS_MAIL_TEMPLATES`,
  `type NotificationsMailContextMap`, `type NotificationsMailTemplate`, `type PaymentReceiptMailContext`,
  `type WelcomeMailContext`, `defineNotificationsMail`, `KIND_BY_TYPE`, `notificationFromCreatedPayload`,
  `toNotificationContract`, `toNotificationCreatedPayload`, `toNotificationPage`, `type NotificationRecipient`,
  `NotificationRecipientsRepository`, `type NotificationRecipientsSlice`, `NotificationsRepository`,
  `type NotificationsSlice`, `ListNotificationsQuery`, `NotificationCreatedEvent`, `NotificationEntity`,
  `InvalidNotificationException`, `NotificationNotFoundException`, `NOTIFICATION_BODY_MAX_LENGTH`,
  `NOTIFICATION_DATA_MAX_ENTRIES`, `NOTIFICATION_KINDS`, `NOTIFICATION_TITLE_MAX_LENGTH`,
  `type NewNotificationProps`, `type NotificationKind`, `type NotificationProps`, `isNotificationKind`,
  `deriveNotificationId`, `NOTIFICATIONS_MAIL_TEMPLATES_DIR`, `NOTIFICATIONS_TTL_SEC`,
  `notificationsCassandraMigrations`, `DAILY_DIGEST_CRON`, `DAILY_DIGEST_JOB_NAME`, `DAILY_DIGEST_LOCK`,
  `DAILY_DIGEST_LOCK_TTL_MS`, `DIGEST_CONCURRENCY`, `DIGEST_ITEMS_PER_MAIL`, `DIGEST_MAX_RECIPIENTS`,
  `DIGEST_RECIPIENTS_PAGE_SIZE`, `DIGEST_SCAN_PER_USER`, `NOTIFICATIONS_COMMAND_HANDLERS`,
  `NOTIFICATIONS_QUERY_HANDLERS`, `NotificationsCoreModule`, `NotificationsGrpcModule`, `NotificationsMessagingModule`.
- `./testing`: unchanged (`export * from './fake-notifications-port.js'`: `FakeNotificationsPort`).

### `@domain/files`

- `./api`: `type FilesConfig`, `filesConfig`, `filesEnvSchema`, `FilesModule`.
- root only: every other current export, unchanged: `ALLOWED_UPLOAD_CONTENT_TYPES`,
  `ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN`, `type AllowedUploadContentType`, `type CreatePresignedUploadBody`,
  `CreatePresignedUploadBodySchema`, `CreateUploadUrlInput`, `type DownloadUrlResponse`, `DownloadUrlResponseSchema`,
  `type FileAccess`, `FileAccessDeniedException`, `type FileActor`, `type FileDownloadUrl`, `type FileKeyQuery`,
  `FileKeyQuerySchema`, `FileNotFoundException`, `FileTooLargeException`, `type FileUploadUrl`, `FilesController`,
  `FilesErrorCode`, `FilesResolver`, `FilesService`, `MAX_FILENAME_LENGTH`, `MAX_PRESIGNED_UPLOAD_BYTES`,
  `PresignedUploadHeaderModel`, `PresignedUploadModel`, `type PresignedUploadResponse`,
  `PresignedUploadResponseSchema`, `UPLOADED_BY_METADATA_KEY`, `UPLOAD_FILE_FIELD`, `UPLOAD_RETRY_AFTER_SEC`,
  `USER_FILES_ROOT`, `UnsupportedFileTypeException`, `UploadCapacityExceededException`, `type UploadFileParams`,
  `type UploadUrlParams`, `type UploadedFile`, `type UploadedFileResponse`, `UploadedFileResponseSchema`,
  `assertAllowedContentType`, `buildUserFileKey`, `filenameOfFileKey`, `isAllowedContentType`, `isFileKeyOwnedBy`,
  `isValidFileKey`, `normalizeContentType`, `resolveFileAccess`, `userFilesPrefix`.
- no `./testing` (`src/testing/files-test-app.test.ts` stays a non-collected helper).

### Contracts packages

`@domain/identity-contracts`, `@domain/billing-contracts`, `@domain/notifications-contracts`: **unchanged** — root
`.` only, no subpaths; contracts are already the minimal cross-domain surface.

### Libs touched by G-11

- `@platform/transport`: root loses `FakeKafkaProducer` and `type PublishedKafkaRecord`; new `./testing`
  (`src/testing/index.ts`) exports exactly those two. Everything else unchanged.
- `@platform/auth`: root loses `makeAuthUser`; `./testing` exports `signTestAccessToken`,
  `type SignTestAccessTokenOptions`, `makeAuthUser`.
- `@platform/storage`: root loses `InMemoryStorageService`, `type InMemoryObject`, `type InMemoryStorageOptions`;
  new `./testing` (`src/testing/index.ts`) exports exactly those three. `StorageModule.forRootAsync({ driver:
'memory' })` keeps working (it imports the class relatively).

### Subpath manifest shape (every new subpath)

```json
"./api": {
  "@repo/source": "./src/api/index.ts",
  "types": "./src/api/index.ts",
  "default": "./dist/api/index.js"
}
```

(`./testing` entries use `./src/testing/index.ts` / `./dist/testing/index.js`; key order in `exports`: `.`, `./api`,
`./testing`, `./package.json`.)

## Tasks

### Task 1: Shared import tracer and the `./api` subpath check (G-11, part 1)

**Files:**

- Create: `scripts/docker/trace-imports.mjs`
- Create: `scripts/check-api-subpaths.mjs`
- Test: `scripts/check-api-subpaths.spec.ts`
- Modify: `package.json` (root) — the `check` script

**Interfaces:**

- Consumes: nothing new.
- Produces (pure Node ESM, no dependencies; types as JSDoc):
  - `collectSpecifiers(code: string): string[]` — unique module specifiers of static `import`/`export … from`,
    side-effect `import 'x'`, `import('x')`, `require('x')`, `require.resolve('x')` and `createRequire(…).resolve('x')`
    with string-literal arguments; comments and `import type` / `export type … from` statements are ignored.
  - `packageNameOf(specifier: string): string | undefined` — `'@a/b/c'` → `'@a/b'`, `'x/y'` → `'x'`; `undefined`
    for relative, absolute, `#` and Node builtin specifiers.
  - `traceImports(entries: string[], resolveFile: (specifier: string, fromFile: string) => string | undefined,
readFile?: (file: string) => string): { files: string[]; externals: Map<string, string>; unresolved:
{ file: string; specifier: string }[] }`.
  - CLI `node scripts/check-api-subpaths.mjs [--root <dir>] [--require-all]`: exit 0 and
    `API subpaths OK (<n>/<m> domains export ./api; gateway imports domains only through ./api).`, else exit 1 and
    `API subpath check failed:` plus one `  - <problem>` line each.

**Wave:** start now (Lane P). Must merge before B2.

- [ ] **Step 1: Write the failing spec.** Create `scripts/check-api-subpaths.spec.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'check-api-subpaths.mjs');
const REPO_ROOT = join(import.meta.dirname, '..');

type Tree = Record<string, string | object>;
const roots: string[] = [];

function repo(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), 'check-api-subpaths-'));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function check(root: string, ...flags: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...flags], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const API_EXPORT = {
  '@repo/source': './src/api/index.ts',
  types: './src/api/index.ts',
  default: './dist/api/index.js',
};

const manifest = (withApi = true) => ({
  name: '@domain/orders',
  exports: {
    '.': { '@repo/source': './src/index.ts', types: './src/index.ts', default: './dist/index.js' },
    ...(withApi ? { './api': API_EXPORT } : {}),
    './package.json': './package.json',
  },
});

/** A domain whose ./api reaches only presentation and ports. */
const CLEAN: Tree = {
  'domains/orders/package.json': manifest(),
  'domains/orders/src/api/index.ts': [
    "export { OrdersPort } from '../application/ports/orders.port.js';",
    "export { OrdersController } from '../presentation/http/orders.controller.js';",
    '',
  ].join('\n'),
  'domains/orders/src/application/ports/orders.port.ts': 'export abstract class OrdersPort {}\n',
  'domains/orders/src/presentation/http/orders.controller.ts': [
    "import { Controller } from '@nestjs/common';",
    "import type { OrderRow } from '../../infrastructure/persistence/orders.schema.js';",
    "// import { OrdersCoreModule } from '../../orders-core.module.js';",
    "/* import { x } from '../../infrastructure/persistence/orders.schema.js'; */",
    "import { OrdersPort } from '../../application/ports/orders.port.js';",
    'export type Row = OrderRow;',
    '@Controller() export class OrdersController { constructor(readonly port: OrdersPort) {} }',
    '',
  ].join('\n'),
  'domains/orders/src/infrastructure/persistence/orders.schema.ts':
    "import { pgTable } from 'drizzle-orm/pg-core';\nexport type OrderRow = object;\nexport const t = pgTable;\n",
  'domains/orders/src/orders-core.module.ts': 'export class OrdersCoreModule {}\n',
  'apps/gateway/src/app.module.ts': [
    "import { OrdersController } from '@domain/orders/api';",
    "import { ORDERS_PACKAGE } from '@domain/orders-contracts';",
    'export const x = [OrdersController, ORDERS_PACKAGE];',
    '',
  ].join('\n'),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-api-subpaths', () => {
  it('passes a clean ./api graph (comments and import type do not count)', () => {
    const { status, output } = check(repo(CLEAN));
    expect(output).toContain('API subpaths OK (1/1 domains export ./api');
    expect(status).toBe(0);
  });

  it('fails when ./api re-exports a core module', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts':
          "export { OrdersCoreModule } from '../orders-core.module.js';\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      '@domain/orders: ./api reaches a core module (src/orders-core.module.ts)',
    );
  });

  it('fails on a dynamic import of persistence and names the forbidden package', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts':
          "export const load = () => import('../infrastructure/persistence/orders.schema.js');\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      './api reaches persistence (src/infrastructure/persistence/orders.schema.ts)',
    );
    expect(output).toContain('./api imports drizzle-orm');
  });

  it('fails on a multi-line value import of a handler', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'domains/orders/src/api/index.ts': [
          'import {',
          '  PlaceOrderHandler,',
          "} from '../application/commands/place-order/place-order.handler.js';",
          'export const h = PlaceOrderHandler;',
          '',
        ].join('\n'),
        'domains/orders/src/application/commands/place-order/place-order.handler.ts':
          'export class PlaceOrderHandler {}\n',
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain('./api reaches a command/query/event handler');
  });

  it('reports an unresolvable relative import', () => {
    const { status, output } = check(
      repo({ ...CLEAN, 'domains/orders/src/api/index.ts': "export * from '../missing.js';\n" }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      "unresolved import '../missing.js' in domains/orders/src/api/index.ts",
    );
  });

  it('fails on a malformed ./api export', () => {
    const bad = manifest();
    bad.exports['./api'] = { ...API_EXPORT, default: './dist/api.js' };
    const { status, output } = check(repo({ ...CLEAN, 'domains/orders/package.json': bad }));
    expect(status).toBe(1);
    expect(output).toContain('@domain/orders: exports["./api"] must be');
  });

  it('fails when the gateway imports a domain root', () => {
    const { status, output } = check(
      repo({
        ...CLEAN,
        'apps/gateway/src/graphql/x.resolver.ts':
          "import { OrdersPort } from '@domain/orders';\nexport const p = OrdersPort;\n",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain(
      'apps/gateway: apps/gateway/src/graphql/x.resolver.ts imports @domain/orders; use @domain/orders/api',
    );
  });

  it('only flags a missing ./api with --require-all', () => {
    const root = repo({ ...CLEAN, 'domains/orders/package.json': manifest(false) });
    expect(check(root).output).toContain('API subpaths OK (0/1 domains export ./api');
    const strict = check(root, '--require-all');
    expect(strict.status).toBe(1);
    expect(strict.output).toContain('@domain/orders: package.json declares no "./api" export');
  });

  it('passes on this repository', () => {
    const { status, output } = check(REPO_ROOT);
    expect(output).toContain('API subpaths OK');
    expect(status).toBe(0);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts check-api-subpaths` — Expected: FAIL (every test: the
      script does not exist, `Cannot find module …/check-api-subpaths.mjs`).

- [ ] **Step 3: Write the tracer.** Create `scripts/docker/trace-imports.mjs`:

```js
// Static import tracer shared by scripts/check-api-subpaths.mjs (TypeScript sources) and
// scripts/docker/assemble-image.mjs (compiled dist/). Pure Node, no dependencies: the Dockerfile runs
// it on the toolchain image before anything is installed globally.
//
// It reads specifiers with regular expressions, not a parser. That is enough for our own code (Biome-
// formatted sources and swc output): string-literal specifiers only; template literals and computed
// `import(x)` are invisible (assemble-image's load check catches those). Comment stripping is
// lexical too: a `/*` inside a string (a glob such as '/*.js') hides the code up to the next `*/`.
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// `//` not preceded by `:` (URLs), a quote or a backslash.
const LINE_COMMENT = /(^|[^:'"`\\])\/\/.*$/gm;
// `import type …` / `export type … from …`: erased by the compiler, never loaded.
const TYPE_ONLY = /(^|[;\n])\s*(?:import|export)\s+type\s[^;]*?\bfrom\s*(['"])[^'"\n]+\2\s*;?/g;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*|\)\.resolve\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Unique module specifiers of one JS/TS source, in order of appearance. */
export function collectSpecifiers(code) {
  const stripped = code
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '$1')
    .replace(TYPE_ONLY, '$1');
  return [...new Set([...stripped.matchAll(SPECIFIER)].map((match) => match[2]))];
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`; undefined for relative and builtin specifiers. */
export function packageNameOf(specifier) {
  if (/^[./#]/.test(specifier) || isBuiltin(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Follows imports from `entries` (absolute paths). `resolveFile(specifier, fromFile)` returns the absolute
 * file a specifier loads, or undefined when the specifier leaves the traced tree. Bare specifiers that
 * are not followed are collected by package name in `externals` (name → first importing file);
 * relative specifiers that resolve to nothing are reported in `unresolved`.
 */
export function traceImports(
  entries,
  resolveFile,
  readFile = (file) => readFileSync(file, 'utf8'),
) {
  const files = new Set();
  const externals = new Map();
  const unresolved = [];
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of collectSpecifiers(readFile(file))) {
      const target = resolveFile(specifier, file);
      if (target !== undefined) {
        pending.push(target);
        continue;
      }
      if (specifier.startsWith('.')) {
        unresolved.push({ file, specifier });
        continue;
      }
      const name = packageNameOf(specifier);
      if (name !== undefined && !externals.has(name)) externals.set(name, file);
    }
  }
  return { files: [...files].sort(), externals, unresolved };
}
```

- [ ] **Step 4: Write the check.** Create `scripts/check-api-subpaths.mjs`:

```js
// Verifies each domain's `./api` subpath (program spec §12 "Gateway image"):
//  1. a domain that declares exports["./api"] points it at src/api/index.ts (source) and
//     dist/api/index.js (build), and its import graph (type-only imports excluded) reaches no core,
//     gRPC-server or messaging module, handler, relay, cron, persistence, Stripe or security file, and
//     imports no persistence, scheduling, mail, JWT-signing or hashing package;
//  2. the gateway's src/ imports a domain only as `@domain/<x>/api` (or its `-contracts` package),
//     so G-12's file tracing ships the gateway without core and persistence code.
// --require-all: a domain without "./api" is an error too.
//
//   node scripts/check-api-subpaths.mjs [--root <repo>] [--require-all]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectSpecifiers, traceImports } from './docker/trace-imports.mjs';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    'require-all': { type: 'boolean', default: false },
  },
});
const root = resolve(args.root);

/** Files an ./api graph must never reach (path relative to the package's src/). */
const FORBIDDEN_FILES = [
  [/(?:^|\/)[^/]+-core\.module\.ts$/, 'a core module'],
  [/(?:^|\/)[^/]+-grpc\.module\.ts$/, 'a gRPC server module'],
  [/(?:^|\/)[^/]+-messaging\.module\.ts$/, 'a messaging module'],
  [/\.handler\.ts$/, 'a command/query/event handler'],
  [/\.relay\.ts$/, 'an event relay'],
  [/\.cron\.ts$/, 'a scheduled job'],
  [/^infrastructure\/persistence\//, 'persistence'],
  [/^infrastructure\/stripe\//, 'the Stripe adapter'],
  [/^infrastructure\/security\//, 'password hashing or token issuance'],
  [/^presentation\/grpc\//, 'a gRPC server controller'],
];
/** Packages an ./api graph must never import. */
const FORBIDDEN_PACKAGES = new Set([
  '@nestjs/jwt',
  '@nestjs/schedule',
  '@node-rs/argon2',
  '@platform/cassandra',
  '@platform/database',
  '@platform/mailer',
  'cassandra-driver',
  'drizzle-orm',
  'postgres',
  'stripe',
]);
/** Apps that reach domains only through ./api (the image-size contract of G-12). */
const API_ONLY_APPS = ['gateway'];
const API_EXPORT = {
  '@repo/source': './src/api/index.ts',
  types: './src/api/index.ts',
  default: './dist/api/index.js',
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const posix = (path) => path.split('\\').join('/');
const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** NodeNext source layout: `./x.js` is `./x.ts` on disk; bare specifiers are not followed. */
function resolveSource(specifier, fromFile) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, join(base, 'index.ts')];
  return candidates.find(isFile);
}

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.ts$/.test(entry.name) && !/\.(?:spec|e2e-spec|int-spec|d)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

const problems = [];
const domainsDir = join(root, 'domains');
const domains = existsSync(domainsDir)
  ? readdirSync(domainsDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(domainsDir, entry.name, 'package.json')),
      )
      .map((entry) => entry.name)
      .sort()
  : [];

const withApi = new Set();
for (const domain of domains) {
  const dir = join(domainsDir, domain);
  const manifest = readJson(join(dir, 'package.json'));
  const api = manifest.exports?.['./api'];
  if (api === undefined) {
    if (args['require-all'])
      problems.push(`${manifest.name}: package.json declares no "./api" export`);
    continue;
  }
  withApi.add(manifest.name);
  if (JSON.stringify(api) !== JSON.stringify(API_EXPORT)) {
    problems.push(`${manifest.name}: exports["./api"] must be ${JSON.stringify(API_EXPORT)}`);
    continue;
  }
  const src = join(dir, 'src');
  const entry = join(src, 'api', 'index.ts');
  if (!isFile(entry)) {
    problems.push(`${manifest.name}: src/api/index.ts is missing`);
    continue;
  }
  const { files, externals, unresolved } = traceImports([entry], resolveSource);
  for (const { file, specifier } of unresolved) {
    problems.push(
      `${manifest.name}: unresolved import '${specifier}' in ${posix(relative(root, file))}`,
    );
  }
  for (const file of files) {
    const path = posix(relative(src, file));
    for (const [pattern, what] of FORBIDDEN_FILES) {
      if (pattern.test(path))
        problems.push(`${manifest.name}: ./api reaches ${what} (src/${path})`);
    }
  }
  for (const [name, from] of externals) {
    if (FORBIDDEN_PACKAGES.has(name)) {
      problems.push(`${manifest.name}: ./api imports ${name} (${posix(relative(root, from))})`);
    }
  }
}

for (const app of API_ONLY_APPS) {
  const src = join(root, 'apps', app, 'src');
  if (!existsSync(src)) continue;
  for (const file of listSources(src)) {
    for (const specifier of collectSpecifiers(readFileSync(file, 'utf8'))) {
      const match = /^(@domain\/[^/]+)(\/.*)?$/.exec(specifier);
      if (match === null || match[1].endsWith('-contracts') || !withApi.has(match[1])) continue;
      if (match[2] !== '/api') {
        problems.push(
          `apps/${app}: ${posix(relative(root, file))} imports ${specifier}; use ${match[1]}/api`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`API subpath check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.info(
  `API subpaths OK (${withApi.size}/${domains.length} domains export ./api; ` +
    `${API_ONLY_APPS.join(', ')} imports domains only through ./api).`,
);
```

- [ ] **Step 5: Run the spec.** `npx vitest run --project scripts check-api-subpaths` — Expected: PASS (9 tests;
      the repository run prints `API subpaths OK (0/4 domains export ./api; …)`).

- [ ] **Step 6: Wire it into the gate.** In root `package.json`, in the `check` script, replace
      `&& node scripts/check-boundaries.mjs"` with
      `&& node scripts/check-boundaries.mjs && node scripts/check-api-subpaths.mjs"`.

- [ ] **Step 7: Wider checks.** `npx biome check --write scripts/docker/trace-imports.mjs
scripts/check-api-subpaths.mjs scripts/check-api-subpaths.spec.ts package.json`, then `bun run check` —
      Expected: exit 0, last lines `Layer boundaries OK (26 packages: …)` and `API subpaths OK (0/4 domains …)`.

- [ ] **Step 8: Commit.**

```bash
git add scripts/docker/trace-imports.mjs scripts/check-api-subpaths.mjs scripts/check-api-subpaths.spec.ts package.json
git commit -S -m "feat(tooling): check that domain ./api entries stay free of core and persistence" \
  -m "Adds the shared import tracer scripts/docker/trace-imports.mjs; bun run check runs the check."
```

### Task 2: Identity `./api` entry and identity barrel clean-up (G-11, part 2; B1FU-1)

**Files:**

- Create: `domains/identity/src/api/index.ts`
- Test: `domains/identity/src/api/api-surface.spec.ts`
- Modify: `domains/identity/package.json` (exports), `domains/identity/src/index.ts` (rewrite),
  `domains/identity/src/identity-api.module.ts`, `domains/identity/src/identity-api.module.spec.ts:88`,
  `domains/identity/src/identity-core.module.ts:53` (comment), `domains/identity/src/testing/index.ts`,
  `domains/identity/src/testing/fake-identity-ports.ts:14-22`, `apps/monolith/src/app.module.ts:3,51,90`,
  `apps/monolith/test/app.e2e-spec.ts` (one new test), `apps/gateway/src/app.module.ts:3`,
  `apps/gateway/src/graphql/payment-user.resolver.ts:2`, `apps/gateway/test/support/gateway-e2e-app.ts:2-3`,
  `domains/identity/README.md:46-47`

**Interfaces:**

- Consumes: Task 1's `check-api-subpaths.mjs`.
- Produces: `@domain/identity/api` exactly as in "Target export map"; `IdentityApiModule.forLocal(): DynamicModule`
  (no longer imports `IdentityCoreModule`), `IdentityApiModule.forRemote(options?: GrpcClientsModuleOptions):
DynamicModule` (unchanged); `@domain/identity/testing` adds `TokenIssuer`.

**Wave:** after Task 1 (Lane P). Must merge before B2.

- [ ] **Step 1: Write the failing spec.** Create `domains/identity/src/api/api-surface.spec.ts`:

```ts
import { IdentityApiModule } from '../identity-api.module.js';
import { IdentityCoreModule } from '../identity-core.module.js';
import * as root from '../index.js';
import * as testing from '../testing/index.js';
import * as api from './index.js';

/** Runtime values of `@domain/identity/api` (types are erased). */
const API_VALUES = [
  'AuthPayloadModel',
  'AuthPort',
  'IDENTITY_LIMITS',
  'IdentityApiModule',
  'IdentityErrorCode',
  'RoleEnum',
  'USERS_LOADER',
  'USER_CACHE_TTL_MS',
  'UserConnectionModel',
  'UserModel',
  'UserResponse',
  'UsersLoaderRegistrar',
  'UsersPort',
  'identityGrpcClientConfig',
  'identityGrpcClientEnvSchema',
  'userCacheKey',
];

describe('@domain/identity entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports every ./api value', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
  });

  it('keeps hashing and token issuance out of the root entry', () => {
    for (const name of [
      'PasswordHasher',
      'TokenIssuer',
      'DEV_JWT_REFRESH_SECRET',
      'MAX_PASSWORD_LENGTH',
    ]) {
      expect(root).not.toHaveProperty(name);
    }
    expect(root).toHaveProperty('IdentityCoreModule');
    expect(root).toHaveProperty('refreshTokenConfig');
  });

  it('offers TokenIssuer to tests through ./testing', () => {
    expect(testing).toHaveProperty('TokenIssuer');
  });

  it('forLocal() binds the ports without importing IdentityCoreModule (the app imports it)', () => {
    expect(IdentityApiModule.forLocal().imports ?? []).not.toContain(IdentityCoreModule);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project identity api-surface` — Expected: FAIL
      (`Failed to load url ./index.js` for `src/api/index.ts`).

- [ ] **Step 3: Create the entry.** `domains/identity/src/api/index.ts`:

```ts
/**
 * @domain/identity/api — the edge surface of the identity context: `IdentityApiModule`
 * (`forRemote()` for the gateway; `forLocal()` for the monolith, which also imports
 * `IdentityCoreModule` from `@domain/identity`), the `AuthPort` / `UsersPort` ports, the gRPC client
 * config and the GraphQL / REST types the apps compose with. Its import graph reaches no core module,
 * persistence or security file (`node scripts/check-api-subpaths.mjs`), so an app that imports only
 * this entry ships without them (assemble-image file tracing).
 */
export { AuthPort } from '../application/ports/auth.port.js';
export { UsersPort } from '../application/ports/users.port.js';
export { IdentityApiModule } from '../identity-api.module.js';
export {
  IDENTITY_LIMITS,
  IdentityErrorCode,
  USER_CACHE_TTL_MS,
  USERS_LOADER,
  userCacheKey,
} from '../identity.constants.js';
export {
  type IdentityGrpcClientConfig,
  identityGrpcClientConfig,
  identityGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/identity-grpc-client.config.js';
export { AuthPayloadModel } from '../presentation/graphql/models/auth-payload.model.js';
export { UserModel } from '../presentation/graphql/models/user.model.js';
export { UserConnectionModel } from '../presentation/graphql/models/user-connection.model.js';
export { RoleEnum } from '../presentation/graphql/role.enum.js';
// Loads the `GraphqlLoaders['users']` augmentation for every importer of this entry.
export { UsersLoaderRegistrar } from '../presentation/graphql/users-loader.registrar.js';
export { UserResponse } from '../presentation/http/responses/user.response.js';
```

- [ ] **Step 4: Rewrite the root barrel.** First run `git diff 9600510 -- domains/identity/src/index.ts`: every export
      another lane added since `9600510` (lane C2 adds `identityRateLimitConfig` /
      `type IdentityRateLimitConfig`) must survive the rewrite. Place it by the placement rule ("Target export map"):
      an edge config namespace or presentation symbol goes into `src/api/index.ts` (and its value name into
      `API_VALUES` of Step 1's spec), anything else into the root-only section below. Then replace the whole of
      `domains/identity/src/index.ts` with:

```ts
/**
 * @domain/identity — the identity bounded context: users, registration, login (argon2id + access /
 * refresh JWTs), refresh-token rotation with reuse detection, logout (denylist), RBAC role
 * administration; REST + GraphQL + gRPC presentation over CQRS, hexagonal ports per topology.
 *
 * Entry points: `@domain/identity/api` (edge surface, re-exported here), this root entry (adds core,
 * persistence, commands, queries and domain types) and `@domain/identity/testing` (fakes, tests only).
 * Wiring: `IdentityCoreModule` (handlers, repositories, relay, cron), `IdentityGrpcModule`
 * (identity-service), `IdentityCoreModule` + `IdentityApiModule.forLocal()` (monolith),
 * `IdentityApiModule.forRemote()` from `@domain/identity/api` (gateway). `identitySchema` and the
 * migration set `identityMigrations` go into `DatabaseModule.forRootAsync({ schema, migrations })`.
 */

// The edge surface (also `@domain/identity/api`).
export * from './api/index.js';
// Application: commands/queries (for other in-process callers), persistence ports.
export { LoginCommand } from './application/commands/login/login.command.js';
export { LogoutCommand } from './application/commands/logout/logout.command.js';
export { PurgeExpiredSessionsCommand } from './application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
export { RefreshSessionCommand } from './application/commands/refresh-session/refresh-session.command.js';
export { RegisterUserCommand } from './application/commands/register-user/register-user.command.js';
export { UpdateUserRolesCommand } from './application/commands/update-user-roles/update-user-roles.command.js';
export type {
  NewSession,
  RotateSessionInput,
  SessionRecord,
} from './application/persistence/sessions.repository.js';
export { SessionsRepository } from './application/persistence/sessions.repository.js';
export { TransactionRunner } from './application/persistence/transaction-runner.js';
export type { ListUsersCriteria, UserRecord } from './application/persistence/users.repository.js';
export { UsersRepository } from './application/persistence/users.repository.js';
export { GetUserByIdQuery } from './application/queries/get-user-by-id/get-user-by-id.query.js';
export { GetUsersByIdsQuery } from './application/queries/get-users-by-ids/get-users-by-ids.query.js';
export { ListUsersQuery } from './application/queries/list-users/list-users.query.js';
// Domain.
export { normalizeEmail } from './domain/email.js';
export { UserRegisteredEvent } from './domain/events/user-registered.event.js';
export { UserRolesChangedEvent } from './domain/events/user-roles-changed.event.js';
export {
  CannotRemoveLastAdminException,
  CannotRevokeOwnAdminRoleException,
  EmailAlreadyTakenException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  InvalidRolesException,
  InvalidUserException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from './domain/identity.errors.js';
export { UserAggregate, type UserSnapshot } from './domain/user.aggregate.js';
export { isUserRole, USER_ROLES, type UserRole } from './domain/user-role.js';
// Modules.
export {
  IDENTITY_COMMAND_HANDLERS,
  IDENTITY_EVENT_HANDLERS,
  IDENTITY_QUERY_HANDLERS,
  IdentityCoreModule,
} from './identity-core.module.js';
export { IdentityGrpcModule } from './identity-grpc.module.js';
// Infrastructure: the Drizzle schema and the migration set for DatabaseModule / drizzle-kit.
export { identityMigrations } from './infrastructure/persistence/identity.migrations.js';
export {
  type IdentitySchema,
  identitySchema,
  sessions,
  sessionsRelations,
  userRole,
  users,
  usersRelations,
} from './infrastructure/persistence/identity.schema.js';
// Infrastructure: config namespaces the identity-service and monolith env-example specs validate.
// PasswordHasher and TokenIssuer stay internal (TokenIssuer is on ./testing for test signers).
export { type PasswordConfig, passwordConfig } from './infrastructure/security/password.config.js';
export {
  type RefreshTokenConfig,
  refreshTokenConfig,
} from './infrastructure/security/refresh-token.config.js';
```

- [ ] **Step 5: Manifest.** In `domains/identity/package.json` `exports`, insert between the `"."` entry and the
      `"./testing"` entry:

```json
    "./api": {
      "@repo/source": "./src/api/index.ts",
      "types": "./src/api/index.ts",
      "default": "./dist/api/index.js"
    },
```

- [ ] **Step 6: `forLocal()` no longer imports the core.** In `domains/identity/src/identity-api.module.ts`:
  - delete the line `import { IdentityCoreModule } from './identity-core.module.js';`
  - in the class doc comment, replace

    ```text
     * - `forLocal()` (monolith): ports → CommandBus/QueryBus, imports `IdentityCoreModule`.
    ```

    with

    ```text
     * - `forLocal()` (monolith): ports → CommandBus/QueryBus. The app imports `IdentityCoreModule` itself
     *   (from `@domain/identity`): this module is part of `@domain/identity/api`, which never reaches core code.
    ```

  - in `forLocal()`, remove `IdentityCoreModule` from the `imports:` array and keep every other entry. At `9600510`
    the line is `      imports: [IdentityCoreModule, GraphqlLoadersModule],` and becomes
    `      imports: [GraphqlLoadersModule],`; if lane C (C2) already added `IdentityRateLimitModule`, it becomes
    `      imports: [GraphqlLoadersModule, IdentityRateLimitModule],`.

  In `domains/identity/src/identity-core.module.ts:53` replace

  ```text
   * Imported by the monolith (through `IdentityApiModule.forLocal()`) and identity-service
  ```

  with

  ```text
   * Imported by the monolith (next to `IdentityApiModule.forLocal()`) and identity-service
  ```

- [ ] **Step 7: Specs that compose `forLocal()`.** In `domains/identity/src/identity-api.module.spec.ts`:
  - add `import { IdentityCoreModule } from './identity-core.module.js';` to the imports (it is not imported at
    `9600510`);
  - replace the line `        IdentityApiModule.forLocal(),` (`:88`) with the two lines
    `        IdentityCoreModule,` and `        IdentityApiModule.forLocal(),`;
  - in the header comment (`:23`) replace `IdentityApiModule.forLocal() (→ IdentityCoreModule)` with
    `IdentityCoreModule + IdentityApiModule.forLocal()`.

- [ ] **Step 8: `./testing`.** Append to `domains/identity/src/testing/index.ts`:

```ts
// Identity's real signer: fakes and the gateway e2e mint refresh tokens with it (not a production export).
export { TokenIssuer } from '../infrastructure/security/token-issuer.service.js';
```

In `domains/identity/src/testing/fake-identity-ports.ts`, delete the line `  type TokenIssuer,` from the
`} from '../index.js';` import and add below that import:
`import type { TokenIssuer } from '../infrastructure/security/token-issuer.service.js';`

- [ ] **Step 9: Apps.** `apps/monolith/src/app.module.ts`: replace
      `import { IdentityApiModule, identitySchema } from '@domain/identity';` with
      `import { IdentityApiModule, IdentityCoreModule, identitySchema } from '@domain/identity';` and the line
      `    IdentityApiModule.forLocal(),` with `    IdentityCoreModule,` + `    IdentityApiModule.forLocal(),`.
      In its class doc comment replace the line (`:51`; lane C3 rewrites `:47-50` above it and keeps it)
      `` * modules import the matching `Core` module — never import a Core module again here).`` with
      `` * modules no longer import a `Core` module: each is imported here, once, before its Api module).``
      (from Task 3 on it holds for all three Core modules).
      `apps/gateway/src/app.module.ts`: `from '@domain/identity';` → `from '@domain/identity/api';` on the
      `IdentityApiModule` import. `apps/gateway/src/graphql/payment-user.resolver.ts`: replace
      `import { USERS_LOADER, UserModel } from '@domain/identity';` with
      `import { USERS_LOADER, UserModel } from '@domain/identity/api';`.
      `apps/gateway/test/support/gateway-e2e-app.ts`: replace
      `import { AuthPort, refreshTokenConfig, TokenIssuer, UsersPort } from '@domain/identity';` with
      `import { AuthPort, refreshTokenConfig, UsersPort } from '@domain/identity';` and
      `import { FakeAuthPort, FakeIdentityState, FakeUsersPort } from '@domain/identity/testing';` with
      `import { FakeAuthPort, FakeIdentityState, FakeUsersPort, TokenIssuer } from '@domain/identity/testing';`.

- [ ] **Step 10: Pin the monolith wiring.** In `apps/monolith/test/app.e2e-spec.ts`, add
      `import { IdentityCoreModule } from '@domain/identity';` and `import { AppModule } from
'../src/app.module.js';` to the static imports (below the existing `@domain/*` imports) and add as the first
      test of the top-level `describe`:

```ts
it('imports every Core module itself (XApiModule.forLocal() no longer imports it)', () => {
  const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
  expect(imports).toEqual(expect.arrayContaining([IdentityCoreModule]));
});
```

- [ ] **Step 11: README.** In `domains/identity/README.md`:
  - replace the Contents cell of the `IdentityApiModule.forLocal()` row of the module table (`:46`) with:

    ```text
    REST controllers, GraphQL resolvers, `LocalStrategy`, `UserReadCache`, `users` DataLoader + ports → local adapters (the app imports `IdentityCoreModule` too)
    ```

  - below the module table (after the `IdentityApiModule.forRemote(options?)` row) add the paragraph:

    ```text
    Entry points: `@domain/identity/api` (edge: `IdentityApiModule`, ports, gRPC client config, GraphQL/REST types;
    what the gateway imports), `@domain/identity` (everything in `./api` plus core, persistence, commands, queries,
    domain), `@domain/identity/testing` (fakes and `TokenIssuer`, tests only).
    ```

  - in the monolith snippet (`:59-73`) replace `import { IdentityApiModule, identitySchema } from '@domain/identity';`
    with `import { IdentityApiModule, IdentityCoreModule, identitySchema } from '@domain/identity';` and the line
    `  IdentityApiModule.forLocal(),` with the two lines `  IdentityCoreModule,` and `  IdentityApiModule.forLocal(),`.

  Prettier re-pads the table (Step 13).

- [ ] **Step 12: Run.** `npx vitest run --project identity` — Expected: PASS. Then
      `npx vitest run --project gateway:e2e --project monolith:e2e` (sandbox off) — Expected: PASS.

- [ ] **Step 13: Wider checks.** `npx biome check --write domains/identity/src apps/monolith/src apps/monolith/test
apps/gateway/src apps/gateway/test domains/identity/package.json`, `npx prettier --write
domains/identity/README.md`, `node scripts/check-api-subpaths.mjs` — Expected: `API subpaths OK (1/4
domains …)`. `rg -n "PasswordHasher|DEV_JWT_REFRESH_SECRET|MAX_PASSWORD_LENGTH|TokenIssuer" apps
domains/billing domains/notifications domains/files libs` — Expected: only comments and
      `apps/gateway/test/support/gateway-e2e-app.ts`. `bun run check` — Expected: exit 0.

- [ ] **Step 14: Commit.**

```bash
git add domains/identity apps/monolith/src/app.module.ts apps/monolith/test/app.e2e-spec.ts \
  apps/gateway/src/app.module.ts apps/gateway/src/graphql/payment-user.resolver.ts \
  apps/gateway/test/support/gateway-e2e-app.ts
git commit -S -m "refactor(identity,monolith,gateway): add @domain/identity/api and trim the root barrel" \
  -m "forLocal() no longer imports IdentityCoreModule; TokenIssuer moves to ./testing; PasswordHasher," \
  -m "DEV_JWT_REFRESH_SECRET and MAX_PASSWORD_LENGTH leave the public entry points."
```

### Task 3: Billing, notifications and files `./api`; the gateway imports only `./api` (G-11, part 3; FU-2)

**Files:**

- Create: `domains/billing/src/api/index.ts`, `domains/notifications/src/api/index.ts`,
  `domains/files/src/api/index.ts`
- Test: `domains/billing/src/api/api-surface.spec.ts`, `domains/notifications/src/api/api-surface.spec.ts`,
  `domains/files/src/api/api-surface.spec.ts`
- Modify: `domains/{billing,notifications,files}/package.json` (exports), `domains/{billing,notifications,files}/src/index.ts`
  (rewrite), `domains/billing/src/billing-api.module.ts`, `domains/notifications/src/notifications-api.module.ts`,
  `domains/billing/src/billing.modules.spec.ts:76`, `domains/notifications/src/notifications.modules.spec.ts:144`,
  `apps/monolith/src/app.module.ts`, `apps/monolith/test/app.e2e-spec.ts` (extend the Task 2 test),
  `apps/gateway/src/app.module.ts:1-4`, `apps/gateway/src/graphql/payment-user.resolver.ts:1`, root `package.json`,
  `scripts/check-api-subpaths.spec.ts` (repository test), `domains/{billing,notifications,files}/README.md`,
  `docs/ARCHITECTURE.md` (`:108`, `:149`, `:151`, `:170`), `docs/DEVELOPMENT.md` (`:213`, `:269-281`),
  `README.md:229`

**Interfaces:**

- Consumes: Task 1, Task 2.
- Produces: `@domain/billing/api`, `@domain/notifications/api`, `@domain/files/api` exactly as in "Target export
  map"; `BillingApiModule.forLocal()` / `NotificationsApiModule.forLocal()` no longer import their Core module.

**Wave:** after Task 2 (Lane P). Must merge before B2.

- [ ] **Step 1: Write the failing specs.** `domains/billing/src/api/api-surface.spec.ts`:

```ts
import { BillingApiModule } from '../billing-api.module.js';
import { BillingCoreModule } from '../billing-core.module.js';
import * as root from '../index.js';
import * as api from './index.js';

const API_VALUES = [
  'BILLING_GRPC_UPSTREAM',
  'BILLING_LIMITS',
  'BILLING_LOG_REDACT_PATHS',
  'BillingApiModule',
  'BillingController',
  'BillingErrorCode',
  'BillingGrpcAdapter',
  'BillingLocalAdapter',
  'BillingPort',
  'BillingResolver',
  'CheckoutSessionModel',
  'IDEMPOTENCY_KEY_PATTERN',
  'PAYMENT_STATUSES',
  'PaymentConnectionModel',
  'PaymentModel',
  'PaymentStatus',
  'PaymentStatusGraphqlEnum',
  'STRIPE_SIGNATURE_HEADER',
  'billingGrpcClientConfig',
  'billingGrpcClientEnvSchema',
  'isPaymentStatus',
  'normalizePayment',
  'toPaymentConnectionModel',
  'toPaymentModel',
];

describe('@domain/billing entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports ./api and keeps core, persistence and Stripe', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of [
      'BillingCoreModule',
      'BillingGrpcModule',
      'billingSchema',
      'StripeService',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });

  it('forLocal() binds the port without importing BillingCoreModule (the app imports it)', () => {
    expect(BillingApiModule.forLocal().imports ?? []).not.toContain(BillingCoreModule);
  });
});
```

`domains/notifications/src/api/api-surface.spec.ts`:

```ts
import * as root from '../index.js';
import { NotificationsApiModule } from '../notifications-api.module.js';
import { NotificationsCoreModule } from '../notifications-core.module.js';
import * as api from './index.js';

const API_VALUES = [
  'DEFAULT_NOTIFICATIONS_PAGE_SIZE',
  'MAX_NOTIFICATIONS_PAGE_SIZE',
  'NOTIFICATIONS_WS_EVENTS',
  'NOTIFICATIONS_WS_NAMESPACE',
  'NOTIFICATION_CREATED_TRIGGER',
  'NotificationConnectionModel',
  'NotificationModel',
  'NotificationPushConsumer',
  'NotificationTypeEnum',
  'NotificationsApiModule',
  'NotificationsController',
  'NotificationsGateway',
  'NotificationsGrpcAdapter',
  'NotificationsLocalAdapter',
  'NotificationsPort',
  'NotificationsResolver',
  'PAGE_STATE_MAX_LENGTH',
  'PAGE_STATE_PATTERN',
  'PUSH_DEDUPE_TTL_SEC',
  'WS_REVOCATION_SWEEP_INTERVAL_MS',
  'isOwnNotification',
  'listNotificationsQuerySchema',
  'notificationCreatedTrigger',
  'notificationIdParamSchema',
  'notificationPageResponseSchema',
  'notificationResponseSchema',
  'notificationsGrpcClientConfig',
  'notificationsGrpcClientEnvSchema',
  'toCreatedNotificationModel',
  'toNotificationConnection',
  'toNotificationPageResponse',
  'toNotificationResponse',
  'userRoom',
];

describe('@domain/notifications entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports ./api and keeps core, Cassandra and mail', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of [
      'NotificationsCoreModule',
      'NotificationsMessagingModule',
      'notificationsCassandraMigrations',
      'NOTIFICATIONS_MAIL_TEMPLATES_DIR',
      'DAILY_DIGEST_CRON',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });

  it('forLocal() binds the port without importing NotificationsCoreModule', () => {
    expect(NotificationsApiModule.forLocal().imports ?? []).not.toContain(NotificationsCoreModule);
  });
});
```

`domains/files/src/api/api-surface.spec.ts`:

```ts
import * as root from '../index.js';
import * as api from './index.js';

describe('@domain/files entry points', () => {
  it('./api exports the module and its config namespace', () => {
    expect(Object.keys(api).sort()).toEqual(['FilesModule', 'filesConfig', 'filesEnvSchema']);
  });

  it('the root entry still exports everything else', () => {
    expect(root).toHaveProperty('FilesModule', api.FilesModule);
    expect(root).toHaveProperty('FilesService');
    expect(root).toHaveProperty('buildUserFileKey');
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing --project notifications --project files
api-surface` — Expected: FAIL (`./index.js` missing in each `src/api/`).

- [ ] **Step 3: Billing entry.** `domains/billing/src/api/index.ts`:

```ts
/**
 * @domain/billing/api — the edge surface of billing: `BillingApiModule` (`forRemote()` for the
 * gateway; `forLocal()` for the monolith, which also imports `BillingCoreModule` from
 * `@domain/billing`), `BillingPort` and its adapters, the gRPC client config, the REST / GraphQL
 * presentation and the log-redaction paths. No core, persistence or Stripe code is reachable from here.
 */
export { BillingPort } from '../application/ports/billing.port.js';
export { BillingApiModule } from '../billing-api.module.js';
export {
  BILLING_GRPC_UPSTREAM,
  BILLING_LIMITS,
  BillingErrorCode,
  IDEMPOTENCY_KEY_PATTERN,
  STRIPE_SIGNATURE_HEADER,
} from '../billing.constants.js';
export { BILLING_LOG_REDACT_PATHS } from '../billing-log-redaction.js';
export { isPaymentStatus, PAYMENT_STATUSES, PaymentStatus } from '../domain/payment-status.enum.js';
export {
  BillingGrpcAdapter,
  normalizePayment,
} from '../infrastructure/adapters/grpc/billing-grpc.adapter.js';
export {
  type BillingGrpcClientConfig,
  billingGrpcClientConfig,
  billingGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/billing-grpc-client.config.js';
export { BillingLocalAdapter } from '../infrastructure/adapters/local/billing-local.adapter.js';
export { BillingResolver } from '../presentation/graphql/billing.resolver.js';
export { CheckoutSessionModel } from '../presentation/graphql/models/checkout-session.model.js';
export {
  PaymentConnectionModel,
  PaymentModel,
  PaymentStatusGraphqlEnum,
  toPaymentConnectionModel,
  toPaymentModel,
} from '../presentation/graphql/models/payment.model.js';
export { BillingController } from '../presentation/http/billing.controller.js';
```

- [ ] **Step 4: Billing root.** First run
      `git diff 9600510 -- domains/billing/src/index.ts domains/notifications/src/index.ts domains/files/src/index.ts`:
      exports other lanes added since `9600510`
      (the ledger lane's L-8a/L-8b/L-9 billing exports; lane C1's `notificationsRateLimitConfig` /
      `type NotificationsRateLimitConfig`) must survive Steps 4, 6 and 7. Place each by the placement rule ("Target
      export map"): an edge config namespace or presentation symbol into `src/api/index.ts` (and into `API_VALUES` of
      Step 1's spec), core, domain, persistence and Stripe/ledger code into the root-only part. Then replace the whole
      of `domains/billing/src/index.ts` with:

```ts
/**
 * @domain/billing — the billing bounded context: Stripe Checkout sessions (idempotent), signed and
 * exactly-once Stripe webhooks, the payments ledger (Drizzle) and the
 * `billing.payment-succeeded.v1` integration event.
 *
 * Entry points: `@domain/billing/api` (edge surface, re-exported here) and this root entry (adds
 * core, persistence, the Stripe adapter, commands, queries and domain types).
 * Wiring: `BillingCoreModule` + `BillingGrpcModule` (billing-service), `BillingCoreModule` +
 * `BillingApiModule.forLocal()` (monolith), `BillingApiModule.forRemote()` from
 * `@domain/billing/api` (gateway). `billingSchema` and the migration set `billingMigrations` go into
 * `DatabaseModule.forRootAsync({ schema, migrations })`.
 */

// The edge surface (also `@domain/billing/api`).
export * from './api/index.js';
// Application
export * from './application/commands/create-checkout-session/create-checkout-session.command.js';
export * from './application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
export * from './application/mappers/payment.mapper.js';
export * from './application/queries/list-payments/list-payments.query.js';
// Modules and core constants
export {
  PAID_WITHOUT_CURRENCY_METRIC,
  PURGE_STRIPE_EVENTS_BATCH_SIZE,
  PURGE_STRIPE_EVENTS_LOCK,
  PURGE_STRIPE_EVENTS_LOCK_TTL_MS,
  STRIPE_EVENTS_RETENTION_DAYS,
} from './billing.constants.js';
export * from './billing-core.module.js';
export * from './billing-grpc.module.js';
// Domain
export * from './domain/billing.errors.js';
export * from './domain/events/payment-succeeded.event.js';
export * from './domain/payment.aggregate.js';
// Infrastructure
export { billingMigrations } from './infrastructure/persistence/billing.migrations.js';
export {
  type BillingSchema,
  billingSchema,
  type PaymentRow,
  paymentStatusEnum,
  payments,
  type StripeEventRow,
  stripeEvents,
} from './infrastructure/persistence/billing.schema.js';
// Stripe adapter (imported by BillingCoreModule; public for custom wiring / tests)
export * from './infrastructure/stripe/stripe.config.js';
export * from './infrastructure/stripe/stripe.constants.js';
export * from './infrastructure/stripe/stripe.errors.js';
export * from './infrastructure/stripe/stripe.module.js';
export * from './infrastructure/stripe/stripe.service.js';
export type * from './infrastructure/stripe/stripe.types.js';
// Presentation: the gRPC server (billing-service)
export * from './presentation/grpc/billing-grpc.controller.js';
```

- [ ] **Step 5: Notifications entry.** `domains/notifications/src/api/index.ts`:

```ts
/**
 * @domain/notifications/api — the notifications edge: `NotificationsApiModule` (`forRemote()` for
 * the gateway; `forLocal()` for the monolith, which also imports `NotificationsCoreModule`),
 * `NotificationsPort` and its adapters, REST / GraphQL / WebSocket / push presentation and their
 * constants. No core, Cassandra or mail code is reachable from here.
 */
export { NotificationsPort } from '../application/ports/notifications.port.js';
export {
  type NotificationsGrpcClientConfig,
  notificationsGrpcClientConfig,
  notificationsGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/notifications-grpc-client.config.js';
export { NotificationsGrpcAdapter } from '../infrastructure/adapters/grpc/notifications-grpc.adapter.js';
export { NotificationsLocalAdapter } from '../infrastructure/adapters/local/notifications-local.adapter.js';
export {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
  NOTIFICATION_CREATED_TRIGGER,
  NOTIFICATIONS_WS_EVENTS,
  NOTIFICATIONS_WS_NAMESPACE,
  notificationCreatedTrigger,
  PAGE_STATE_MAX_LENGTH,
  PAGE_STATE_PATTERN,
  userRoom,
} from '../notifications.constants.js';
export { NotificationsApiModule } from '../notifications-api.module.js';
export {
  NotificationConnectionModel,
  NotificationModel,
  NotificationTypeEnum,
} from '../presentation/graphql/notification.model.js';
export {
  isOwnNotification,
  NotificationsResolver,
  toCreatedNotificationModel,
  toNotificationConnection,
} from '../presentation/graphql/notifications.resolver.js';
export { NotificationsController } from '../presentation/http/notifications.controller.js';
export {
  type ListNotificationsQueryParams,
  listNotificationsQuerySchema,
  type NotificationPageResponse,
  type NotificationResponse,
  notificationIdParamSchema,
  notificationPageResponseSchema,
  notificationResponseSchema,
  toNotificationPageResponse,
  toNotificationResponse,
} from '../presentation/http/notifications.dto.js';
export {
  NotificationPushConsumer,
  PUSH_DEDUPE_TTL_SEC,
} from '../presentation/messaging/notification-push.consumer.js';
export {
  NotificationsGateway,
  type NotificationsNamespace,
  type NotificationsSocket,
  type NotificationsSocketData,
  WS_REVOCATION_SWEEP_INTERVAL_MS,
} from '../presentation/ws/notifications.gateway.js';
```

- [ ] **Step 6: Notifications root.** Replace the whole of `domains/notifications/src/index.ts` with:

```ts
/**
 * @domain/notifications — the notifications bounded context.
 * - `@domain/notifications/api` (re-exported here): `NotificationsApiModule.forLocal()` /
 *   `.forRemote()`, `NotificationsPort`, adapters, REST / GraphQL / WebSocket / push presentation.
 * - This root entry adds `NotificationsCoreModule` (CQRS, saga, Cassandra, digest cron),
 *   `NotificationsGrpcModule`, `NotificationsMessagingModule` (identity/billing Kafka consumers),
 *   `notificationsCassandraMigrations`, commands/queries, mail and domain types.
 * - The monolith imports `NotificationsCoreModule` next to `NotificationsApiModule.forLocal()`.
 */

// The edge surface (also `@domain/notifications/api`).
export * from './api/index.js';
export * from './application/commands/create-notification/create-notification.command.js';
export * from './application/commands/mark-notification-read/mark-notification-read.command.js';
export * from './application/commands/publish-notification-created/publish-notification-created.command.js';
export * from './application/commands/send-daily-digest/send-daily-digest.command.js';
export * from './application/commands/send-payment-receipt/send-payment-receipt.command.js';
export * from './application/commands/welcome-user/welcome-user.command.js';
export * from './application/mail/notifications-mail.js';
export * from './application/mappers/notification.mapper.js';
export * from './application/ports/notification-recipients.repository.js';
export * from './application/ports/notifications.repository.js';
export * from './application/queries/list-notifications/list-notifications.query.js';
export * from './domain/events/notification-created.event.js';
export * from './domain/notification.entity.js';
export * from './domain/notification.errors.js';
export * from './domain/notification.types.js';
export * from './domain/notification-id.js';
export * from './infrastructure/mail/notifications-mail-templates.js';
export * from './infrastructure/persistence/notifications-cassandra.migrations.js';
export {
  DAILY_DIGEST_CRON,
  DAILY_DIGEST_JOB_NAME,
  DAILY_DIGEST_LOCK,
  DAILY_DIGEST_LOCK_TTL_MS,
  DIGEST_CONCURRENCY,
  DIGEST_ITEMS_PER_MAIL,
  DIGEST_MAX_RECIPIENTS,
  DIGEST_RECIPIENTS_PAGE_SIZE,
  DIGEST_SCAN_PER_USER,
} from './notifications.constants.js';
export * from './notifications-core.module.js';
export * from './notifications-grpc.module.js';
export * from './notifications-messaging.module.js';
```

- [ ] **Step 7: Files entry and root.** `domains/files/src/api/index.ts`:

```ts
/**
 * @domain/files/api — what an edge app imports: `FilesModule` and its config namespace. Files is
 * edge-only (no core, no persistence); the root entry re-exports this and the services, policies,
 * DTOs and errors for tests and custom wiring.
 */
export { type FilesConfig, filesConfig, filesEnvSchema } from '../files.config.js';
export { FilesModule } from '../files.module.js';
```

In `domains/files/src/index.ts`: add `export * from './api/index.js';` as the first export line, and delete
the lines `export * from './files.config.js';` and `export * from './files.module.js';`. In the header comment
replace

```text
 * Import `FilesModule` in the gateway and the monolith.
```

with

```text
 * Import `FilesModule` from `@domain/files/api` in the gateway and the monolith.
```

- [ ] **Step 8: Manifests.** In each of `domains/billing/package.json`, `domains/notifications/package.json`,
      `domains/files/package.json`, insert the `"./api"` entry (shape in "Target export map") directly after the
      `"."` entry.

- [ ] **Step 9: `forLocal()` without the core.**
  - `domains/billing/src/billing-api.module.ts`: delete `import { BillingCoreModule } from './billing-core.module.js';`,
    delete the line `      imports: [BillingCoreModule],` inside `forLocal()` (the returned object keeps `module` and
    `...presentation(BillingLocalAdapter)`), and replace the method comment

    ```text
      /** Monolith: ports → CQRS buses in-process (imports `BillingCoreModule`). */
    ```

    with

    ```text
      /** Monolith: ports → CQRS buses in-process. The app imports `BillingCoreModule` itself. */
    ```

  - `domains/notifications/src/notifications-api.module.ts`: delete
    `import { NotificationsCoreModule } from './notifications-core.module.js';`; in `forLocal()` remove
    `NotificationsCoreModule` from the `imports:` array (at `9600510` the line `      imports: [NotificationsCoreModule],`
    is deleted; if lane C1 already made it `      imports: [NotificationsCoreModule, NotificationsRateLimitModule],`,
    it becomes `      imports: [NotificationsRateLimitModule],`); in the class doc comment replace

    ```text
     * - `forLocal()` (monolith): the port runs on the CQRS buses of `NotificationsCoreModule`.
    ```

    with

    ```text
     * - `forLocal()` (monolith): the port runs on the CQRS buses of `NotificationsCoreModule`, which the
     *   app imports itself.
    ```

  - `domains/billing/src/billing.modules.spec.ts`: add `import { BillingCoreModule } from './billing-core.module.js';`
    and replace the line `        BillingApiModule.forLocal(),` (`:76`) with the two lines `        BillingCoreModule,`
    and `        BillingApiModule.forLocal(),`.
  - `domains/notifications/src/notifications.modules.spec.ts` (already imports `NotificationsCoreModule`): replace
    the line `        NotificationsApiModule.forLocal(),` (`:144`) with the two lines `        NotificationsCoreModule,`
    and `        NotificationsApiModule.forLocal(),`.

- [ ] **Step 10: Apps.** `apps/monolith/src/app.module.ts`: replace
      `import { BILLING_LOG_REDACT_PATHS, BillingApiModule, billingSchema } from '@domain/billing';` with
      `import { BILLING_LOG_REDACT_PATHS, BillingApiModule, BillingCoreModule, billingSchema } from '@domain/billing';`,
      add `  NotificationsCoreModule,` to the `@domain/notifications` import list, and replace the block
      `    // Bounded contexts.` … `    FilesModule,` with:

```ts
    // Bounded contexts: every Core module, then the edge bound to the local adapters
    // (XApiModule.forLocal() does not import the core; @domain/<x>/api never reaches it).
    IdentityCoreModule,
    IdentityApiModule.forLocal(),
    NotificationsCoreModule,
    NotificationsApiModule.forLocal(),
    NotificationsMessagingModule,
    BillingCoreModule,
    BillingApiModule.forLocal(),
    FilesModule,
```

`apps/gateway/src/app.module.ts`: `'@domain/billing'` → `'@domain/billing/api'`, `'@domain/files'` →
`'@domain/files/api'`, `'@domain/notifications'` → `'@domain/notifications/api'` on lines 1, 2 and 4.
`apps/gateway/src/graphql/payment-user.resolver.ts`: `import { PaymentModel } from '@domain/billing';` →
`import { PaymentModel } from '@domain/billing/api';`. In `apps/monolith/test/app.e2e-spec.ts`, extend the
Task 2 test: import `BillingCoreModule` from `'@domain/billing'` and `NotificationsCoreModule` from
`'@domain/notifications'` (merge into the existing imports of those packages) and replace
`expect.arrayContaining([IdentityCoreModule])` with
`expect.arrayContaining([IdentityCoreModule, NotificationsCoreModule, BillingCoreModule])`.

- [ ] **Step 11: Require `./api` everywhere.** Root `package.json` `check` script: replace
      `node scripts/check-api-subpaths.mjs"` with `node scripts/check-api-subpaths.mjs --require-all"`. In
      `scripts/check-api-subpaths.spec.ts` replace the last test with:

```ts
it('passes on this repository with every domain exporting ./api', () => {
  const { status, output } = check(REPO_ROOT, '--require-all');
  // n/n: a domain added later (B2 and on) must export ./api too.
  expect(output).toMatch(/API subpaths OK \((\d+)\/\1 domains export \.\/api/);
  expect(status).toBe(0);
});
```

- [ ] **Step 12: Docs.** Exact edits (Prettier re-pads tables in Step 14):
  - `README.md:229` (topology table, Microservices row): replace `` `apps/gateway` imports `XApiModule.forRemote()`; ``
    with `` `apps/gateway` imports `XApiModule.forRemote()` from `@domain/<x>/api`; ``.
  - `docs/ARCHITECTURE.md`:
    - the `forLocal()` sample (`:108-115`): `    imports: [IdentityCoreModule, GraphqlLoadersModule],` →
      `    imports: [GraphqlLoadersModule], // the app imports IdentityCoreModule itself`;
    - module table, `IdentityCoreModule` row (`:149`), "Imported by" cell: replace
      ``Through `XApiModule.forLocal()` or `XGrpcModule` (never directly by an app)`` with
      ``The monolith (directly, next to `XApiModule.forLocal()`), and each service through `XGrpcModule` ``;
    - `IdentityApiModule` row (`:151`), Contents cell: replace ``Edge presentation; `.forLocal()` imports the core,
`.forRemote()` registers gRPC clients`` with ``Edge presentation; `.forLocal()` binds the local adapters (the
app imports the core), `.forRemote()` registers gRPC clients; exported from `@domain/<x>/api` ``;
    - "Domain modules" row (`:170`), monolith cell: list `IdentityCoreModule`, `NotificationsCoreModule`,
      `BillingCoreModule` before the Api modules;
    - after the module table, add this paragraph:

      ```text
      Each domain package has two production entry points: `@domain/<x>/api` (presentation, ports, local and remote
      adapters, the gRPC client config) and `@domain/<x>` (all of `./api` plus core, persistence, commands, queries and
      domain types). The gateway imports only `./api`, and `node scripts/check-api-subpaths.mjs --require-all` (part of
      `bun run check`) fails when an `./api` graph reaches a core module, handler, persistence, Stripe or security file.
      ```

  - `docs/DEVELOPMENT.md` ("Guide: add a new domain module"):
    - in the tree (`:209-216`) add, under `├── index.ts`, the line
      `    ├── api/index.ts                # the ./api entry: presentation, ports, adapters (what the gateway imports)`;
    - in the `forLocal()` sample (`:272`) replace `      imports: [OrdersCoreModule],` with nothing (delete the line);
    - at `:281` replace ``Import `OrdersApiModule.forLocal()` in `apps/monolith/src/app.module.ts`,`` with
      ``Import `OrdersCoreModule` and `OrdersApiModule.forLocal()` in `apps/monolith/src/app.module.ts`,`` and
      `Never import the Core module a second time.` with ``Import the Core module exactly once, in the app
(`forLocal()` does not import it).``;
    - add, right after step 7, this paragraph:

      ```text
      Export `./api` in `package.json` (the same shape as `domains/billing/package.json`) and list the edge symbols in
      `src/api/index.ts`; the root `src/index.ts` starts with `export * from './api/index.js';`.
      `bun run check` fails while a domain has no `./api` entry.
      ```

  - `domains/billing/README.md:26`, `BillingApiModule.forLocal()` row, Contents cell: replace
    ``+ `BillingCoreModule` `` with ``(the app imports `BillingCoreModule` too)``.
  - `domains/notifications/README.md:31`, `NotificationsApiModule.forLocal()` / `.forRemote()` row: replace
    `(local adapter + Core / gRPC adapter + client)` with ``(local adapter, the monolith imports
`NotificationsCoreModule` too / gRPC adapter + client)``.
  - In each of the three domain READMEs add, below the module table, the "Entry points:" paragraph of Task 2 Step 11
    with the package's own name (`files`: `@domain/files/api` = `FilesModule` and its config namespace; no
    `./testing`; billing: no `./testing`).
  - Comments that still say an Api module imports its core:
    - `domains/billing/src/billing-core.module.ts:18-20`: replace
      ``* process that owns the billing tables (billing-service via `BillingGrpcModule`, monolith via`` /
      ``* `BillingApiModule.forLocal()`).`` with
      ``* process that owns the billing tables (billing-service via `BillingGrpcModule`; the monolith`` /
      ``* imports it directly, next to `BillingApiModule.forLocal()`).``;
    - `domains/notifications/README.md:73`: ``globals, with `NotificationsApiModule.forLocal()` + `NotificationsMessagingModule`, and`` →
      ``globals, with `NotificationsCoreModule` + `NotificationsApiModule.forLocal()` + `NotificationsMessagingModule`, and``;
    - `domains/billing/README.md:72` (monolith comment in the wiring snippet):
      `//           IdentityApiModule.forLocal(), BillingApiModule.forLocal(), …` →
      `//           IdentityCoreModule, IdentityApiModule.forLocal(), BillingCoreModule, BillingApiModule.forLocal(), …`.
  - `libs/testing/README.md:26` stays: its example overrides `OrdersPort`, which now works without any Core module.

- [ ] **Step 13: Run.** `npx vitest run --project billing --project notifications --project files --project
scripts` — Expected: PASS. `npx vitest run --project gateway:e2e --project monolith:e2e --project
billing-service:e2e --project notifications-service:e2e` (sandbox off) — Expected: PASS.

- [ ] **Step 14: Wider checks.** `npx biome check --write domains/billing/src domains/notifications/src
domains/files/src apps/monolith apps/gateway scripts package.json domains/*/package.json`; `npx prettier
--write README.md docs/ARCHITECTURE.md docs/DEVELOPMENT.md domains/*/README.md`;
      `bun run check` — Expected: exit 0 with `API subpaths OK (4/4 domains export ./api; gateway imports domains
only through ./api).`

- [ ] **Step 15: Commit.**

```bash
git add domains/billing domains/notifications domains/files apps/monolith/src/app.module.ts \
  apps/monolith/test/app.e2e-spec.ts apps/gateway/src package.json scripts/check-api-subpaths.spec.ts \
  README.md docs/ARCHITECTURE.md docs/DEVELOPMENT.md
git commit -S -m "refactor(billing,notifications,files): add ./api entries; the gateway imports only ./api" \
  -m "forLocal() no longer imports the Core modules; the monolith imports them. bun run check now" \
  -m "requires ./api in every domain."
```

### Task 4: Test doubles leave the libs' production barrels; README snippets (G-11, part 4; B1FU-2, AUDIT-F28)

**Files:**

- Create: `libs/transport/src/testing/index.ts`, `libs/storage/src/testing/index.ts`
- Test: `libs/transport/src/testing/testing-entry.spec.ts`, `libs/storage/src/testing/testing-entry.spec.ts`,
  `libs/auth/src/testing/testing-entry.spec.ts`
- Modify: `libs/transport/package.json`, `libs/storage/package.json` (exports), `libs/transport/src/index.ts:44`,
  `libs/storage/src/index.ts:5,14`, `libs/auth/src/index.ts:39`, `libs/auth/src/testing/index.ts`, and every import
  listed in Step 5, `libs/auth/README.md` (`makeAuthUser` row, the WS helpers row, the WebSocket snippet),
  `libs/transport/README.md:41`, `libs/storage/README.md:18`, `docs/TESTING.md:91-93` (the test-double table names
  the import path of each), `domains/*/README.md` and `apps/*/README.md` lines that name these imports

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `@platform/transport/testing` → `FakeKafkaProducer`, `type PublishedKafkaRecord`;
  `@platform/auth/testing` → `signTestAccessToken`, `type SignTestAccessTokenOptions`, `makeAuthUser`;
  `@platform/storage/testing` → `InMemoryStorageService`, `type InMemoryObject`, `type InMemoryStorageOptions`.

**Wave:** after Task 3 (Lane P; independent of it, sequential only because the lane is). Must merge before B2.

- [ ] **Step 1: Write the failing specs.** `libs/transport/src/testing/testing-entry.spec.ts`:

```ts
import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/transport entry points', () => {
  it('ships FakeKafkaProducer only on ./testing', () => {
    expect(Object.keys(testing)).toEqual(['FakeKafkaProducer']);
    expect(root).not.toHaveProperty('FakeKafkaProducer');
    expect(root).toHaveProperty('KafkaProducer');
  });
});
```

`libs/storage/src/testing/testing-entry.spec.ts`:

```ts
import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/storage entry points', () => {
  it('ships InMemoryStorageService only on ./testing', () => {
    expect(Object.keys(testing)).toEqual(['InMemoryStorageService']);
    expect(root).not.toHaveProperty('InMemoryStorageService');
    expect(root).toHaveProperty('StorageService');
  });
});
```

`libs/auth/src/testing/testing-entry.spec.ts`:

```ts
import * as root from '../index.js';
import * as testing from './index.js';

describe('@platform/auth entry points', () => {
  it('ships makeAuthUser only on ./testing', () => {
    expect(Object.keys(testing).sort()).toEqual(['makeAuthUser', 'signTestAccessToken']);
    expect(root).not.toHaveProperty('makeAuthUser');
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project transport --project storage --project auth testing-entry` —
      Expected: FAIL (transport/storage: `./index.js` missing; auth: `makeAuthUser` still on the root).

- [ ] **Step 3: Entries.** `libs/transport/src/testing/index.ts`:

```ts
/**
 * @platform/transport/testing — test doubles for code that publishes Kafka events. Not imported by
 * production code (a separate subpath, so it never lands in a service's module graph).
 */
export {
  FakeKafkaProducer,
  type PublishedKafkaRecord,
} from '../kafka/testing/fake-kafka-producer.js';
```

`libs/storage/src/testing/index.ts`:

```ts
/**
 * @platform/storage/testing — the in-memory `StorageService` for specs and e2e apps. Production code
 * reaches it only through `StorageModule.forRootAsync({ driver: 'memory' })`.
 */
export {
  type InMemoryObject,
  type InMemoryStorageOptions,
  InMemoryStorageService,
} from './in-memory-storage.service.js';
```

Append to `libs/auth/src/testing/index.ts`: `export { makeAuthUser } from './auth-test.utils.js';`

- [ ] **Step 4: Barrels and manifests.**
  - `libs/transport/src/index.ts`: delete the line `export * from './kafka/testing/fake-kafka-producer.js';`.
  - `libs/storage/src/index.ts`: delete the line `export * from './testing/in-memory-storage.service.js';` and in the
    header comment replace

    ```text
     * `InMemoryStorageService` is the test double.
    ```

    with

    ```text
     * The test double `InMemoryStorageService` is on `@platform/storage/testing`.
    ```

  - `libs/auth/src/index.ts`: delete the line `export { makeAuthUser } from './testing/auth-test.utils.js';`.
  - In `libs/transport/package.json` and `libs/storage/package.json` `exports`, insert after the `"."` entry (if lane
    E's Task 7 already touched `libs/storage/package.json`, it changed only `devDependencies`):

```json
    "./testing": {
      "@repo/source": "./src/testing/index.ts",
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    },
```

- [ ] **Step 5: Imports.** Replace each import (one symbol moves to the `/testing` import, the rest stay):
  - `domains/billing/test/stripe-webhook.flow.spec.ts`, `domains/billing/src/billing.modules.spec.ts`,
    `domains/notifications/src/notifications.modules.spec.ts`, `domains/identity/src/identity-api.module.spec.ts`,
    `domains/identity/src/identity-grpc.module.spec.ts`, `apps/monolith/test/support/monolith-e2e-app.ts:23`:
    `import { FakeKafkaProducer, KafkaProducer } from '@platform/transport';` →
    `import { KafkaProducer } from '@platform/transport';` + `import { FakeKafkaProducer } from
'@platform/transport/testing';`
  - `domains/billing/src/application/relays/payment-succeeded.relay.spec.ts`,
    `domains/notifications/src/application/commands/publish-notification-created/publish-notification-created.handler.spec.ts`,
    `domains/identity/src/application/event-handlers/user-registered.relay.spec.ts`:
    `import { FakeKafkaProducer } from '@platform/transport';` →
    `import { FakeKafkaProducer } from '@platform/transport/testing';`
  - `apps/billing-service/test/app.e2e-spec.ts`, `apps/identity-service/test/app.e2e-spec.ts`,
    `apps/notifications-service/test/app.e2e-spec.ts`: delete the line `  FakeKafkaProducer,` from the
    multi-line `} from '@platform/transport';` import and add
    `import { FakeKafkaProducer } from '@platform/transport/testing';` below it.
  - `domains/files/src/presentation/graphql/files.resolver.spec.ts`:
    `import { makeAuthUser, PERMISSIONS_KEY, PermissionsGuard, Role } from '@platform/auth';` →
    `import { PERMISSIONS_KEY, PermissionsGuard, Role } from '@platform/auth';` + `import { makeAuthUser } from
'@platform/auth/testing';`; `import { InMemoryStorageService } from '@platform/storage';` →
    `import { InMemoryStorageService } from '@platform/storage/testing';`
  - `domains/files/src/application/file-access.policy.spec.ts`:
    `import { makeAuthUser, Permission, Role } from '@platform/auth';` → `import { Permission, Role } from
'@platform/auth';` + `import { makeAuthUser } from '@platform/auth/testing';`
  - `domains/files/src/application/files.service.spec.ts`: `import { makeAuthUser, Role } from '@platform/auth';`
    → `import { Role } from '@platform/auth';` + `import { makeAuthUser } from '@platform/auth/testing';`;
    `import { InMemoryStorageService, type StorageService, type StoredObject } from '@platform/storage';` →
    `import type { StorageService, StoredObject } from '@platform/storage';` + `import { InMemoryStorageService }
from '@platform/storage/testing';`
  - `domains/files/src/testing/files-test-app.test.ts`, `apps/gateway/test/support/gateway-e2e-app.ts:16`,
    `apps/monolith/test/support/monolith-e2e-app.ts:21`: move `InMemoryStorageService` out of the
    `'@platform/storage'` import into `import { InMemoryStorageService } from '@platform/storage/testing';`.
  - Inside the libs, any spec that took one of the three symbols from a root barrel
    (`rg -n "makeAuthUser|InMemoryStorageService|FakeKafkaProducer" libs/*/src -g '*.spec.ts'`, look for
    `from '../index.js'` / `'../../index.js'`): import it relatively from `testing/auth-test.utils.js`,
    `testing/in-memory-storage.service.js` or `kafka/testing/fake-kafka-producer.js` instead.

- [ ] **Step 6: README snippets (AUDIT-F28).** In `libs/auth/README.md` (Prettier re-pads the table in Step 8):
  - `makeAuthUser(overrides?)` row (`:29`): change the first cell to
    ``| `makeAuthUser(overrides?)` (subpath `@platform/auth/testing`) |``.
  - `signTestAccessToken` row (`:30`): delete the trailing sentence ``(`makeAuthUser` stays on the root export.)``.
  - WS helpers row (`:25`): replace the description cell text

    ```text
    Authenticate once in `handleConnection`, then store the user in `socket.data.user`.
    ```

    with

    ```text
    Authenticate once per handshake in namespace middleware (`afterInit` + `namespace.use`), then store the user in `socket.data.user`.
    ```

  - Replace the snippet block from the line `// WebSocket gateway` (`:51`) to the closing `}` of
    `handleConnection` (`:59`) with:

```ts
// WebSocket gateway: authenticate once per handshake in namespace middleware, so a refused
// socket never reaches handleConnection (as NotificationsGateway does).
afterInit(namespace: Namespace): void {
  namespace.use((socket, next) => {
    authenticateSocket(this.tokens, this.denylist, extractSocketToken(socket.handshake)).then(
      (user) => {
        socket.data.user = user;
        next();
      },
      (error: unknown) => {
        const problem = toProblemDetails(error, { exposeInternal: false });
        next(Object.assign(new Error(problem.detail ?? problem.title), { data: problem }));
      },
    );
  });
}
```

Then the other docs that name the import path (Prettier re-pads the tables in Step 8):

- `docs/TESTING.md:91-93` (test-double table, second column): `` `@platform/transport` `` →
  `` `@platform/transport/testing` `` in the `FakeKafkaProducer` row, `` `@platform/storage` `` →
  `` `@platform/storage/testing` `` in the `InMemoryStorageService` row, `` `@platform/auth` `` →
  `` `@platform/auth/testing` `` in the `makeAuthUser(overrides?)` row.
- `libs/transport/README.md:41`, first cell of the `FakeKafkaProducer` row: append
  ``(subpath `@platform/transport/testing`)`` after `` `FakeKafkaProducer` ``.
- `libs/storage/README.md:18`, first cell of the `InMemoryStorageService(options?)` row: append
  ``(subpath `@platform/storage/testing`)`` after `` `InMemoryStorageService(options?)` ``.
- Then run `rg -n "FakeKafkaProducer|InMemoryStorageService|makeAuthUser" -g '*.md' -g '!docs/superpowers/**' apps
domains libs docs README.md`: any other hit that names an import path gets the `/testing` subpath (at `13030b0`
  the remaining hits only name the class, e.g. `apps/*/README.md` test descriptions, and stay).

- [ ] **Step 7: Run.** `npx vitest run --project transport --project storage --project auth --project files
--project billing --project identity --project notifications` — Expected: PASS. e2e (sandbox off):
      `bun run test:e2e` — Expected: PASS.

- [ ] **Step 8: Wider checks.** `npx biome check --write libs/transport libs/storage libs/auth domains apps`;
      `npx prettier --write libs/auth/README.md libs/transport/README.md libs/storage/README.md docs/TESTING.md`;
      `bun run check` — Expected: exit 0 (the boundary check accepts `@platform/<x>/testing` only from test code).

- [ ] **Step 9: Commit.**

```bash
git add libs/transport libs/storage libs/auth domains apps docs/TESTING.md
git commit -S -m "refactor(transport,auth,storage): move test doubles to ./testing subpaths" \
  -m "FakeKafkaProducer, makeAuthUser and InMemoryStorageService leave the production barrels." \
  -m "libs/auth README: authenticate sockets in namespace middleware, as NotificationsGateway does."
```

### Task 5: `assemble-image.mjs` copies only what the entrypoints reach (G-12; B1FU-7)

**Files:**

- Modify: `scripts/docker/assemble-image.mjs`, `Dockerfile` (`assemble` stage)
- Test: `scripts/docker/assemble-image.spec.ts`
- Create: `docs/superpowers/plans/2026-11-09-g-metrics-packaging/artifacts/image-sizes.txt` (measurements for
  Task 11)

**Interfaces:**

- Consumes: `traceImports`, `packageNameOf` from `scripts/docker/trace-imports.mjs` (Task 1); the `./api` entries
  and the gateway's `./api`-only imports (Tasks 2-3).
- Produces: CLI `node assemble-image.mjs --app <name> --build <dir> --out <dir> [--prune true|false]
[--trace true|false] [--verify-load true|false] [--keep <pkg,pkg>]` (defaults: prune false, trace true,
  verify-load false, keep empty). With `--trace true` it logs
  `[assemble] traced <n> files in <k> workspace packages; removed <a> workspace files, <b> workspace packages, <c> node_modules packages`.
  Dockerfile: `ARG TRACE_FILES=true` (`--build-arg TRACE_FILES=false` restores the copy-everything behaviour).

**Wave:** after Tasks 3 and 4 (Lane P).

- [ ] **Step 1: Write the failing spec.** Create `scripts/docker/assemble-image.spec.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'assemble-image.mjs');
const roots: string[] = [];

type Tree = Record<string, string | object>;

function write(root: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

const pkg = (name: string, extra: object = {}) => ({ name, version: '1.0.0', ...extra });
const ws = (name: string, dependencies: Record<string, string>, exports?: object) => ({
  name,
  type: 'module',
  ...(exports ? { exports } : { exports: { '.': { default: './dist/index.js' } } }),
  dependencies,
});

/**
 * --out: a filtered production install (root node_modules, workspace symlinks, manifests);
 * --build: the build stage (src + dist).
 */
function fixture(
  appModule = "import { api } from '@domain/orders/api';\nexport const AppModule = api;\n",
) {
  const root = mkdtempSync(join(tmpdir(), 'assemble-image-'));
  roots.push(root);
  const out = join(root, 'out');
  const build = join(root, 'build');
  const manifests: Tree = {
    'package.json': { workspaces: ['apps/*', 'domains/*', 'libs/*'] },
    'apps/api/package.json': ws('@app/api', {
      '@domain/orders': 'workspace:*',
      'used-lib': '1.0.0',
      'logger-lib': '1.0.0',
      'unused-lib': '1.0.0',
    }),
    'domains/orders/package.json': ws(
      '@domain/orders',
      { '@platform/unused': 'workspace:*', 'heavy-orm': '1.0.0' },
      { '.': { default: './dist/index.js' }, './api': { default: './dist/api/index.js' } },
    ),
    'libs/unused/package.json': ws('@platform/unused', {}),
  };
  write(out, manifests);
  write(out, {
    'bun.lock': '',
    'node_modules/used-lib/package.json': pkg('used-lib', {
      dependencies: { 'dep-of-used': '1.0.0' },
      peerDependencies: { 'peer-of-used': '1.0.0', 'missing-peer': '1.0.0' },
    }),
    'node_modules/used-lib/index.js': 'module.exports = 1;\n',
    'node_modules/used-lib/node_modules/nested-dep/package.json': pkg('nested-dep'),
    // Every package has an entry file: the existing runtime-dependency check resolves each
    // declared dependency with module.findPackageJSON, which needs a resolvable main.
    'node_modules/dep-of-used/package.json': pkg('dep-of-used'),
    'node_modules/dep-of-used/index.js': 'module.exports = 3;\n',
    'node_modules/peer-of-used/package.json': pkg('peer-of-used'),
    'node_modules/peer-of-used/index.js': 'module.exports = 4;\n',
    'node_modules/logger-lib/package.json': pkg('logger-lib'),
    'node_modules/logger-lib/index.js': 'module.exports = 5;\n',
    'node_modules/unused-lib/package.json': pkg('unused-lib'),
    'node_modules/unused-lib/index.js': 'module.exports = 6;\n',
    'node_modules/heavy-orm/package.json': pkg('heavy-orm'),
    'node_modules/heavy-orm/index.js': 'module.exports = 2;\n',
    'node_modules/.bin/heavy': '#!/bin/sh\n',
  });
  mkdirSync(join(out, 'node_modules/@app'), { recursive: true });
  mkdirSync(join(out, 'node_modules/@domain'), { recursive: true });
  mkdirSync(join(out, 'node_modules/@platform'), { recursive: true });
  symlinkSync('../../apps/api', join(out, 'node_modules/@app/api'));
  symlinkSync('../../domains/orders', join(out, 'node_modules/@domain/orders'));
  symlinkSync('../../libs/unused', join(out, 'node_modules/@platform/unused'));
  write(build, manifests);
  write(build, {
    'apps/api/src/main.ts': '',
    'apps/api/dist/main.js': [
      "import { AppModule } from './app.module.js';",
      "import used from 'used-lib';",
      "const pretty = createRequire(import.meta.url).resolve('logger-lib');",
      'console.log(AppModule, used, pretty);',
      '',
    ].join('\n'),
    'apps/api/dist/instrument.js': "export const instrumented = await import('node:os');\n",
    'apps/api/dist/app.module.js': appModule,
    'domains/orders/src/proto/orders.proto': 'syntax = "proto3";\n',
    'domains/orders/dist/proto/orders.proto': 'syntax = "proto3";\n',
    'domains/orders/dist/index.js':
      "export * from './api/index.js';\nexport { orm } from './persistence.js';\n",
    'domains/orders/dist/persistence.js': "import orm from 'heavy-orm';\nexport { orm };\n",
    'domains/orders/dist/api/index.js': '// re-exported by the root\nexport const api = 1;\n',
    'domains/orders/dist/api/index.js.map': '{}',
    'libs/unused/dist/index.js': 'export const unused = 1;\n',
  });
  return { out, build };
}

function assemble(dirs: { out: string; build: string }, ...flags: string[]) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--app', 'api', '--build', dirs.build, '--out', dirs.out, ...flags],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assemble-image file tracing', () => {
  it('keeps what the entrypoints reach and deletes the rest', () => {
    const dirs = fixture();
    const { status, output } = assemble(dirs);
    expect(output).toContain('[assemble] traced');
    expect(status).toBe(0);
    const kept = (path: string) => existsSync(join(dirs.out, path));
    // Workspace files: traced JS, all non-JS assets of a traced package.
    expect(kept('apps/api/dist/main.js')).toBe(true);
    expect(kept('apps/api/dist/app.module.js')).toBe(true);
    expect(kept('domains/orders/dist/api/index.js')).toBe(true);
    expect(kept('domains/orders/dist/proto/orders.proto')).toBe(true);
    expect(kept('domains/orders/dist/index.js')).toBe(false);
    expect(kept('domains/orders/dist/persistence.js')).toBe(false);
    // An untraced workspace package and its symlink are gone.
    expect(kept('libs/unused')).toBe(false);
    expect(kept('node_modules/@platform/unused')).toBe(false);
    // Third-party: imported, resolved by string, their dependencies and installed peers stay.
    expect(kept('node_modules/used-lib/index.js')).toBe(true);
    expect(kept('node_modules/used-lib/node_modules/nested-dep/package.json')).toBe(false);
    expect(kept('node_modules/dep-of-used/package.json')).toBe(true);
    expect(kept('node_modules/peer-of-used/package.json')).toBe(true);
    expect(kept('node_modules/logger-lib/package.json')).toBe(true);
    expect(kept('node_modules/heavy-orm')).toBe(false);
    expect(kept('node_modules/unused-lib')).toBe(false);
    expect(kept('node_modules/.bin')).toBe(false);
    expect(kept('bun.lock')).toBe(false);
  });

  it('copies everything with --trace false (the Dockerfile escape hatch)', () => {
    const dirs = fixture();
    const { status } = assemble(dirs, '--trace', 'false');
    expect(status).toBe(0);
    expect(existsSync(join(dirs.out, 'domains/orders/dist/persistence.js'))).toBe(true);
    expect(existsSync(join(dirs.out, 'node_modules/heavy-orm/index.js'))).toBe(true);
  });

  it('keeps a package named with --keep', () => {
    const dirs = fixture();
    expect(assemble(dirs, '--keep', 'heavy-orm').status).toBe(0);
    expect(existsSync(join(dirs.out, 'node_modules/heavy-orm/index.js'))).toBe(true);
  });

  it('fails on an unresolvable relative import', () => {
    const dirs = fixture("import { x } from './missing.js';\nexport const AppModule = x;\n");
    const { status, output } = assemble(dirs);
    expect(status).toBe(1);
    expect(output).toContain("apps/api/dist/app.module.js: cannot resolve './missing.js'");
  });

  it('passes the load check when every import survived', () => {
    const dirs = fixture();
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(output).toContain('[assemble] load check passed');
    expect(status).toBe(0);
  });

  it('fails the load check on a computed import the tracer cannot see', () => {
    const dirs = fixture(
      "const name = ['heavy', 'orm'].join('-');\nexport const AppModule = await import(name);\n",
    );
    const { status, output } = assemble(dirs, '--verify-load', 'true');
    expect(status).toBe(1);
    expect(output).toContain('load check failed');
  });
});
```

(`nested-dep` is not a dependency of `used-lib`, so it is pruned even though its parent stays: the keep set is
the manifest closure, not "everything under a kept folder".)

- [ ] **Step 2: Run it.** `npx vitest run --project scripts assemble-image` — Expected: FAIL (no `[assemble] traced`
      line; `persistence.js`, `heavy-orm`, `libs/unused` still present; unknown option `--trace`).

- [ ] **Step 3: Implement.** In `scripts/docker/assemble-image.mjs`:
  - Header comment: after item 4 insert
    `//  4b. with --trace true (default), follows the static imports of dist/main.js, dist/instrument.js and`
    `//      dist/migrate.js through the closure's dist/ (workspace packages file by file, via their exports maps;`
    `//      third-party packages by name) and deletes every untraced JS file, every workspace package without a`
    `//      traced file, and every node_modules package outside the manifest closure (dependencies, optional and`
    `//      installed peer dependencies) of the imported packages. Non-JS assets of traced packages stay.`
    `//      --keep a,b keeps extra packages; --verify-load true then imports dist/app.module.js once.`
  - Imports: `import { spawnSync } from 'node:child_process';`, add `dirname`, `resolve`, `sep` to the
    `node:path` import, `statSync` is already imported, and
    `import { packageNameOf, traceImports } from './trace-imports.mjs';`
  - `parseArgs` options: add `trace: { type: 'string', default: 'true' }`,
    `'verify-load': { type: 'string', default: 'false' }`, `keep: { type: 'string', default: '' }`; below
    `const prune = …` add `const trace = args.trace === 'true';`, `const verifyLoad = args['verify-load'] ===
'true';`, `const extraKeep = args.keep.split(',').filter(Boolean);`.
  - Move the `entrypoints` computation (`const entrypoints = ['main.js', 'instrument.js']; if (existsSync(…
'migrate.ts')) entrypoints.push('migrate.js');`) above `// 3 + 4.` (unchanged text), and keep the entrypoint
    existence loop where it is.
  - After the entrypoint existence loop and before `if (problems.length > 0) {`, insert:

```js
// 4b. File tracing (program spec §12 "Gateway image").
let traceSummary = '';
if (trace && problems.length === 0) {
  const appDist = join(out, appPackage.dir, 'dist');
  const traced = traceImports(
    entrypoints.map((entrypoint) => join(appDist, entrypoint)),
    resolveDist,
  );
  for (const { file, specifier } of traced.unresolved) {
    problems.push(`${relative(out, file)}: cannot resolve '${specifier}'`);
  }
  if (problems.length === 0) traceSummary = pruneUntraced(traced);
}
```

- After step 5 (`for (const file of INSTALL_ONLY) …`), replace the `console.info(` call that prints
  `[assemble] ${app}: …` with:

```js
console.info(
  `[assemble] ${app}: ${closure.size} workspace packages (${[...kept].sort().join(', ')}), ` +
    `${assetCount} assets verified, ${dependencyCount} runtime dependencies resolved` +
    (traceSummary ? `\n[assemble] ${traceSummary}` : ''),
);
```

- Before `function pruneWorkspaceDir(dir) {` add these functions:

```js
/** dist/ resolution as Node does it at runtime: relative paths as written, workspace packages through
 * their exports map (`default` condition); anything else is an external package. */
function resolveDist(specifier, fromFile) {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(fromFile), specifier);
    return existsSync(target) && statSync(target).isFile() ? target : undefined;
  }
  const name = packageNameOf(specifier);
  const member = name === undefined ? undefined : closure.get(name);
  if (member === undefined) return undefined;
  const entry = member.manifest.exports?.[`.${specifier.slice(name.length)}`];
  const file = typeof entry === 'string' ? entry : entry?.default;
  if (typeof file !== 'string') {
    problems.push(`${relative(out, fromFile)}: ${name} does not export '${specifier}'`);
    return undefined;
  }
  return join(out, member.dir, file);
}

/** The installed package `name` as Node's node_modules lookup finds it from `fromPath`. */
function findInstalled(name, fromPath) {
  let dir = statSync(fromPath).isDirectory() ? fromPath : dirname(fromPath);
  for (;;) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return realpathSync(manifest);
    if (dir === out || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

function pruneUntraced(traced) {
  const tracedFiles = new Set(traced.files);
  const tracedPackages = new Set([appPackage.manifest.name]);
  for (const [name, { dir }] of closure) {
    const prefix = `${join(out, dir, 'dist')}${sep}`;
    if (traced.files.some((file) => file.startsWith(prefix))) tracedPackages.add(name);
  }

  // Workspace: drop untraced packages (and their node_modules symlinks), then untraced JS files.
  let removedPackages = 0;
  let removedFiles = 0;
  const untraced = [...closure].filter(([name]) => !tracedPackages.has(name));
  for (const [, { dir }] of untraced) kept.delete(dir);
  for (const [name, { dir }] of untraced) {
    pruneWorkspaceDir(dir);
    rmSync(join(out, 'node_modules', name), { recursive: true, force: true });
    removedPackages += 1;
  }
  for (const name of tracedPackages) {
    const dist = join(out, closure.get(name).dir, 'dist');
    for (const file of listFiles(dist)) {
      const path = join(dist, file);
      if (/\.[cm]?js$/.test(file) && !tracedFiles.has(path)) {
        rmSync(path);
        rmSync(`${path}.map`, { force: true });
        removedFiles += 1;
      }
    }
  }

  // Third-party: the manifest closure of every imported (or --keep) package.
  const keepDirs = new Set();
  const pending = [...traced.externals].map(([name, from]) => [name, from]);
  for (const name of extraKeep) pending.push([name, join(out, appPackage.dir)]);
  while (pending.length > 0) {
    const [name, from] = pending.pop();
    const manifestPath = findInstalled(name, from);
    if (manifestPath === undefined) continue; // an optional or peer dependency that is not installed
    const dir = dirname(manifestPath);
    if (keepDirs.has(dir)) continue;
    keepDirs.add(dir);
    const manifest = readJson(manifestPath);
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dep of Object.keys(deps)) pending.push([dep, dir]);
  }
  let removedModules = 0;
  const pruneModules = (modules) => {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      const path = join(modules, entry.name);
      if (entry.name === '.bin') {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      const children = entry.name.startsWith('@')
        ? readdirSync(path).map((child) => [`${entry.name}/${child}`, join(path, child)])
        : [[entry.name, path]];
      for (const [name, packagePath] of children) {
        if (WORKSPACE_SCOPES.some((scope) => name.startsWith(scope))) continue; // handled above
        if (!keepDirs.has(realpathSync(packagePath))) {
          rmSync(packagePath, { recursive: true, force: true });
          removedModules += 1;
        } else {
          pruneModules(join(packagePath, 'node_modules'));
        }
      }
      if (entry.name.startsWith('@') && readdirSync(path).length === 0)
        rmSync(path, { recursive: true });
    }
  };
  pruneModules(join(out, 'node_modules'));
  for (const name of tracedPackages) pruneModules(join(out, closure.get(name).dir, 'node_modules'));

  if (verifyLoad) verifyAppLoads();
  return (
    `traced ${traced.files.length} files in ${tracedPackages.size} workspace packages; removed ` +
    `${removedFiles} workspace files, ${removedPackages} workspace packages, ${removedModules} node_modules packages`
  );
}

/** Imports dist/app.module.js once in a child process: tracing must never ship a module graph that
 * cannot load (computed imports, string-only requires the tracer cannot see). */
function verifyAppLoads() {
  const appModule = join(out, appPackage.dir, 'dist', 'app.module.js');
  if (!existsSync(appModule)) return;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(appModule).href)});`,
    ],
    {
      cwd: join(out, appPackage.dir),
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'development', OTEL_SDK_DISABLED: 'true' },
    },
  );
  if (result.status !== 0) {
    fail(`load check failed for ${relative(out, appModule)}:\n${result.stderr || result.stdout}`);
  }
  console.info('[assemble] load check passed');
}
```

(`pruneUntraced` runs before step 5, so the dependency check of step 3 + 4 still sees every declared runtime
dependency; `problems` is the array defined at `// 3 + 4.`; `kept`, `closure`, `appPackage`, `WORKSPACE_SCOPES`,
`listFiles`, `readJson`, `fail` already exist in the file.)

- [ ] **Step 4: Run the spec.** `npx vitest run --project scripts assemble-image` — Expected: PASS (6 tests).

- [ ] **Step 5: Dockerfile.** In the `assemble` stage replace:

```dockerfile
ARG PRUNE_NODE_MODULES=true
COPY --from=prod-deps /repo /out
COPY scripts/docker/assemble-image.mjs /usr/local/lib/assemble-image.mjs
RUN --mount=type=bind,from=build,source=/repo,target=/build \
    node /usr/local/lib/assemble-image.mjs --app "${APP}" --build /build --out /out \
      --prune "${PRUNE_NODE_MODULES}"
```

with:

```dockerfile
ARG PRUNE_NODE_MODULES=true
# File tracing (only what dist/main.js, instrument.js and migrate.js import) + a load check of
# dist/app.module.js. `--build-arg TRACE_FILES=false` copies every closure package whole, as before.
ARG TRACE_FILES=true
COPY --from=prod-deps /repo /out
COPY scripts/docker/assemble-image.mjs scripts/docker/trace-imports.mjs /usr/local/lib/
RUN --mount=type=bind,from=build,source=/repo,target=/build \
    node /usr/local/lib/assemble-image.mjs --app "${APP}" --build /build --out /out \
      --prune "${PRUNE_NODE_MODULES}" --trace "${TRACE_FILES}" --verify-load "${TRACE_FILES}"
```

- [ ] **Step 6: Measure (Docker, sandbox off).** `--build-arg TRACE_FILES=false` reproduces the pre-task tree
      (closure packages copied whole), so "before" and "after" come from the same commit:

```bash
for app in gateway monolith identity-service notifications-service billing-service; do
  docker build -q --build-arg APP=$app --build-arg TRACE_FILES=false --target runtime -t g12-$app:before .
  docker build -q --build-arg APP=$app --target runtime -t g12-$app:after .
  printf '%s before=%s after=%s\n' "$app" \
    "$(docker image inspect -f '{{.Size}}' g12-$app:before)" "$(docker image inspect -f '{{.Size}}' g12-$app:after)"
done | tee docs/superpowers/plans/2026-11-09-g-metrics-packaging/artifacts/image-sizes.txt
```

Expected: every `after` < `before`; the gateway well below the 294 MB in `docs/PERFORMANCE.md:597`. Every build
also ran the load check (`[assemble] load check passed` in the build log).

Then boot both topologies on traced images. If `scripts/docker/check-topology.ts` exists (lane E Task 6 merged),
run `node scripts/docker/check-topology.ts up microservices` and then `… up monolith` (each builds with tracing on,
uses project `bp-topology-<topology>` on host ports shifted by 20000, runs the register/me journey and tears down).
Otherwise boot the microservices topology by hand in an isolated project with shifted host ports (the developer's
`boilerplate` project and its ports stay untouched):

```bash
export COMPOSE_PROJECT_NAME=g12-verify TAG=g12 API_HOST_PORT=23000 POSTGRES_HOST_PORT=25432 \
  REDIS_HOST_PORT=26379 CASSANDRA_HOST_PORT=29042 KAFKA_HOST_PORT=29094 MAILPIT_SMTP_HOST_PORT=21025 \
  MAILPIT_UI_HOST_PORT=28025 S3_HOST_PORT=29000 S3_CONSOLE_HOST_PORT=29001 GCS_HOST_PORT=24443 \
  IDENTITY_GRPC_HOST_PORT=50151 NOTIFICATIONS_GRPC_HOST_PORT=50152 BILLING_GRPC_HOST_PORT=50153 \
  KAFKA_UI_HOST_PORT=28080
docker compose --profile microservices up -d --build --wait
curl -fsS http://127.0.0.1:23000/health/ready   # Expected: 200
[ "$COMPOSE_PROJECT_NAME" = g12-verify ] && docker compose --profile microservices down -v
docker image rm boilerplate/{gateway,identity-service,notifications-service,billing-service}:g12
```

Finally `docker image rm g12-{gateway,monolith,identity-service,notifications-service,billing-service}:{before,after}`.

- [ ] **Step 7: Wider checks.** `npx biome check --write scripts/docker`; `bun run check` — Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add scripts/docker/assemble-image.mjs scripts/docker/assemble-image.spec.ts Dockerfile \
  docs/superpowers/plans/2026-11-09-g-metrics-packaging/artifacts/image-sizes.txt
git commit -S -m "feat(docker): trace each app's imports when assembling images" \
  -m "Untraced dist files, workspace packages and node_modules packages are dropped; a load check" \
  -m "imports dist/app.module.js. --build-arg TRACE_FILES=false restores the old tree."
```

### Task 6: `/metrics` on its own listener, `METRICS_PORT` (G-4; FU-3)

**Files:**

- Create: `libs/observability/src/metrics/metrics-server.ts`, `libs/observability/src/metrics/metrics-listener.ts`,
  `libs/bootstrap/src/http/listen-metrics.ts`, `libs/bootstrap/src/cluster/primary-metrics.ts`
- Test: `libs/observability/src/metrics/metrics-server.spec.ts`,
  `libs/observability/src/metrics/metrics-listener.spec.ts`, `libs/bootstrap/src/cluster/primary-metrics.spec.ts`,
  `libs/config/src/namespaces/observability-metrics-port.spec.ts`
- Modify: `libs/config/src/namespaces/observability.config.ts`, `libs/observability/src/metrics/metrics.module.ts`,
  `libs/observability/src/metrics/cluster-metrics.ts` (+ `cluster-metrics.spec.ts`),
  `libs/observability/src/index.ts:42-60`, `libs/observability/src/observability.module.spec.ts:15,82`,
  `libs/config/src/namespaces/namespaces.spec.ts:50-58`, `libs/bootstrap/src/http/create-http-app.spec.ts`,
  `libs/bootstrap/src/cluster/run-clustered.ts:6,185`, `libs/bootstrap/src/index.ts`,
  `libs/bootstrap/src/http/microservice-app.ts:6` (comment), `apps/*/src/main.ts` (5),
  `apps/*/test/app.e2e-spec.ts` (5), `libs/bootstrap/src/integration.smoke.spec.ts:211-225,385`, `.env.example`,
  `apps/*/.env.example` (5), `apps/*/test/env-example.spec.ts` (5), `docker-compose.yml:35`,
  `docker/prometheus/prometheus.yml`, `docs/OBSERVABILITY.md`, `docs/CONFIGURATION.md`,
  `libs/observability/README.md`, `libs/bootstrap/README.md`
- Delete: `libs/observability/src/metrics/metrics.controller.ts`, `libs/observability/src/metrics/metrics-token.guard.ts`,
  `libs/observability/src/metrics/metrics-token.guard.spec.ts`

**Interfaces:**

- Consumes: `timingSafeEqualStr` (`@platform/common`), `observabilityConfig`, `appConfig`, `zPort`
  (`@platform/config`).
- Produces:
  - `observabilityConfig`: env `METRICS_PORT` (`zPort(9464)`) → `ObservabilityConfig.metricsPort: number`.
  - `@platform/observability`:
    `interface MetricsRequest { readonly method: string | undefined; readonly url: string | undefined; readonly authorization: string | undefined }`,
    `interface MetricsScrape { readonly status: 200 | 404 | 500; readonly contentType: string; readonly body: string }`,
    `interface MetricsServerOptions { readonly port: number; readonly host: string; readonly bearerToken?: string | undefined; readonly collect: () => Promise<string> }`,
    `interface MetricsServer { readonly url: string; close(): Promise<void> }`,
    `const METRICS_NOT_FOUND: MetricsScrape`,
    `scrapeMetrics(options: Pick<MetricsServerOptions, 'bearerToken' | 'collect'>, request: MetricsRequest): Promise<MetricsScrape>`,
    `startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer>`,
    `class MetricsListener { start(): Promise<string | undefined>; scrape(authorization?: string): Promise<MetricsScrape>; onApplicationShutdown(): Promise<void> }`,
    `collectClusterMetrics(): Promise<string>`, `enableClusterMetricsWorker(): void`. Removed: `MetricsController`,
    `requestClusterMetrics`, `enableClusterMetricsAggregation`.
  - `@platform/bootstrap`: `listenMetrics(app: INestApplicationContext): Promise<string | undefined>`,
    `startClusterPrimaryMetrics(env?: Parameters<typeof observabilityConfig.parse>[0]): Promise<MetricsServer | undefined>`
    (rejects when `METRICS_PORT` equals `PORT`).

**Wave:** start now (Lane M). Independent of B2.

- [ ] **Step 1: Write the failing specs.** `libs/config/src/namespaces/observability-metrics-port.spec.ts`:

```ts
import { observabilityConfig } from './observability.config.js';

const parse = (env: Record<string, string> = {}) =>
  observabilityConfig.parse({ SERVICE_NAME: 'svc', ...env });

describe('observability namespace: METRICS_PORT', () => {
  it('defaults to 9464 (the OpenTelemetry Prometheus exporter port)', () => {
    expect(parse().metricsPort).toBe(9464);
  });

  it('accepts 0 (OS-picked, tests) and any TCP port', () => {
    expect(parse({ METRICS_PORT: '0' }).metricsPort).toBe(0);
    expect(parse({ METRICS_PORT: '9467' }).metricsPort).toBe(9467);
  });

  it('rejects a value outside 0..65535', () => {
    expect(() => parse({ METRICS_PORT: '70000' })).toThrow();
  });
});
```

`libs/observability/src/metrics/metrics-server.spec.ts`:

```ts
import {
  type MetricsRequest,
  type MetricsServer,
  scrapeMetrics,
  startMetricsServer,
} from './metrics-server.js';

const collect = async (): Promise<string> => '# HELP up 1\nup 1\n';
const request = (overrides: Partial<MetricsRequest> = {}): MetricsRequest => ({
  method: 'GET',
  url: '/metrics',
  authorization: undefined,
  ...overrides,
});

describe('scrapeMetrics', () => {
  it('answers GET /metrics with the collected text', async () => {
    const scrape = await scrapeMetrics({ collect }, request());
    expect(scrape).toMatchObject({ status: 200, body: '# HELP up 1\nup 1\n' });
    expect(scrape.contentType).toMatch(/^text\/plain/);
    expect((await scrapeMetrics({ collect }, request({ url: '/metrics?x=1' }))).status).toBe(200);
  });

  it.each([
    ['POST', '/metrics'],
    ['GET', '/'],
    ['GET', '/metrics/x'],
    ['GET', '/health/live'],
  ])('answers %s %s with 404', async (method, url) => {
    expect((await scrapeMetrics({ collect }, request({ method, url }))).status).toBe(404);
  });

  it('answers 404 to a missing or wrong bearer token, like a disabled endpoint', async () => {
    const options = { collect, bearerToken: 'a-long-enough-secret' };
    expect((await scrapeMetrics(options, request())).status).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'Bearer wrong-secret-value' })))
        .status,
    ).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'Basic a-long-enough-secret' })))
        .status,
    ).toBe(404);
    expect(
      (await scrapeMetrics(options, request({ authorization: 'bearer  a-long-enough-secret ' })))
        .status,
    ).toBe(200);
  });

  it('answers 500 when collection throws', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('registry broke');
    };
    const scrape = await scrapeMetrics({ collect: failing }, request());
    expect(scrape.status).toBe(500);
    expect(scrape.body).not.toContain('registry broke');
  });
});

// Binds 127.0.0.1: run with the sandbox off.
describe('startMetricsServer', () => {
  const servers: MetricsServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  const start = async (port = 0): Promise<MetricsServer> => {
    const server = await startMetricsServer({ port, host: '127.0.0.1', collect });
    servers.push(server);
    return server;
  };

  it('serves /metrics over HTTP (GET and HEAD) and 404 elsewhere', async () => {
    const server = await start();
    const ok = await fetch(`${server.url}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toContain('up 1');
    const head = await fetch(`${server.url}/metrics`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${server.url}/`)).status).toBe(404);
  });

  it('rejects when the port is taken: the boot fails instead of serving nothing', async () => {
    const first = await start();
    await expect(start(Number(new URL(first.url).port))).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
```

`libs/observability/src/metrics/metrics-listener.spec.ts`:

```ts
import type { AppConfig, ObservabilityConfig } from '@platform/config';
import { MetricsListener } from './metrics-listener.js';

const observability = (overrides: Partial<ObservabilityConfig> = {}) =>
  ({
    metricsEnabled: true,
    metricsPort: 0,
    metricsBearerToken: undefined,
    ...overrides,
  }) as ObservabilityConfig;
const app = (overrides: Partial<AppConfig> = {}) =>
  ({ port: 3000, host: '127.0.0.1', ...overrides }) as AppConfig;

describe('MetricsListener', () => {
  it('stays closed when METRICS_ENABLED=false, and scrape() answers 404', async () => {
    const listener = new MetricsListener(observability({ metricsEnabled: false }), app());
    await expect(listener.start()).resolves.toBeUndefined();
    expect((await listener.scrape()).status).toBe(404);
  });

  it('refuses METRICS_PORT equal to PORT', async () => {
    const listener = new MetricsListener(observability({ metricsPort: 3000 }), app({ port: 3000 }));
    await expect(listener.start()).rejects.toThrow(
      'METRICS_PORT (3000) must differ from PORT (3000)',
    );
  });

  // Binds 127.0.0.1: run with the sandbox off.
  it('opens once, serves the default registry and closes on shutdown', async () => {
    const listener = new MetricsListener(observability(), app());
    const url = (await listener.start()) ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(listener.start()).resolves.toBe(url);
    expect((await listener.scrape()).status).toBe(200);
    await listener.onApplicationShutdown();
    await expect(fetch(`${url}/metrics`)).rejects.toThrow();
  });

  it('rejects when the port is taken', async () => {
    const first = new MetricsListener(observability(), app());
    const url = (await first.start()) ?? '';
    try {
      const port = Number(new URL(url).port);
      const second = new MetricsListener(observability({ metricsPort: port }), app());
      await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.onApplicationShutdown();
    }
  });
});
```

`libs/bootstrap/src/cluster/primary-metrics.spec.ts`:

```ts
import { startClusterPrimaryMetrics } from './primary-metrics.js';

describe('startClusterPrimaryMetrics', () => {
  it('opens nothing when METRICS_ENABLED=false', async () => {
    await expect(
      startClusterPrimaryMetrics({ SERVICE_NAME: 'svc', METRICS_ENABLED: 'false' }),
    ).resolves.toBeUndefined();
  });

  it('refuses METRICS_PORT equal to PORT before binding anything', async () => {
    await expect(
      startClusterPrimaryMetrics({ SERVICE_NAME: 'svc', PORT: '9464', METRICS_PORT: '9464' }),
    ).rejects.toThrow('METRICS_PORT (9464) must differ from PORT (9464)');
  });

  // Binds 127.0.0.1: run with the sandbox off.
  it('serves the (empty, no workers) cluster aggregate on METRICS_PORT', async () => {
    const server = await startClusterPrimaryMetrics({
      SERVICE_NAME: 'svc',
      METRICS_PORT: '0',
      HOST: '127.0.0.1',
    });
    if (server === undefined) throw new Error('expected a metrics server');
    try {
      expect((await fetch(`${server.url}/metrics`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project config --project observability --project bootstrap
metrics-port metrics-server metrics-listener primary-metrics` (sandbox off) — Expected: FAIL (`metricsPort` is
      `undefined`; the new modules do not exist).

- [ ] **Step 3: Config.** In `libs/config/src/namespaces/observability.config.ts`:
  - the helpers import becomes
    `import { zBool, zEnum, zNodeEnv, zPort, zServiceName, zStr, zUrl } from '../env/env.helpers.js';`
  - after the line `    METRICS_ENABLED: zBool(true),` insert:

    ```ts
        // The separate /metrics listener (never the API port). 0 = OS-picked (tests).
        METRICS_PORT: zPort(9464),
    ```

  - after the line `      metricsEnabled: env.METRICS_ENABLED,` insert:

    ```ts
          /** Port of the metrics listener (`/metrics` is not served on the API port). */
          metricsPort: env.METRICS_PORT,
    ```

  - `libs/config/src/namespaces/namespaces.spec.ts` ("observability" test, `:50-58`, a `toEqual` on the parsed
    defaults): after the line `      metricsEnabled: true,` insert `      metricsPort: 9464,`. Without it the config
    project fails (verified in a scratch run).

- [ ] **Step 4: The server.** Create `libs/observability/src/metrics/metrics-server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqualStr } from '@platform/common';
import { register } from 'prom-client';
import { METRICS_PATH } from './metrics.constants.js';

const BEARER_PREFIX = /^Bearer\s+/i;
const TEXT = 'text/plain; charset=utf-8';

export interface MetricsRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
}

/** One answer of the metrics listener (also produced in-process by `MetricsListener.scrape()`). */
export interface MetricsScrape {
  readonly status: 200 | 404 | 500;
  readonly contentType: string;
  readonly body: string;
}

export interface MetricsServerOptions {
  /** `METRICS_PORT`; `0` lets the OS pick (tests). */
  readonly port: number;
  /** The app's `HOST` (`0.0.0.0` in containers, so Prometheus reaches it in-network). */
  readonly host: string;
  /** `METRICS_BEARER_TOKEN`: when set, a scrape without `Authorization: Bearer <token>` gets 404. */
  readonly bearerToken?: string | undefined;
  /** The exposition text: this process's registry, or the cluster aggregate in a cluster primary. */
  readonly collect: () => Promise<string>;
}

export interface MetricsServer {
  /** `http://<host>:<port>` actually bound (the OS-picked port when `port` was 0). */
  readonly url: string;
  close(): Promise<void>;
}

/** Disabled endpoint, wrong path or method, missing or wrong token: all look the same. */
export const METRICS_NOT_FOUND: MetricsScrape = {
  status: 404,
  contentType: TEXT,
  body: 'Not Found\n',
};

/**
 * Answers one request of the metrics listener: only `GET` / `HEAD /metrics` (query string ignored);
 * everything else, and a missing or wrong bearer token (constant-time compare), is 404, so the
 * listener reveals nothing. A failing collector answers 500 without its message.
 */
export async function scrapeMetrics(
  options: Pick<MetricsServerOptions, 'bearerToken' | 'collect'>,
  request: MetricsRequest,
): Promise<MetricsScrape> {
  const path = (request.url ?? '').split('?')[0];
  if (path !== METRICS_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return METRICS_NOT_FOUND;
  }
  if (options.bearerToken !== undefined) {
    const header = request.authorization;
    if (header === undefined || !BEARER_PREFIX.test(header)) return METRICS_NOT_FOUND;
    if (!timingSafeEqualStr(header.replace(BEARER_PREFIX, '').trim(), options.bearerToken)) {
      return METRICS_NOT_FOUND;
    }
  }
  try {
    return { status: 200, contentType: register.contentType, body: await options.collect() };
  } catch {
    return { status: 500, contentType: TEXT, body: 'metrics collection failed\n' };
  }
}

/**
 * Starts the metrics listener: a bare `node:http` server, apart from the API's Fastify instance, so
 * scrapes never touch the API port, its middleware, throttler or logs. Rejects when the port is taken
 * (`EADDRINUSE`): a boot must fail loudly rather than run without metrics.
 */
export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void scrapeMetrics(options, {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    }).then((scrape) => {
      response.writeHead(scrape.status, {
        'content-type': scrape.contentType,
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : scrape.body);
    });
  });
  // Scrapes are short: never let a slow client hold a socket.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
      resolve({
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
```

- [ ] **Step 5: The listener.** Create `libs/observability/src/metrics/metrics-listener.ts`:

```ts
import cluster from 'node:cluster';
import { Inject, Injectable, Logger, type OnApplicationShutdown, Optional } from '@nestjs/common';
import {
  type AppConfig,
  appConfig,
  type ObservabilityConfig,
  observabilityConfig,
} from '@platform/config';
import { register } from 'prom-client';
import { METRICS_PATH } from './metrics.constants.js';
import {
  METRICS_NOT_FOUND,
  type MetricsScrape,
  type MetricsServer,
  scrapeMetrics,
  startMetricsServer,
} from './metrics-server.js';

/**
 * `/metrics` of one Nest app on its own listener (`METRICS_PORT`, default 9464), never on the API
 * port. Opened by `listenMetrics(app)` (`@platform/bootstrap`) in `main.ts`; closed on application
 * shutdown, after the API stopped. Under `runClustered()` workers never open it: the primary serves
 * the cluster-wide aggregate on the same port (`startClusterPrimaryMetrics`).
 */
@Injectable()
export class MetricsListener implements OnApplicationShutdown {
  private readonly logger = new Logger(MetricsListener.name);
  private server: MetricsServer | undefined;

  constructor(
    @Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig,
    @Optional() @Inject(appConfig.KEY) private readonly app?: AppConfig,
  ) {}

  /**
   * Opens the listener and resolves its URL; `undefined` when `METRICS_ENABLED=false` or in a
   * cluster worker. Throws when `METRICS_PORT` equals `PORT` or the port is taken.
   */
  async start(): Promise<string | undefined> {
    if (!this.config.metricsEnabled || cluster.isWorker) return undefined;
    if (this.server !== undefined) return this.server.url;
    const port = this.config.metricsPort;
    if (port !== 0 && this.app !== undefined && port === this.app.port) {
      throw new Error(
        `METRICS_PORT (${port}) must differ from PORT (${this.app.port}): /metrics has its own listener`,
      );
    }
    this.server = await startMetricsServer({
      port,
      host: this.app?.host ?? '0.0.0.0',
      bearerToken: this.config.metricsBearerToken,
      collect: () => register.metrics(),
    });
    this.logger.log(`Metrics listening on ${this.server.url}${METRICS_PATH}`);
    return this.server.url;
  }

  /** The listener's answer, in-process (e2e specs that do not bind ports). */
  scrape(authorization?: string): Promise<MetricsScrape> {
    if (!this.config.metricsEnabled) return Promise.resolve(METRICS_NOT_FOUND);
    return scrapeMetrics(
      { bearerToken: this.config.metricsBearerToken, collect: () => register.metrics() },
      { method: 'GET', url: METRICS_PATH, authorization },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.close();
  }
}
```

- [ ] **Step 6: Module and cluster.** Replace `libs/observability/src/metrics/metrics.module.ts` with:

```ts
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { type ObservabilityConfig, observabilityConfig } from '@platform/config';
import { makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { collectDefaultMetrics, register } from 'prom-client';
import { enableClusterMetricsWorker } from './cluster-metrics.js';
import { HttpMetricsHook } from './http-metrics.hook.js';
import { MetricsListener } from './metrics-listener.js';
import {
  DEFAULT_METRICS_SENTINEL,
  HTTP_DURATION_BUCKETS,
  HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
} from './metrics.constants.js';

/** Registers this worker with the primary's aggregator at boot (no-op outside cluster workers). */
@Injectable()
class ClusterMetricsWorkerBridge implements OnModuleInit {
  onModuleInit(): void {
    enableClusterMetricsWorker();
  }
}

/** Node default metrics (`process_*`, `nodejs_*`, names used by the Grafana dashboard). */
@Injectable()
class DefaultMetricsCollector implements OnModuleInit {
  constructor(@Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig) {}

  onModuleInit(): void {
    // prom-client's default registry is process-global: a second app in the same process (tests)
    // must not register the collectors again (duplicate-metric error).
    if (
      this.config.metricsEnabled &&
      register.getSingleMetric(DEFAULT_METRICS_SENTINEL) === undefined
    ) {
      collectDefaultMetrics({ eventLoopMonitoringPrecision: 10 });
    }
  }
}

/**
 * prom-client wiring (internal to `ObservabilityModule`): Node default metrics, the HTTP latency
 * histogram and `MetricsListener`, which serves `/metrics` on `METRICS_PORT` — not on the API port.
 * `@willsoto/nestjs-prometheus` is used only for `makeXProvider` / `@InjectMetric` (its module
 * always mounts a `/metrics` controller on the API, so it is not imported).
 *
 * No default `service` label: Prometheus attaches the scrape target's identity itself, and a second
 * `service` label would conflict with it (infra contract).
 */
@Module({
  providers: [
    makeHistogramProvider({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP server request duration in seconds, by method, route template and status code',
      labelNames: [...HTTP_METRIC_LABEL_NAMES],
      buckets: [...HTTP_DURATION_BUCKETS],
    }),
    HttpMetricsHook,
    ClusterMetricsWorkerBridge,
    DefaultMetricsCollector,
    MetricsListener,
  ],
  exports: [MetricsListener],
})
export class MetricsModule {}
```

Replace `libs/observability/src/metrics/cluster-metrics.ts` with:

```ts
import cluster from 'node:cluster';
import { AggregatorRegistry, type PrometheusContentType } from 'prom-client';

/**
 * Cluster-wide metrics for `runClustered()` (node:cluster). Every worker has its own prom-client
 * registry; the PRIMARY serves `/metrics` on `METRICS_PORT` and collects every worker's registry over
 * prom-client's IPC (`AggregatorRegistry`: counters and histograms summed, gauges aggregated per
 * metric). Workers never open the metrics port.
 */
let workerEnabled = false;
let aggregator: AggregatorRegistry<PrometheusContentType> | undefined;

/**
 * WORKER: makes this worker's registry collectable by the primary. Must run at boot: the primary
 * asks EVERY worker, and one without a responder stalls the aggregation until prom-client's
 * timeout. Idempotent; a no-op outside cluster workers.
 */
export function enableClusterMetricsWorker(): void {
  if (workerEnabled || !cluster.isWorker) return;
  workerEnabled = true;
  // Constructing it installs prom-client's worker-side responder (`prom-client:getMetricsReq`).
  new AggregatorRegistry();
}

/** PRIMARY: the aggregated exposition text of every live worker (empty without workers). */
export function collectClusterMetrics(): Promise<string> {
  aggregator ??= new AggregatorRegistry<PrometheusContentType>();
  return aggregator.clusterMetrics();
}
```

Replace the whole of `libs/observability/src/metrics/cluster-metrics.spec.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { collectClusterMetrics, enableClusterMetricsWorker } from './cluster-metrics.js';

describe('cluster metrics outside a cluster', () => {
  it('enableClusterMetricsWorker is a no-op outside workers', () => {
    expect(() => enableClusterMetricsWorker()).not.toThrow();
  });

  it('collectClusterMetrics resolves the (empty) aggregate when the primary has no workers', async () => {
    await expect(collectClusterMetrics()).resolves.toEqual(expect.any(String));
  });
});
```

Delete `metrics.controller.ts`, `metrics-token.guard.ts` and `metrics-token.guard.spec.ts` (their behaviour is
now in `scrapeMetrics` and covered by `metrics-server.spec.ts`). In `libs/observability/src/index.ts`, replace
the `cluster-metrics.js` export block with `export { collectClusterMetrics, enableClusterMetricsWorker } from
'./metrics/cluster-metrics.js';`, replace `export { MetricsController } from './metrics/metrics.controller.js';`
with:

```ts
export { MetricsListener } from './metrics/metrics-listener.js';
export {
  METRICS_NOT_FOUND,
  type MetricsRequest,
  type MetricsScrape,
  type MetricsServer,
  type MetricsServerOptions,
  scrapeMetrics,
  startMetricsServer,
} from './metrics/metrics-server.js';
```

In `libs/observability/src/observability.module.spec.ts`: `import { MetricsController } from
'./metrics/metrics.controller.js';` → `import { MetricsListener } from './metrics/metrics-listener.js';` and
`expect(app.get(MetricsController, { strict: false })).toBeInstanceOf(MetricsController);` →
`expect(app.get(MetricsListener, { strict: false })).toBeInstanceOf(MetricsListener);`.

- [ ] **Step 7: Bootstrap.** Create `libs/bootstrap/src/http/listen-metrics.ts`:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import { MetricsListener } from '@platform/observability';

/**
 * Opens the app's metrics listener on `METRICS_PORT` (default 9464), apart from the API port. Call
 * it in `main.ts` right before `listen(app)`. Resolves the listener URL, or `undefined` when metrics
 * are disabled or in a cluster worker (the primary serves the aggregate). Throws when the port is
 * taken or equals `PORT`.
 */
export function listenMetrics(app: INestApplicationContext): Promise<string | undefined> {
  return app.get(MetricsListener, { strict: false }).start();
}
```

Create `libs/bootstrap/src/cluster/primary-metrics.ts`:

```ts
import { appConfig, observabilityConfig } from '@platform/config';
import {
  collectClusterMetrics,
  type MetricsServer,
  startMetricsServer,
} from '@platform/observability';

/**
 * The cluster primary's metrics listener: the aggregate of every worker on `METRICS_PORT` (the
 * workers never bind it). Resolves `undefined` when `METRICS_ENABLED=false`; rejects when
 * `METRICS_PORT` equals `PORT` (the workers could never bind the API port). Config is parsed from the
 * environment: the primary has no Nest container.
 */
export async function startClusterPrimaryMetrics(
  env?: Parameters<typeof observabilityConfig.parse>[0],
): Promise<MetricsServer | undefined> {
  const observability = observabilityConfig.parse(env);
  if (!observability.metricsEnabled) return undefined;
  const app = appConfig.parse(env);
  if (observability.metricsPort !== 0 && observability.metricsPort === app.port) {
    throw new Error(
      `METRICS_PORT (${observability.metricsPort}) must differ from PORT (${app.port}): /metrics has its own listener`,
    );
  }
  return startMetricsServer({
    port: observability.metricsPort,
    host: app.host,
    bearerToken: observability.metricsBearerToken,
    collect: collectClusterMetrics,
  });
}
```

In `libs/bootstrap/src/cluster/run-clustered.ts`:

- replace `import { createStandaloneLogger, enableClusterMetricsAggregation } from '@platform/observability';` with
  `import { createStandaloneLogger } from '@platform/observability';` and add
  `import { startClusterPrimaryMetrics } from './primary-metrics.js';`;
- replace the line `  enableClusterMetricsAggregation();` with:

  ```ts
  // The primary serves the cluster-wide /metrics on METRICS_PORT; workers never bind it.
  const metrics = await startClusterPrimaryMetrics();
  ```

- replace the line `  await supervisor.run();` with:

  ```ts
  try {
    await supervisor.run();
  } finally {
    await metrics?.close();
  }
  ```

- in the `runClustered` doc comment replace

  ```text
   * `bootstrap()` in this process. Otherwise the primary only supervises (it never boots Nest) and
   * aggregates `/metrics` across workers; each worker runs `bootstrap()`.
  ```

  with

  ```text
   * `bootstrap()` in this process. Otherwise the primary only supervises (it never boots Nest) and
   * serves the aggregated `/metrics` of all workers on `METRICS_PORT`; each worker runs `bootstrap()`.
  ```

In `libs/bootstrap/src/index.ts` add `export { startClusterPrimaryMetrics } from './cluster/primary-metrics.js';`
and `export { listenMetrics } from './http/listen-metrics.js';` (Biome orders them). In
`libs/bootstrap/src/http/microservice-app.ts:6` replace

```text
 * HTTP side of a gRPC/Kafka service: the port only serves `/health/*` and `/metrics` (infra
```

with

```text
 * HTTP side of a gRPC/Kafka service: the port only serves `/health/*`; `/metrics` is on `METRICS_PORT` (infra
```

and re-wrap that comment paragraph to 100 columns if Biome's line width is exceeded (`npx biome check --write`).

- [ ] **Step 8: Run the unit specs.** Same command as Step 2 (sandbox off) — Expected: PASS.

- [ ] **Step 9: Apps.** In each `apps/{monolith,gateway,identity-service,notifications-service,billing-service}/src/main.ts`:
      add `listenMetrics` to the `@platform/bootstrap` import and replace `await listen(app);` with
      `await listenMetrics(app);` + `await listen(app);` (same indentation). Comments that still put `/metrics` on
      the HTTP port (`rg -n "/metrics" apps/*/src`): in `apps/{identity,notifications,billing}-service/src/main.ts`
      replace `serves only /health/* and /metrics` with `serves only /health/* (/metrics: METRICS_PORT)`; in
      `apps/{identity,notifications,billing}-service/src/app.module.ts` replace ``serves `/health/*` and `/metrics`.``
      with ``serves `/health/*` (`/metrics` is on `METRICS_PORT`).`` (identity-service wraps it after "only", the
      other two read "The HTTP port only serves …"; keep each sentence's start).

- [ ] **Step 10: e2e and smoke specs.** Add `import { MetricsListener } from '@platform/observability';` to each of the
      five `apps/*/test/app.e2e-spec.ts` (merge into an existing `@platform/observability` import if there is one).
  - `apps/monolith/test/app.e2e-spec.ts` and `apps/gateway/test/app.e2e-spec.ts` (`inject` and `e2e.app` already
    exist): replace the whole test `it('GET /metrics → Prometheus text with the HTTP latency histogram', …)` with:

    ```ts
    it('GET /metrics is not served on the API port (METRICS_PORT has its own listener)', async () => {
      expect((await inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Prometheus text and the HTTP latency histogram', async () => {
      await inject({ method: 'GET', url: '/health/live' });
      const scrape = await e2e.app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
    });
    ```

  - `apps/{identity,notifications,billing}-service/test/app.e2e-spec.ts` (`app` is the `NestFastifyApplication`;
    the test sits in `describe('HTTP (ops only)', …)` at `apps/identity-service/test/app.e2e-spec.ts:132`,
    `apps/notifications-service/test/app.e2e-spec.ts:163`, `apps/billing-service/test/app.e2e-spec.ts:180`): replace
    the whole test `it('GET /metrics → Prometheus text (Node default metrics + HTTP latency histogram)', …)` with
    the block below.

    ```ts
    it('GET /metrics is not served on the HTTP port (METRICS_PORT has its own listener)', async () => {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Node default metrics and the HTTP latency histogram', async () => {
      await app.inject({ method: 'GET', url: '/health/live' });
      const scrape = await app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
    });
    ```

  In `libs/bootstrap/src/http/create-http-app.spec.ts` (three tests used `/metrics` on the API port; all fail
  once Step 6 lands):
  - merge `MetricsListener` into the multi-line `@platform/observability` import (`:15-19`, alphabetical, after
    `HealthContributor`);
  - in `PingController`, below the `ping()` method, add a route whose body is above the 1 KiB compression threshold
    (`COMPRESSION_OPTIONS.threshold`, `libs/bootstrap/src/http/create-http-app.ts:90`):

    ```ts
      /** Above the 1 KiB compression threshold. */
      @Get('large')
      large(): { padding: string } {
        return { padding: 'x'.repeat(4_096) };
      }
    ```

  - in "exposes Prometheus metrics with low-cardinality route labels" replace the four lines from
    `    const response = await app.inject({ method: 'GET', url: '/metrics' });` to `    const body = response.body;`
    with:

    ```ts
    // /metrics is not served on the API port (METRICS_PORT has its own listener).
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    const scrape = await app.get(MetricsListener, { strict: false }).scrape();
    expect(scrape.status).toBe(200);
    expect(scrape.contentType).toContain('text/plain');
    const body = scrape.body;
    ```

  - in "applies helmet and compression" replace `      url: '/metrics',` with `      url: '/v1/ping/large',`;
  - rename `describe('GET /metrics with METRICS_BEARER_TOKEN', …)` to
    `describe('the metrics listener with METRICS_BEARER_TOKEN', …)` and, in its test, replace everything from
    `      const scrape = (authorization?: string) =>` to
    `      expect(ok.body).toContain('process_resident_memory_bytes');` with:

    ```ts
    const listener = app.get(MetricsListener, { strict: false });
    expect((await listener.scrape()).status).toBe(404);
    expect((await listener.scrape('Bearer wrong-token-0123456789abcdef')).status).toBe(404);
    expect((await listener.scrape(TOKEN)).status).toBe(404);
    const ok = await listener.scrape(`Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('process_resident_memory_bytes');
    // Even with the right token, the API port never serves /metrics.
    const api = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(api.statusCode).toBe(404);
    ```

  In `libs/bootstrap/src/integration.smoke.spec.ts` (lane C edits its rate-limiting block `:366-375`; keep those
  lines as they are on disk):
  - `import { ObservabilityModule, RequestContextService } from '@platform/observability';` →
    `import { MetricsListener, ObservabilityModule, RequestContextService } from '@platform/observability';`
  - rename the test `'GET /metrics → 200 with http_request_duration_seconds, incl. guard rejections'` to
    `'metrics listener → 200 with http_request_duration_seconds, incl. guard rejections'` and in it replace the two
    lines

    ```ts
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    ```

    with

    ```ts
    const response = await app.get(MetricsListener, { strict: false }).scrape();
    expect(response.status).toBe(200);
    ```

    (the following `response.body` assertions stay);

  - in the maintenance-mode test (`:385`) replace
    `        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);` with
    `        expect((await app.get(MetricsListener, { strict: false }).scrape()).status).toBe(200);`.

- [ ] **Step 11: Env, compose, scrape config.** Root `.env.example`: after the line `# METRICS_BEARER_TOKEN=` insert:

```dotenv
# Separate /metrics listener (never the API port). Host dev defaults (apps/*/.env.example): 9464
# monolith | gateway, 9465 identity-service, 9466 notifications-service, 9467 billing-service.
# Every container uses 9464 (Prometheus scrapes it in-network; it is never published).
# METRICS_PORT=9464
```

`apps/monolith/.env.example` and `apps/gateway/.env.example`: after `PORT=3000` add `METRICS_PORT=9464`;
`apps/identity-service/.env.example`: after `PORT=3001` add `METRICS_PORT=9465`;
`apps/notifications-service/.env.example`: after `PORT=3002` add `METRICS_PORT=9466`;
`apps/billing-service/.env.example`: after `PORT=3003` add `METRICS_PORT=9467`. In each
`apps/<app>/test/env-example.spec.ts`, right after the line
`    expect(config.app).toMatchObject({ serviceName: '<app>', port: <port> });` add
`    expect(config.observability.metricsPort).toBe(<n>);` with `<n>` = 9464 (monolith, gateway), 9465
(identity-service), 9466 (notifications-service), 9467 (billing-service).

`docker-compose.yml:35` (`x-env-base`): replace

```text
  PORT: "3000" # every container serves HTTP (API or health + metrics) on 3000
```

with

```text
  PORT: "3000" # every container serves HTTP (API or health) on 3000
  METRICS_PORT: "9464" # /metrics listener; Prometheus scrapes it in-network, never published
```

`docker/prometheus/prometheus.yml`:

- header comment: replace `# Every app container serves HTTP (health + metrics) on port 3000 inside the network.`
  with `# Every app container serves /metrics on its own listener, port 9464 (METRICS_PORT), inside the network.`
  and, in its first line, `GET /metrics (prom-client via @willsoto/nestjs-prometheus;` with
  `GET /metrics on METRICS_PORT (prom-client;`.
- `job_name: nestjs-apps`: `        port: 3000` → `        port: 9464`.
- `job_name: host-apps`: targets `host.docker.internal:3000` … `host.docker.internal:3003` →
  `host.docker.internal:9464` … `host.docker.internal:9467`, and replace its comment block with:

  ```yaml
  # Apps started on the host (`bun run dev:*`), reached through host.docker.internal
  # (Docker Desktop built-in; `extra_hosts: host-gateway` in compose for Linux). Default host metrics
  # ports (METRICS_PORT in apps/*/.env.example): 9464 monolith|gateway, 9465 identity, 9466
  # notifications, 9467 billing. Targets that are not running are simply `down`. Containers never
  # publish 9464, so these targets cannot duplicate the in-network `nestjs-apps` job.
  ```

- [ ] **Step 12: Docs.** `docs/OBSERVABILITY.md`: overview row (`:14`) `GET /metrics` → `GET /metrics on
METRICS_PORT (9464)`; the mermaid node `ME["GET /metrics"]` → `ME["GET /metrics :9464"]`; rewrite "### `GET
/metrics` and its protection" (`:189-207`): served by a separate `node:http` listener on `METRICS_PORT`
      (default 9464, host dev 9464-9467), never on the API port (which answers 404); `METRICS_ENABLED=false` = no
      listener; `METRICS_BEARER_TOKEN` unchanged (404 on a missing/wrong token); curl examples on
      `http://localhost:9464/metrics`; production: do not publish `METRICS_PORT` outside the cluster network. "###
      Cluster mode" (`:209`): the primary serves the aggregate on `METRICS_PORT`, workers never bind it. "### Scrape
      configuration (local)" table: port 9464 / host ports 9464-9467, `service="host:9464"`. Configuration reference
      (`:416`): add a `METRICS_PORT` row (`9464`, "separate listener; must differ from `PORT`; `0` = OS-picked").
      In "## Known follow-ups" delete the "**Separate metrics listener.**" bullet. `docs/CONFIGURATION.md`: in the
      observability variables table add a `METRICS_PORT` row after `METRICS_BEARER_TOKEN` (default `9464`, the
      per-app host defaults, "must differ from `PORT`"). `libs/observability/README.md`: replace the
      `MetricsController` row with `MetricsListener` (`start()`, `scrape()`; `/metrics` on `METRICS_PORT`) and add
      `startMetricsServer(options)`, `scrapeMetrics(options, request)`; replace the cluster row's functions with
      `enableClusterMetricsWorker()`, `collectClusterMetrics()`. `libs/bootstrap/README.md`: add rows for
      `listenMetrics(app)` and `startClusterPrimaryMetrics(env?)`.

- [ ] **Step 13: Run.** `npx vitest run --project observability --project bootstrap --project config` and (sandbox
      off) `bun run test:e2e` plus `npx vitest run --project monolith --project gateway --project identity-service
--project notifications-service --project billing-service env-example` — Expected: PASS.
      `node scripts/check-env-example.mjs` — Expected: OK. `bash scripts/docker/validate-compose.sh` — Expected: OK.

- [ ] **Step 14: Wider checks.** `npx biome check --write libs/observability libs/bootstrap libs/config apps`;
      `npx prettier --write docs/OBSERVABILITY.md docs/CONFIGURATION.md libs/observability/README.md
libs/bootstrap/README.md docker-compose.yml docker/prometheus/prometheus.yml`; `bun run check` — Expected:
      exit 0.

- [ ] **Step 15: Commit.**

```bash
git add libs/observability libs/bootstrap libs/config apps .env.example docker-compose.yml \
  docker/prometheus/prometheus.yml docs/OBSERVABILITY.md docs/CONFIGURATION.md
git commit -S -m "feat(observability,bootstrap,config): serve /metrics on a separate METRICS_PORT listener" \
  -m "Default 9464 (host dev 9464-9467). The API port answers 404 for /metrics; the cluster primary" \
  -m "serves the worker aggregate; workers never bind the port."
```

### Task 7: gRPC client and server call metrics (G-5; FU-4)

**Files:**

- Create: `libs/observability/src/metrics/metric-registry.ts`, `libs/transport/src/grpc/grpc-metrics.ts`,
  `libs/transport/src/grpc/grpc-metrics.interceptor.ts`
- Test: `libs/observability/src/metrics/metric-registry.spec.ts`, `libs/transport/src/grpc/grpc-metrics.spec.ts`
- Modify: `libs/observability/src/index.ts`, `libs/transport/src/grpc/grpc-call.ts`,
  `libs/transport/src/grpc/grpc-controller.decorator.ts`, `libs/transport/src/grpc/grpc-enhancers.spec.ts:94-103`,
  `libs/transport/src/index.ts`, `docs/OBSERVABILITY.md` ("### What is exported"), `libs/transport/README.md`,
  `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts:103` (`grpc_service` normalization)

**Interfaces:**

- Consumes: Task 6 (`MetricsListener` exposes everything in prom-client's default registry); `HTTP_DURATION_BUCKETS`.
- Produces:
  - `@platform/observability`: `getOrCreateCounter<T extends string>(config: CounterConfiguration<T>): Counter<T>`,
    `getOrCreateGauge<T extends string>(config: GaugeConfiguration<T>): Gauge<T>`,
    `getOrCreateHistogram<T extends string>(config: HistogramConfiguration<T>): Histogram<T>` (throw when the name
    is registered with another metric type).
  - `@platform/transport`: `GRPC_SERVER_HANDLED_TOTAL = 'grpc_server_handled_total'`,
    `GRPC_SERVER_HANDLING_SECONDS = 'grpc_server_handling_seconds'`,
    `GRPC_CLIENT_HANDLED_TOTAL = 'grpc_client_handled_total'`,
    `GRPC_CLIENT_HANDLING_SECONDS = 'grpc_client_handling_seconds'`,
    `interface GrpcCallTarget { readonly service: string; readonly method: string }`,
    `parseGrpcOperation(operation: string): GrpcCallTarget`, `grpcClientCode(error: unknown): string`,
    `type GrpcSide = 'client' | 'server'`,
    `recordGrpcCall(side: GrpcSide, target: GrpcCallTarget, code: string, seconds: number): void`,
    `class GrpcMetricsInterceptor implements NestInterceptor` (applied by `@GrpcController()`).
  - Series: `grpc_{client,server}_handled_total{grpc_service,grpc_method,grpc_code}` (counter),
    `grpc_{client,server}_handling_seconds{grpc_service,grpc_method}` (histogram, HTTP buckets). `grpc_code` = grpc
    status name (`OK`, `NOT_FOUND`, …); client side also `DEADLINE_EXCEEDED` for the local deadline and
    `CIRCUIT_OPEN` when the breaker rejected without sending. `grpc_service` is the fully qualified proto service
    name on both sides (`identity.v1.AuthService`, `identity.v1.UsersService`, `notifications.v1.NotificationsService`,
    `billing.v1.BillingService`): the server reads it from the grpc-js path, the client from the adapter's
    `operation`, and Step 4 normalizes billing's adapter (it wrote `billing.BillingService`).

**Wave:** after Task 6 (Lane M).

- [ ] **Step 1: Write the failing specs.** `libs/observability/src/metrics/metric-registry.spec.ts`:

```ts
import { Counter, register } from 'prom-client';
import { getOrCreateCounter, getOrCreateGauge, getOrCreateHistogram } from './metric-registry.js';

describe('getOrCreate* (process-wide metrics outside DI)', () => {
  it('returns the already registered metric instead of throwing a duplicate', () => {
    const first = getOrCreateCounter({ name: 'test_registry_total', help: 'h', labelNames: ['a'] });
    const second = getOrCreateCounter({
      name: 'test_registry_total',
      help: 'h',
      labelNames: ['a'],
    });
    expect(second).toBe(first);
    expect(first).toBeInstanceOf(Counter);
    expect(register.getSingleMetric('test_registry_total')).toBe(first);
  });

  it('throws when the name is taken by another metric type', () => {
    getOrCreateGauge({ name: 'test_registry_gauge', help: 'h' });
    expect(() => getOrCreateHistogram({ name: 'test_registry_gauge', help: 'h' })).toThrow(
      'test_registry_gauge is already registered as another metric type',
    );
  });
});
```

`libs/transport/src/grpc/grpc-metrics.spec.ts`:

```ts
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { type Histogram, register } from 'prom-client';
import { lastValueFrom, NEVER, of, throwError } from 'rxjs';
import { grpcCall } from './grpc-call.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { GrpcMetricsInterceptor } from './grpc-metrics.interceptor.js';
import { grpcClientCode, parseGrpcOperation } from './grpc-metrics.js';

async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const { values } = await metric.get();
  const match = values.find((sample) =>
    Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
  );
  return match?.value ?? 0;
}

const rpcContext = (path: string): ExecutionContext =>
  ({
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => new Metadata(), getData: () => ({}) }),
    getArgByIndex: (index: number) => (index === 2 ? { getPath: () => path } : undefined),
    getClass: () => class Svc {},
    getHandler: () => () => undefined,
  }) as unknown as ExecutionContext;

describe('gRPC metrics', () => {
  it('parses operations and grpc-js paths', () => {
    expect(parseGrpcOperation('orders.v1.OrdersService/GetOrder')).toEqual({
      service: 'orders.v1.OrdersService',
      method: 'GetOrder',
    });
    expect(parseGrpcOperation('/orders.v1.OrdersService/ListOrders')).toEqual({
      service: 'orders.v1.OrdersService',
      method: 'ListOrders',
    });
  });

  it('labels client failures', () => {
    expect(grpcClientCode(Object.assign(new Error('x'), { code: 'EOPENBREAKER' }))).toBe(
      'CIRCUIT_OPEN',
    );
    expect(grpcClientCode(new Error('x'))).toBe('UNKNOWN');
  });

  it('grpcCall counts successes, local deadlines and an open circuit', async () => {
    const labels = { grpc_service: 'test.v1.Svc', grpc_method: 'Get' };
    const ok = await value('grpc_client_handled_total', { ...labels, grpc_code: 'OK' });
    await grpcCall(of(1), { timeoutMs: 1_000, operation: 'test.v1.Svc/Get' });
    expect(await value('grpc_client_handled_total', { ...labels, grpc_code: 'OK' })).toBe(ok + 1);

    await expect(grpcCall(NEVER, { timeoutMs: 5, operation: 'test.v1.Svc/Get' })).rejects.toThrow();
    expect(
      await value('grpc_client_handled_total', { ...labels, grpc_code: 'DEADLINE_EXCEEDED' }),
    ).toBeGreaterThan(0);

    const breakers = new GrpcCircuitBreakers();
    const breaker = breakers.get('test');
    breaker.open();
    await expect(
      grpcCall(of(1), { timeoutMs: 1_000, operation: 'test.v1.Svc/Get', breaker }),
    ).rejects.toThrow();
    expect(
      await value('grpc_client_handled_total', { ...labels, grpc_code: 'CIRCUIT_OPEN' }),
    ).toBeGreaterThan(0);
    breakers.onApplicationShutdown();
  });

  it('the server interceptor counts OK and failed calls with their status', async () => {
    const interceptor = new GrpcMetricsInterceptor();
    const labels = { grpc_service: 'test.v1.Server', grpc_method: 'Do' };
    const ok = await value('grpc_server_handled_total', { ...labels, grpc_code: 'OK' });
    const next: CallHandler = { handle: () => of('done') };
    await lastValueFrom(interceptor.intercept(rpcContext('/test.v1.Server/Do'), next));
    expect(await value('grpc_server_handled_total', { ...labels, grpc_code: 'OK' })).toBe(ok + 1);

    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext('/test.v1.Server/Do'), failing)),
    ).rejects.toThrow('boom');
    expect(
      await value('grpc_server_handled_total', { ...labels, grpc_code: 'INTERNAL' }),
    ).toBeGreaterThan(0);
    const histogram = await (
      register.getSingleMetric('grpc_server_handling_seconds') as Histogram | undefined
    )?.get();
    const count = histogram?.values.find(
      (sample) =>
        sample.metricName === 'grpc_server_handling_seconds_count' &&
        sample.labels['grpc_service'] === 'test.v1.Server',
    );
    expect(count?.value).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project observability --project transport metric-registry
grpc-metrics` — Expected: FAIL (modules missing).

- [ ] **Step 3: Registry helpers.** Create `libs/observability/src/metrics/metric-registry.ts`:

```ts
import {
  Counter,
  type CounterConfiguration,
  Gauge,
  type GaugeConfiguration,
  Histogram,
  type HistogramConfiguration,
  register,
} from 'prom-client';

/**
 * Process-wide metrics created outside DI (functions such as `grpcCall`, interceptors built with
 * `new`, pool wrappers). prom-client's default registry is global and throws on a second metric with
 * the same name, so these return the one already registered (several Nest apps in one test process,
 * repeated module registrations). `MetricsListener` serves the same registry.
 */
export function getOrCreateCounter<T extends string>(config: CounterConfiguration<T>): Counter<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Counter(config);
  if (existing instanceof Counter) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}

export function getOrCreateGauge<T extends string>(config: GaugeConfiguration<T>): Gauge<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Gauge(config);
  if (existing instanceof Gauge) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}

export function getOrCreateHistogram<T extends string>(
  config: HistogramConfiguration<T>,
): Histogram<T> {
  const existing = register.getSingleMetric(config.name);
  if (existing === undefined) return new Histogram(config);
  if (existing instanceof Histogram) return existing;
  throw new Error(`${config.name} is already registered as another metric type`);
}
```

Export them from `libs/observability/src/index.ts`:
`export { getOrCreateCounter, getOrCreateGauge, getOrCreateHistogram } from './metrics/metric-registry.js';`

- [ ] **Step 4: gRPC metrics.** Create `libs/transport/src/grpc/grpc-metrics.ts`:

```ts
import {
  getOrCreateCounter,
  getOrCreateHistogram,
  HTTP_DURATION_BUCKETS,
} from '@platform/observability';
import { isObjectLike } from 'lodash-es';
import { TimeoutError } from 'rxjs';
import { grpcStatusName, isGrpcServiceError } from './grpc-status.mapping.js';

export const GRPC_SERVER_HANDLED_TOTAL = 'grpc_server_handled_total';
export const GRPC_SERVER_HANDLING_SECONDS = 'grpc_server_handling_seconds';
export const GRPC_CLIENT_HANDLED_TOTAL = 'grpc_client_handled_total';
export const GRPC_CLIENT_HANDLING_SECONDS = 'grpc_client_handling_seconds';

export interface GrpcCallTarget {
  readonly service: string;
  readonly method: string;
}

export type GrpcSide = 'client' | 'server';

/** `orders.v1.OrdersService/GetOrder` or a grpc-js path `/orders.v1.OrdersService/GetOrder`. */
export function parseGrpcOperation(operation: string): GrpcCallTarget {
  const path = operation.startsWith('/') ? operation.slice(1) : operation;
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { service: 'unknown', method: path }
    : { service: path.slice(0, slash), method: path.slice(slash + 1) };
}

/**
 * Client-side `grpc_code` of a failed call: the grpc-js status name, `DEADLINE_EXCEEDED` for the
 * local rxjs deadline, `CIRCUIT_OPEN` when the breaker rejected the call without sending it,
 * `UNKNOWN` otherwise.
 */
export function grpcClientCode(error: unknown): string {
  if (isGrpcServiceError(error)) return grpcStatusName(error.code);
  if (error instanceof TimeoutError) return 'DEADLINE_EXCEEDED';
  if (isObjectLike(error) && (error as { code?: unknown }).code === 'EOPENBREAKER') {
    return 'CIRCUIT_OPEN';
  }
  return 'UNKNOWN';
}

const handled = (side: GrpcSide) =>
  getOrCreateCounter({
    name: side === 'client' ? GRPC_CLIENT_HANDLED_TOTAL : GRPC_SERVER_HANDLED_TOTAL,
    help: `gRPC ${side} calls completed, by service, method and status code`,
    labelNames: ['grpc_service', 'grpc_method', 'grpc_code'],
  });

const handling = (side: GrpcSide) =>
  getOrCreateHistogram({
    name: side === 'client' ? GRPC_CLIENT_HANDLING_SECONDS : GRPC_SERVER_HANDLING_SECONDS,
    help: `gRPC ${side} call duration in seconds, by service and method`,
    labelNames: ['grpc_service', 'grpc_method'],
    buckets: [...HTTP_DURATION_BUCKETS],
  });

/** Records one finished unary call (`code` is `OK` on success). */
export function recordGrpcCall(
  side: GrpcSide,
  target: GrpcCallTarget,
  code: string,
  seconds: number,
): void {
  const labels = { grpc_service: target.service, grpc_method: target.method };
  handled(side).inc({ ...labels, grpc_code: code });
  handling(side).observe(labels, seconds);
}
```

Create `libs/transport/src/grpc/grpc-metrics.interceptor.ts`:

```ts
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { getContextType } from '@platform/common';
import { isObjectLike } from 'lodash-es';
import { catchError, type Observable, tap, throwError } from 'rxjs';
import { isGrpcMetadata } from './grpc-metadata.js';
import { parseGrpcOperation, recordGrpcCall } from './grpc-metrics.js';
import { exceptionToGrpcError, grpcStatusName } from './grpc-status.mapping.js';

/**
 * Server-side gRPC call metrics (applied by `@GrpcController()`, inside `GrpcContextInterceptor`).
 * The method comes from grpc-js `call.getPath()`; a failure is labelled with the status the
 * controller's `DomainToGrpcExceptionFilter` will send (`exceptionToGrpcError`). No-op outside gRPC.
 */
@Injectable()
export class GrpcMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      getContextType(context) !== 'rpc' ||
      !isGrpcMetadata(context.switchToRpc().getContext<unknown>())
    ) {
      return next.handle();
    }
    const call: unknown = context.getArgByIndex(2);
    const path =
      isObjectLike(call) && typeof (call as { getPath?: unknown }).getPath === 'function'
        ? (call as { getPath(): string }).getPath()
        : `${context.getClass().name}/${context.getHandler().name}`;
    const target = parseGrpcOperation(path);
    const startedAt = performance.now();
    const seconds = (): number => (performance.now() - startedAt) / 1_000;
    return next.handle().pipe(
      tap({ complete: () => recordGrpcCall('server', target, 'OK', seconds()) }),
      catchError((error: unknown) => {
        recordGrpcCall(
          'server',
          target,
          grpcStatusName(exceptionToGrpcError(error).code),
          seconds(),
        );
        return throwError(() => error);
      }),
    );
  }
}
```

`libs/transport/src/grpc/grpc-call.ts`: add `import { grpcClientCode, parseGrpcOperation, recordGrpcCall }
from './grpc-metrics.js';` and replace the body of `grpcCall` with:

```ts
const task = (): Promise<T> => lastValueFrom(source.pipe(timeout({ first: options.timeoutMs })));
const target = parseGrpcOperation(options.operation);
const startedAt = performance.now();
const seconds = (): number => (performance.now() - startedAt) / 1_000;
try {
  // The breaker's action is `(task) => task()`, so the resolved value is exactly task()'s T.
  const result =
    options.breaker === undefined ? await task() : ((await options.breaker.fire(task)) as T);
  recordGrpcCall('client', target, 'OK', seconds());
  return result;
} catch (error) {
  recordGrpcCall('client', target, grpcClientCode(error), seconds());
  throw grpcErrorToDomainException(error, options.operation);
}
```

In the same file replace the `operation` doc comment
``/** For logs and error details, e.g. `'orders.OrdersService/GetOrder'`. */`` (`:11`) with the
comment below, indented two spaces as in the file, so every new adapter (B2 and on) writes the fully qualified
name the server side reports:

```ts
/**
 * `<proto package>.<Service>/<Method>`, e.g. `'orders.v1.OrdersService/GetOrder'`: logs, error details
 * and the `grpc_client_*` labels. Build it from the contracts' package constant and service name.
 */
```

`libs/transport/src/grpc/grpc-controller.decorator.ts`:

- add `import { GrpcMetricsInterceptor } from './grpc-metrics.interceptor.js';`;
- replace `    UseInterceptors(GrpcContextInterceptor),` with
  `    UseInterceptors(GrpcContextInterceptor, GrpcMetricsInterceptor),`;
- in the doc comment replace

  ```text
   * Use this instead of `@Controller()` on every gRPC controller. It applies
   * `DomainToGrpcExceptionFilter` and `GrpcContextInterceptor` at controller scope, which is the only
  ```

  with

  ```text
   * Use this instead of `@Controller()` on every gRPC controller. It applies
   * `DomainToGrpcExceptionFilter`, `GrpcContextInterceptor` and `GrpcMetricsInterceptor` (the
   * `grpc_server_*` call metrics) at controller scope, which is the only
  ```

`libs/transport/src/grpc/grpc-enhancers.spec.ts` (it pins the controller-scope interceptors and fails otherwise):
add `import { GrpcMetricsInterceptor } from './grpc-metrics.interceptor.js';`, rename the test
`'is a Nest controller with the gRPC filter and context interceptor at controller scope'` to
`'is a Nest controller with the gRPC filter, context and metrics interceptors at controller scope'`, and add
`      GrpcMetricsInterceptor,` after `      GrpcContextInterceptor,` in its `INTERCEPTORS_METADATA` expectation.

`libs/transport/src/index.ts`: insert the two lines `export * from './grpc/grpc-metrics.js';` and
`export * from './grpc/grpc-metrics.interceptor.js';` right after `export * from './grpc/grpc-metadata.js';`
(alphabetical; never at the end of the file, which Task 4 edits).

`domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts:103` (controller ruling: `grpc_service` is
the fully qualified proto service name, as identity's and notifications' adapters already write it; both names are
already imported from `@domain/billing-contracts` at `:1-3`): replace

```ts
      operation: `billing.BillingService/${method}`,
```

with

```ts
      operation: `${BILLING_GRPC_PACKAGE.package}.${BILLING_SERVICE_NAME}/${method}`,
```

(`billing.v1.BillingService/<method>`, the same string grpc-js reports on the server side). Nothing asserts the old
string (`rg -n "billing\.BillingService" apps domains libs` → only this line).

- [ ] **Step 5: Run.** `npx vitest run --project observability --project transport --project billing` — Expected:
      PASS (existing grpc-call, grpc-roundtrip and enhancer specs included). Then (sandbox off)
      `npx vitest run --project identity-service:e2e --project billing-service:e2e --project gateway:e2e` —
      Expected: PASS.

- [ ] **Step 6: Docs.** `docs/OBSERVABILITY.md` "### What is exported": add rows for
      `grpc_server_handled_total` / `grpc_server_handling_seconds` (every `@GrpcController()`) and
      `grpc_client_handled_total` / `grpc_client_handling_seconds` (every `grpcCall`), with the label sets and code
      values from **Interfaces** above. `libs/transport/README.md`: add `GrpcMetricsInterceptor`, `recordGrpcCall`,
      `parseGrpcOperation`, `grpcClientCode` rows and note that `@GrpcController()` applies the interceptor.

- [ ] **Step 7: Wider checks.** `npx biome check --write libs/observability libs/transport`; `npx prettier --write
docs/OBSERVABILITY.md libs/transport/README.md`; `bun run check` — Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add libs/observability libs/transport docs/OBSERVABILITY.md \
  domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts
git commit -S -m "feat(observability,transport,billing): gRPC client and server call metrics" \
  -m "grpc_{client,server}_handled_total and _handling_seconds; getOrCreate* helpers for metrics" \
  -m "created outside DI."
```

### Task 8: Circuit-breaker state gauge (G-6; FU-4)

**Files:**

- Modify: `libs/transport/src/grpc/grpc-metrics.ts`, `libs/transport/src/grpc/grpc-circuit-breakers.ts`,
  `docs/OBSERVABILITY.md`
- Test: `libs/transport/src/grpc/grpc-breaker-metrics.spec.ts`

**Interfaces:**

- Consumes: Task 7 (`getOrCreateGauge`, `grpc-metrics.ts`).
- Produces: `GRPC_CIRCUIT_BREAKER_STATE = 'grpc_client_circuit_breaker_state'`,
  `type CircuitState = 'open' | 'half-open' | 'closed'`,
  `trackCircuitBreakerStates(states: () => Record<string, CircuitState>): () => void`. Series
  `grpc_client_circuit_breaker_state{upstream,state}` with `state` ∈ `closed | half_open | open`: 1 for the current
  state, 0 for the other two, one triple per upstream of every live `GrpcCircuitBreakers` instance (one per
  `GrpcClientsModule.register()` call).

**Wave:** after Task 7 (Lane M).

- [ ] **Step 1: Write the failing spec.** `libs/transport/src/grpc/grpc-breaker-metrics.spec.ts`:

```ts
import { register } from 'prom-client';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';

async function states(upstream: string): Promise<Record<string, number>> {
  const metric = register.getSingleMetric('grpc_client_circuit_breaker_state');
  if (metric === undefined) return {};
  const { values } = await metric.get();
  return Object.fromEntries(
    values
      .filter((sample) => sample.labels['upstream'] === upstream)
      .map((sample) => [String(sample.labels['state']), sample.value]),
  );
}

describe('grpc_client_circuit_breaker_state', () => {
  it('exposes each upstream one-hot and forgets it on shutdown', async () => {
    const breakers = new GrpcCircuitBreakers();
    const breaker = breakers.get('orders-gauge');
    expect(await states('orders-gauge')).toEqual({ closed: 1, half_open: 0, open: 0 });
    breaker.open();
    expect(await states('orders-gauge')).toEqual({ closed: 0, half_open: 0, open: 1 });
    breakers.onApplicationShutdown();
    expect(await states('orders-gauge')).toEqual({});
  });

  it('merges the breakers of several GrpcClientsModule registrations', async () => {
    const a = new GrpcCircuitBreakers();
    const b = new GrpcCircuitBreakers();
    a.get('upstream-a');
    b.get('upstream-b');
    expect(await states('upstream-a')).toMatchObject({ closed: 1 });
    expect(await states('upstream-b')).toMatchObject({ closed: 1 });
    a.onApplicationShutdown();
    b.onApplicationShutdown();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project transport grpc-breaker-metrics` — Expected: FAIL (`{}` instead
      of the closed/open triple: the gauge does not exist).

- [ ] **Step 3: Implement.** Append to `libs/transport/src/grpc/grpc-metrics.ts` (add `getOrCreateGauge` to its
      `@platform/observability` import):

```ts
export const GRPC_CIRCUIT_BREAKER_STATE = 'grpc_client_circuit_breaker_state';

export type CircuitState = 'open' | 'half-open' | 'closed';
const CIRCUIT_STATES: readonly CircuitState[] = ['closed', 'half-open', 'open'];
const breakerSources = new Set<() => Record<string, CircuitState>>();

/**
 * Adds a source of breaker states (one per `GrpcCircuitBreakers` instance) to
 * `grpc_client_circuit_breaker_state{upstream, state}`; returns its removal. Read on every scrape.
 */
export function trackCircuitBreakerStates(states: () => Record<string, CircuitState>): () => void {
  getOrCreateGauge({
    name: GRPC_CIRCUIT_BREAKER_STATE,
    help: 'gRPC client circuit breaker state per upstream: 1 for the current state (closed, half_open, open)',
    labelNames: ['upstream', 'state'],
    collect() {
      this.reset();
      for (const source of breakerSources) {
        for (const [upstream, current] of Object.entries(source())) {
          for (const state of CIRCUIT_STATES) {
            this.set({ upstream, state: state.replace('-', '_') }, state === current ? 1 : 0);
          }
        }
      }
    },
  });
  breakerSources.add(states);
  return () => {
    breakerSources.delete(states);
  };
}
```

In `libs/transport/src/grpc/grpc-circuit-breakers.ts`:

- add `import { trackCircuitBreakerStates } from './grpc-metrics.js';`;
- below the line `  private readonly options: GrpcCircuitBreakerOptions;` add:

  ```ts
    /** Feeds `grpc_client_circuit_breaker_state` until shutdown. */
    private readonly untrackStates = trackCircuitBreakerStates(() => this.states());
  ```

- in `onApplicationShutdown()` add `    this.untrackStates();` as the first statement;
- replace the `states()` doc comment
  `  /** State of every breaker created so far (diagnostics / debug endpoints). */` with
  `  /** State of every breaker so far (the grpc_client_circuit_breaker_state gauge, diagnostics). */`.

(Field initialisers run before the constructor body with `useDefineForClassFields: false`; `this.states()` is
only called at scrape time. `grpc-metrics.ts` does not import `grpc-circuit-breakers.ts`, so there is no import
cycle.)

- [ ] **Step 4: Run.** `npx vitest run --project transport` — Expected: PASS.

- [ ] **Step 5: Docs.** `docs/OBSERVABILITY.md` "### What is exported": add the `grpc_client_circuit_breaker_state`
      row (labels, one-hot values, example alert `grpc_client_circuit_breaker_state{state="open"} == 1`); in "##
      Known follow-ups" delete the "**No app-level gRPC, Kafka, cache or database metrics**" bullet only after Task
      10 (Task 10 Step 6 does it).

- [ ] **Step 6: Wider checks.** `npx biome check --write libs/transport`; `npx prettier --write docs/OBSERVABILITY.md`;
      `bun run check` — Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add libs/transport docs/OBSERVABILITY.md
git commit -S -m "feat(transport): expose gRPC circuit breaker state as a gauge"
```

### Task 9: Kafka consumer lag and handler outcomes (G-7; FU-4)

**Files:**

- Create: `libs/transport/src/kafka/kafka-metrics.ts`, `libs/transport/src/kafka/instrumented-server-kafka.ts`
- Test: `libs/transport/src/kafka/kafka-metrics.spec.ts`
- Modify: `libs/transport/src/kafka/kafka.options.ts:92-95` (return type),
  `libs/transport/src/hybrid/connect-microservices.ts:70-78`, `libs/transport/src/hybrid/connect-microservices.spec.ts:67-140`,
  `libs/transport/src/kafka/kafka-context.interceptor.ts`, `libs/transport/src/kafka/kafka-retry.interceptor.ts`,
  `libs/transport/src/kafka/kafka-dead-letter.filter.ts`, `libs/transport/src/index.ts`, `docs/OBSERVABILITY.md`,
  `libs/transport/README.md`

**Interfaces:**

- Consumes: Task 7 (`getOrCreateCounter`, `getOrCreateGauge`).
- Produces:
  - `KAFKA_CONSUMER_MESSAGES_TOTAL = 'kafka_consumer_messages_total'`,
    `KAFKA_CONSUMER_RETRIES_TOTAL = 'kafka_consumer_retries_total'`, `KAFKA_CONSUMER_LAG = 'kafka_consumer_lag'`,
    `type KafkaMessageOutcome = 'success' | 'dead_letter' | 'redelivery'`,
    `recordKafkaOutcome(topic: string, outcome: KafkaMessageOutcome): void`, `recordKafkaRetry(topic: string): void`,
    `type KafkaConsumerLike = Parameters<ServerKafka['bindEvents']>[0]`,
    `instrumentKafkaConsumer(consumer: KafkaConsumerLike, groupId: string): void`,
    `class InstrumentedServerKafka extends ServerKafka { constructor(readonly kafkaOptions:
Required<KafkaOptions>['options']); bindEvents(consumer: KafkaConsumerLike): Promise<void> }`.
  - `createKafkaServerOptions(...)` now returns `KafkaOptions & Required<Pick<KafkaOptions, 'options'>>`;
    `connectKafkaConsumer(app, options?)` connects `{ strategy: new InstrumentedServerKafka(...) }` (same options as
    before, so the same consumer group, client id and subscriptions).
  - Series: `kafka_consumer_messages_total{topic,outcome}` (`success`: the handler completed, after in-process
    retries if any; `dead_letter`: published to `<topic>.dlq`; `redelivery`: left for kafkajs to redeliver — a
    `KafkaRetriableException` or a failed DLQ publish), `kafka_consumer_retries_total{topic}` (in-process retries of
    `KafkaRetryInterceptor`), `kafka_consumer_lag{group,topic,partition}` (kafkajs `END_BATCH_PROCESS.offsetLag`:
    updated at the end of each batch, so it holds the last batch's value while a partition is idle or stuck).

**Wave:** after Task 8 (Lane M).

- [ ] **Step 1: Write the failing spec.** `libs/transport/src/kafka/kafka-metrics.spec.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { KafkaContext, ServerKafka } from '@nestjs/microservices';
import type { ClsService } from 'nestjs-cls';
import { register } from 'prom-client';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InstrumentedServerKafka } from './instrumented-server-kafka.js';
import { KafkaContextInterceptor } from './kafka-context.interceptor.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import {
  instrumentKafkaConsumer,
  type KafkaConsumerLike,
  recordKafkaOutcome,
  recordKafkaRetry,
} from './kafka-metrics.js';
import { KafkaRetryInterceptor } from './kafka-retry.interceptor.js';

async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const { values } = await metric.get();
  return (
    values.find((sample) =>
      Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
    )?.value ?? 0
  );
}

function fakeConsumer(): { consumer: KafkaConsumerLike; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const consumer = {
    events: { END_BATCH_PROCESS: 'consumer.end_batch_process' },
    on: (event: string, listener: (payload: unknown) => void) => emitter.on(event, listener),
  } as unknown as KafkaConsumerLike;
  return { consumer, emitter };
}

describe('Kafka consumer metrics', () => {
  it('counts outcomes and retries per topic', async () => {
    const topic = 'test.metrics.v1';
    const before = await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' });
    recordKafkaOutcome(topic, 'dead_letter');
    recordKafkaRetry(topic);
    expect(await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' })).toBe(
      before + 1,
    );
    expect(await value('kafka_consumer_retries_total', { topic })).toBeGreaterThan(0);
  });

  it('sets the lag of each partition at the end of every batch', async () => {
    const { consumer, emitter } = fakeConsumer();
    instrumentKafkaConsumer(consumer, 'orders-push');
    emitter.emit('consumer.end_batch_process', {
      payload: { topic: 'orders.created.v1', partition: 2, offsetLag: '42' },
    });
    expect(
      await value('kafka_consumer_lag', {
        group: 'orders-push',
        topic: 'orders.created.v1',
        partition: '2',
      }),
    ).toBe(42);
  });

  it('InstrumentedServerKafka instruments the consumer before Nest binds its handlers', async () => {
    const bind = vi.spyOn(ServerKafka.prototype, 'bindEvents').mockResolvedValue(undefined);
    const server = new InstrumentedServerKafka({ consumer: { groupId: 'g1' } });
    const { consumer, emitter } = fakeConsumer();
    await server.bindEvents(consumer);
    expect(bind).toHaveBeenCalledWith(consumer);
    expect(emitter.listenerCount('consumer.end_batch_process')).toBe(1);
  });

  describe('through the real consumer pipeline', () => {
    const message = (topic: string) =>
      new KafkaContext([
        {
          key: null,
          value: Buffer.from('{"id":"evt-1"}'),
          headers: {},
          offset: '7',
          timestamp: '0',
          attributes: 0,
          size: 0,
        } as never,
        0,
        topic,
        {} as never,
        async () => undefined,
        { send: vi.fn().mockResolvedValue([]) } as never,
      ]);
    const rpc = (context: KafkaContext) =>
      ({
        getType: () => 'rpc',
        switchToRpc: () => ({ getContext: () => context, getData: () => ({ id: 'evt-1' }) }),
      }) as unknown as ExecutionContext & ArgumentsHost;
    const cls = {
      run: (_options: unknown, fn: () => unknown) => fn(),
      set: () => undefined,
    } as unknown as ClsService;

    it('KafkaContextInterceptor counts a handled message as success', async () => {
      const topic = 'test.success.v1';
      const before = await value('kafka_consumer_messages_total', { topic, outcome: 'success' });
      await lastValueFrom(
        new KafkaContextInterceptor(cls).intercept(rpc(message(topic)), { handle: () => of('ok') }),
      );
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'success' })).toBe(
        before + 1,
      );
    });

    it('KafkaRetryInterceptor counts each in-process retry', async () => {
      const topic = 'test.retry.v1';
      let calls = 0;
      const handler = {
        handle: () =>
          defer(() => (calls++ === 0 ? throwError(() => new Error('transient')) : of('ok'))),
      };
      await lastValueFrom(
        new KafkaRetryInterceptor({ attempts: 2 }).intercept(rpc(message(topic)), handler),
      );
      expect(await value('kafka_consumer_retries_total', { topic })).toBe(1);
    });

    it('KafkaDeadLetterFilter counts dead letters, and redelivery when the DLQ publish fails', async () => {
      const topic = 'test.dlq.v1';
      await lastValueFrom(
        new KafkaDeadLetterFilter().catch(new Error('poison'), rpc(message(topic))),
      );
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'dead_letter' })).toBe(
        1,
      );

      const broken = message(topic);
      vi.mocked(broken.getProducer().send).mockRejectedValue(new Error('broker down'));
      await expect(
        lastValueFrom(new KafkaDeadLetterFilter().catch(new Error('poison'), rpc(broken))),
      ).rejects.toThrow('poison');
      expect(await value('kafka_consumer_messages_total', { topic, outcome: 'redelivery' })).toBe(
        1,
      );
    });
  });
});
```

(Verified at `9600510`: `buildDeadLetterRecord` reads only `key`, `value`, `headers` and `offset` of the message,
which the fixture has; `isRetriableKafkaHandlerError(new Error('transient'))` is `true`. Fixture names are neutral
(`orders.*`, `test.*`): lane E's `scripts/libs-vocabulary.spec.ts` rejects domain words in `libs/**` specs.)

- [ ] **Step 2: Run it.** `npx vitest run --project transport kafka-metrics` — Expected: FAIL (modules missing).

- [ ] **Step 3: Metrics.** Create `libs/transport/src/kafka/kafka-metrics.ts`:

```ts
import type { ServerKafka } from '@nestjs/microservices';
import { getOrCreateCounter, getOrCreateGauge } from '@platform/observability';

export const KAFKA_CONSUMER_MESSAGES_TOTAL = 'kafka_consumer_messages_total';
export const KAFKA_CONSUMER_RETRIES_TOTAL = 'kafka_consumer_retries_total';
export const KAFKA_CONSUMER_LAG = 'kafka_consumer_lag';

/** `success`: handled; `dead_letter`: sent to `<topic>.dlq`; `redelivery`: left to kafkajs. */
export type KafkaMessageOutcome = 'success' | 'dead_letter' | 'redelivery';

/** The consumer Nest hands to `ServerKafka.bindEvents` (Nest's copy of the kafkajs typings). */
export type KafkaConsumerLike = Parameters<ServerKafka['bindEvents']>[0];

const messages = () =>
  getOrCreateCounter({
    name: KAFKA_CONSUMER_MESSAGES_TOTAL,
    help: 'Kafka messages consumed, by topic and outcome (success, dead_letter, redelivery)',
    labelNames: ['topic', 'outcome'],
  });

const retries = () =>
  getOrCreateCounter({
    name: KAFKA_CONSUMER_RETRIES_TOTAL,
    help: 'In-process retries of Kafka handlers (KafkaRetryInterceptor), by topic',
    labelNames: ['topic'],
  });

const lag = () =>
  getOrCreateGauge({
    name: KAFKA_CONSUMER_LAG,
    help: 'Kafka consumer lag in messages at the end of the last batch, by group, topic and partition',
    labelNames: ['group', 'topic', 'partition'],
  });

export function recordKafkaOutcome(topic: string, outcome: KafkaMessageOutcome): void {
  messages().inc({ topic, outcome });
}

export function recordKafkaRetry(topic: string): void {
  retries().inc({ topic });
}

/** Feeds `kafka_consumer_lag` from kafkajs' `END_BATCH_PROCESS` instrumentation event. */
export function instrumentKafkaConsumer(consumer: KafkaConsumerLike, groupId: string): void {
  consumer.on(consumer.events.END_BATCH_PROCESS, (event) => {
    const { topic, partition, offsetLag } = event.payload;
    lag().set({ group: groupId, topic, partition: String(partition) }, Number(offsetLag));
  });
}
```

Create `libs/transport/src/kafka/instrumented-server-kafka.ts`:

```ts
import { type KafkaOptions, ServerKafka } from '@nestjs/microservices';
import { instrumentKafkaConsumer, type KafkaConsumerLike } from './kafka-metrics.js';

/**
 * Nest's Kafka server plus consumer-lag instrumentation. `connectKafkaConsumer()` connects it as a
 * custom strategy with the options `createKafkaServerOptions()` builds, so the transport id
 * (`Transport.KAFKA`), consumer group and handlers are unchanged.
 */
export class InstrumentedServerKafka extends ServerKafka {
  constructor(readonly kafkaOptions: Required<KafkaOptions>['options']) {
    super(kafkaOptions);
  }

  override async bindEvents(consumer: KafkaConsumerLike): Promise<void> {
    instrumentKafkaConsumer(consumer, this.groupId);
    await super.bindEvents(consumer);
  }
}
```

- [ ] **Step 4: Wire it.** `libs/transport/src/kafka/kafka.options.ts`: change the return type of
      `createKafkaServerOptions` from `): KafkaOptions {` to
      `): KafkaOptions & Required<Pick<KafkaOptions, 'options'>> {`.
      `libs/transport/src/hybrid/connect-microservices.ts`: replace `import type { CustomStrategy, KafkaOptions } from
'@nestjs/microservices';` with `import type { CustomStrategy } from '@nestjs/microservices';`, add
      `import { InstrumentedServerKafka } from '../kafka/instrumented-server-kafka.js';`, and replace the body of
      `connectKafkaConsumer` with:

```ts
const cfg = resolveConfig<KafkaConfig>(app, kafkaConfig);
const { options: kafkaOptions } = createKafkaServerOptions(cfg, options);
return app.connectMicroservice<CustomStrategy>(
  { strategy: new InstrumentedServerKafka(kafkaOptions) },
  { inheritAppConfig: true },
);
```

and in its doc comment replace

```text
 * exist, because auto-creation is off.
```

with

```text
 * exist, because auto-creation is off. It connects `InstrumentedServerKafka` (Nest's Kafka server plus the
 * `kafka_consumer_lag` gauge) as a custom strategy; `transportId` stays `Transport.KAFKA`.
```

`libs/transport/src/hybrid/connect-microservices.spec.ts` (keep the `Transport` import: `connectKafkaOn` still uses
`Transport.TCP`). Lane E Task 2 (merged into `feat/domains-tenancy` at `13030b0`) renamed the literal service and
group names in this spec to `alerts-service`, and `scripts/libs-vocabulary.spec.ts` now fails any `libs/**` spec line
that names a domain: the blocks below use the file's current literals; change only the assertion shape. Add
`import { InstrumentedServerKafka } from '../kafka/instrumented-server-kafka.js';` and a helper below the imports:

```ts
const kafkaOptionsOf = (options: unknown) =>
  (options as { strategy: InstrumentedServerKafka }).strategy.kafkaOptions;
```

Then, in "connects a Kafka server with the requested consumer group, inheriting app config", replace

```ts
expect(options).toMatchObject({
  transport: Transport.KAFKA,
  options: {
    postfixId: '',
    client: { clientId: 'alerts-service' },
    consumer: { groupId: 'gateway-push' },
  },
});
```

with

```ts
expect(options).toEqual({ strategy: expect.any(InstrumentedServerKafka) });
expect(kafkaOptionsOf(options)).toMatchObject({
  postfixId: '',
  client: { clientId: 'alerts-service' },
  consumer: { groupId: 'gateway-push' },
});
```

in "defaults the consumer group to kafkaConfig.groupId" replace

```ts
expect(connect.mock.calls[0]?.[0]).toMatchObject({
  options: { consumer: { groupId: 'alerts-service' } },
});
```

with

```ts
expect(kafkaOptionsOf(connect.mock.calls[0]?.[0])).toMatchObject({
  consumer: { groupId: 'alerts-service' },
});
```

in "falls back to the environment without logging …" replace
`    expect(options).toMatchObject({ transport: Transport.KAFKA });` with
`    expect(options).toEqual({ strategy: expect.any(InstrumentedServerKafka) });`, and in "uses the value a module
loaded with ConfigModule.forFeature" replace
`    expect(options).toMatchObject({ options: { client: { clientId: 'loaded-by-the-container' } } });` with
`    expect(kafkaOptionsOf(options)).toMatchObject({ client: { clientId: 'loaded-by-the-container' } });`.

- [ ] **Step 5: Outcomes.** `libs/transport/src/kafka/kafka-context.interceptor.ts`: add `import { tap } from
'rxjs';` (merge with the existing `rxjs` import) and `import { recordKafkaOutcome } from './kafka-metrics.js';`;
      replace `        return next.handle().subscribe(subscriber);` with:

```ts
return next
  .handle()
  .pipe(tap({ complete: () => recordKafkaOutcome(kafka.getTopic(), 'success') }))
  .subscribe(subscriber);
```

`libs/transport/src/kafka/kafka-retry.interceptor.ts`: add `import { recordKafkaRetry } from
'./kafka-metrics.js';` and insert `          recordKafkaRetry(kafka.getTopic());` right before
`          return timer(delayMs);`.
`libs/transport/src/kafka/kafka-dead-letter.filter.ts`: add `import { recordKafkaOutcome } from
'./kafka-metrics.js';`; replace

```ts
if (!(context instanceof KafkaContext) || exception instanceof KafkaRetriableException) {
  return throwError(() => exception);
}
```

with

```ts
if (!(context instanceof KafkaContext)) return throwError(() => exception);
if (exception instanceof KafkaRetriableException) {
  recordKafkaOutcome(context.getTopic(), 'redelivery');
  return throwError(() => exception);
}
```

in `deadLetter`, insert `      recordKafkaOutcome(context.getTopic(), 'dead_letter');` right after
`      const record = await sendToDeadLetter(context, exception);`, and
`      recordKafkaOutcome(context.getTopic(), 'redelivery');` right before `      throw exception;`.
`libs/transport/src/index.ts`: insert `export * from './kafka/instrumented-server-kafka.js';` and
`export * from './kafka/kafka-metrics.js';` among the `./kafka/` lines (alphabetical; not at the end).

- [ ] **Step 6: Run.** `npx vitest run --project transport` — Expected: PASS. Sandbox off: `npx vitest run
--project gateway:e2e --project notifications-service:e2e` — Expected: PASS (consumers are connected through
      the new strategy).

- [ ] **Step 7: Docs.** `docs/OBSERVABILITY.md` "### What is exported": rows for the three Kafka series with the
      label sets, outcome meanings and the lag staleness note from **Interfaces**. `libs/transport/README.md`: rows
      for `InstrumentedServerKafka`, `instrumentKafkaConsumer`, `recordKafkaOutcome`, `recordKafkaRetry`; note that
      `connectKafkaConsumer` connects the instrumented server.

- [ ] **Step 8: Wider checks.** `npx biome check --write libs/transport`; `npx prettier --write docs/OBSERVABILITY.md
libs/transport/README.md`; `bun run check` — Expected: exit 0.

- [ ] **Step 9: Commit.**

```bash
git add libs/transport docs/OBSERVABILITY.md
git commit -S -m "feat(transport): kafka consumer lag and handler outcome metrics" \
  -m "kafka_consumer_messages_total{topic,outcome}, kafka_consumer_retries_total{topic} and" \
  -m "kafka_consumer_lag{group,topic,partition} via InstrumentedServerKafka."
```

### Task 10: DB pool in-use and waiting gauges (G-8; FU-4)

**Files:**

- Create: `libs/database/src/drizzle/pool-usage.ts`
- Test: `libs/database/src/drizzle/pool-usage.spec.ts`, `libs/database/test/pool-usage.int-spec.ts`
- Modify: `libs/database/src/drizzle/drizzle.factory.ts:45-63`, `libs/database/src/index.ts`,
  `libs/database/src/database.module.spec.ts:30`, `docs/OBSERVABILITY.md`, `libs/database/README.md`

**Interfaces:**

- Consumes: Task 7 (`getOrCreateGauge`).
- Produces (B3-10 reuses these for the system pool):
  - `interface PoolUsageSnapshot { readonly pool: string; readonly max: number; readonly inUse: number; readonly waiting: number }`
  - `class PoolUsage { constructor(readonly pool: string, readonly max: number); snapshot(): PoolUsageSnapshot; track<T extends Sql>(client: T): T }`
  - `registerPoolUsage(usage: PoolUsage): void` (one entry per pool name; the latest registration wins)
  - `DB_POOL_CONNECTIONS_IN_USE = 'db_pool_connections_in_use'`, `DB_POOL_OPERATIONS_WAITING =
'db_pool_operations_waiting'`, `DB_POOL_CONNECTIONS_MAX = 'db_pool_connections_max'` — gauges labelled `{pool}`
    (`runtime` now; B3-10 adds `system` with `new PoolUsage('system', cfg.systemPoolMax)` + `registerPoolUsage` +
    `usage.track(systemClient)`).
  - Semantics (postgres.js 3.4.9 exposes no pool statistics): an operation is a top-level query from the moment it
    is awaited until it settles, or a `begin()` transaction for its whole callback (queries inside it are not counted
    again). `inUse = min(outstanding, max)`, `waiting = max(0, outstanding - max)`: an operation beyond `max` waits
    for (or is pipelined behind) another on the same connection. `reserve()`, `listen()` and the migration client
    are not counted.

**Wave:** after Task 9 (Lane M). B3-10 consumes it.

- [ ] **Step 1: Write the failing unit spec.** `libs/database/src/drizzle/pool-usage.spec.ts`:

```ts
import type { Sql } from 'postgres';
import { register } from 'prom-client';
import { PoolUsage, registerPoolUsage } from './pool-usage.js';

/** postgres.js queries are promises with chainable modifiers such as `.values()`. */
interface LazyQuery extends Promise<unknown[]> {
  values(): LazyQuery;
}

/** A postgres.js-shaped client whose queries settle when the test releases them. */
function fakeSql() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const query = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown[]>((ok, ko) => {
      resolve = () => ok([]);
      reject = ko;
    });
    pending.push({ resolve, reject });
    // A real promise (Biome's noThenProperty rejects an object literal with a `then` key).
    const lazy: LazyQuery = Object.assign(promise, { values: (): LazyQuery => lazy });
    return lazy;
  };
  // A tagged template runs a query; `sql(value)` returns a helper (no `then`), as in postgres.js.
  const sql = Object.assign(
    (strings: unknown) => (Array.isArray(strings) ? query() : { strings }),
    {
      unsafe: (..._args: unknown[]) => query(),
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    },
  );
  return { sql: sql as unknown as Sql, pending };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('PoolUsage', () => {
  it('counts an awaited query until it settles, and never a query that is only built', async () => {
    const usage = new PoolUsage('runtime', 2);
    const { sql, pending } = fakeSql();
    const tracked = usage.track(sql);
    void tracked.unsafe('select 1'); // built, never awaited (a fragment): not counted
    expect(tracked('ident' as never)).not.toHaveProperty('then'); // sql('x') helpers pass through
    expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 0, waiting: 0 });
    const running = Promise.all([
      tracked.unsafe('select 2').values(),
      tracked`select 3`,
      tracked.unsafe('select 4'),
    ]);
    await tick();
    expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 2, waiting: 1 });
    for (const query of pending) query.resolve();
    await running;
    expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('releases a failed query', async () => {
    const usage = new PoolUsage('runtime', 1);
    const { sql, pending } = fakeSql();
    const failing = usage.track(sql).unsafe('select 1/0');
    const settled = Promise.resolve(failing).catch(() => 'failed');
    await tick();
    expect(usage.snapshot().inUse).toBe(1);
    pending[0]?.reject(new Error('division by zero'));
    await expect(settled).resolves.toBe('failed');
    expect(usage.snapshot().inUse).toBe(0);
  });

  it('counts a transaction once, for its whole callback', async () => {
    const usage = new PoolUsage('runtime', 4);
    const { sql } = fakeSql();
    let inside: number | undefined;
    await usage.track(sql).begin(async () => {
      inside = usage.snapshot().inUse;
    });
    expect(inside).toBe(1);
    expect(usage.snapshot().inUse).toBe(0);
  });

  it('exposes the gauges per pool', async () => {
    const usage = new PoolUsage('unit-pool', 5);
    registerPoolUsage(usage);
    const max = await register.getSingleMetric('db_pool_connections_max')?.get();
    expect(max?.values).toContainEqual(
      expect.objectContaining({ labels: { pool: 'unit-pool' }, value: 5 }),
    );
    const inUse = await register.getSingleMetric('db_pool_connections_in_use')?.get();
    expect(inUse?.values).toContainEqual(
      expect.objectContaining({ labels: { pool: 'unit-pool' }, value: 0 }),
    );
    expect(register.getSingleMetric('db_pool_operations_waiting')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project database pool-usage` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** Create `libs/database/src/drizzle/pool-usage.ts`:

```ts
import { getOrCreateGauge } from '@platform/observability';
import type { Sql } from 'postgres';

export const DB_POOL_CONNECTIONS_IN_USE = 'db_pool_connections_in_use';
export const DB_POOL_OPERATIONS_WAITING = 'db_pool_operations_waiting';
export const DB_POOL_CONNECTIONS_MAX = 'db_pool_connections_max';

export interface PoolUsageSnapshot {
  readonly pool: string;
  readonly max: number;
  readonly inUse: number;
  readonly waiting: number;
}

type Settle = (value: unknown) => unknown;
type Then = (onFulfilled?: Settle, onRejected?: Settle) => PromiseLike<unknown>;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Connection demand of one postgres.js pool. postgres.js keeps its connection queues private, so
 * this counts operations instead: a top-level query from the moment it is awaited (postgres.js
 * queries are lazy: a built-but-never-awaited query or fragment runs nothing) until it settles, and a
 * `begin()` transaction for its whole callback. `inUse = min(outstanding, max)`; the rest waits for
 * (or is pipelined behind) another operation on the same connection. Not counted: `reserve()`,
 * `listen()`, the migration client.
 */
export class PoolUsage {
  private outstanding = 0;

  constructor(
    readonly pool: string,
    readonly max: number,
  ) {}

  snapshot(): PoolUsageSnapshot {
    return {
      pool: this.pool,
      max: this.max,
      inUse: Math.min(this.outstanding, this.max),
      waiting: Math.max(0, this.outstanding - this.max),
    };
  }

  /** A wrapper of `client` (the client itself is not modified) whose operations are counted. */
  track<T extends Sql>(client: T): T {
    const unsafe = client.unsafe.bind(client) as (...args: unknown[]) => PromiseLike<unknown>;
    const begin = client.begin.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const countedUnsafe = (...args: unknown[]) => this.countWhenAwaited(unsafe(...args));
    const countedBegin = async (...args: unknown[]): Promise<unknown> => {
      this.outstanding += 1;
      try {
        return await begin(...args);
      } finally {
        this.outstanding -= 1;
      }
    };
    return new Proxy(client, {
      // Tagged-template calls (sql`select …`) return a lazy query; `sql(value)` returns a helper
      // (identifier, values list), which has no `then` and passes through uncounted.
      apply: (target, thisArg, args: unknown[]) => {
        const result: unknown = Reflect.apply(target, thisArg, args);
        return isThenable(result) ? this.countWhenAwaited(result) : result;
      },
      get: (target, property, receiver) => {
        if (property === 'unsafe') return countedUnsafe;
        if (property === 'begin') return countedBegin;
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** Wraps the query's own `then` (postgres.js starts a query on its first `then`). */
  private countWhenAwaited<Q extends PromiseLike<unknown>>(query: Q): Q {
    const then = query.then.bind(query) as Then;
    let started = false;
    Object.defineProperty(query, 'then', {
      configurable: true,
      writable: true,
      value: (onFulfilled?: Settle, onRejected?: Settle) => {
        if (started) return then(onFulfilled, onRejected);
        started = true;
        this.outstanding += 1;
        return then(
          (value) => {
            this.outstanding -= 1;
            return onFulfilled ? onFulfilled(value) : value;
          },
          (reason) => {
            this.outstanding -= 1;
            if (onRejected) return onRejected(reason);
            throw reason;
          },
        );
      },
    });
    return query;
  }
}

const pools = new Map<string, PoolUsage>();
type GaugeSpec = readonly [
  name: string,
  help: string,
  read: (snapshot: PoolUsageSnapshot) => number,
];
const GAUGES: readonly GaugeSpec[] = [
  [DB_POOL_CONNECTIONS_IN_USE, 'Postgres pool connections in use, by pool', (s) => s.inUse],
  [
    DB_POOL_OPERATIONS_WAITING,
    'Postgres operations waiting for a connection (beyond the pool size), by pool',
    (s) => s.waiting,
  ],
  [DB_POOL_CONNECTIONS_MAX, 'Postgres pool size (max connections), by pool', (s) => s.max],
];

/** Publishes `usage` as `db_pool_*{pool}` (one entry per pool name; the latest registration wins). */
export function registerPoolUsage(usage: PoolUsage): void {
  pools.set(usage.pool, usage);
  for (const [name, help, read] of GAUGES) {
    getOrCreateGauge({
      name,
      help,
      labelNames: ['pool'],
      collect() {
        this.reset();
        for (const pool of pools.values()) this.set({ pool: pool.pool }, read(pool.snapshot()));
      },
    });
  }
}
```

`libs/database/src/drizzle/drizzle.factory.ts`: add `import { PoolUsage, registerPoolUsage } from
'./pool-usage.js';`; after the `const client = postgres(…);` statement insert:

```ts
// db_pool_*{pool="runtime"}: postgres.js has no pool statistics, so operations are counted.
const usage = new PoolUsage('runtime', cfg.poolMax);
registerPoolUsage(usage);
```

and replace `    client: preferPreparedStatements(client),` with
`    client: preferPreparedStatements(usage.track(client)),`. `libs/database/src/index.ts`: add
`export * from './drizzle/pool-usage.js';` next to the other `./drizzle/` exports.

`libs/database/src/database.module.spec.ts:30` mocks `@platform/observability` with `HealthContributor` only, so
`registerPoolUsage` would throw `No "getOrCreateGauge" export is defined on the mock` in ten tests. Replace

```ts
vi.mock('@platform/observability', () => ({ HealthContributor: class HealthContributor {} }));
```

with

```ts
// DatabaseModule registers the db_pool_* gauges (PoolUsage); their scrape-time collect never runs here.
vi.mock('@platform/observability', () => ({
  HealthContributor: class HealthContributor {},
  getOrCreateGauge: () => undefined,
}));
```

(`libs/database/src/health/database.health.spec.ts` keeps its mock: it never loads the factory.)

- [ ] **Step 4: Run the unit spec.** `npx vitest run --project database` — Expected: PASS (existing
      `drizzle-transactional.adapter.spec.ts` and `prepared-statements.spec.ts` included).

- [ ] **Step 5: Real-pool int spec.** Create `libs/database/test/pool-usage.int-spec.ts`. Lane S Task 1 (SH-1, merged
      before B2) moves every Postgres int spec onto `startTestPostgres()` from `@platform/testing/postgres` (Citus
      14.2) and replaces `libs/database`'s `@testcontainers/postgresql` devDependency with `@platform/testing`. If
      `fd -t f index.ts libs/testing/src/postgres` finds the file, write the spec as below; otherwise (S not merged
      yet) use the fallback header after it.

```ts
import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoolUsage } from '../src/drizzle/pool-usage.js';

describe.skipIf(process.env['INTEGRATION'] !== '1')('PoolUsage on a real postgres.js pool', () => {
  let pg: TestPostgres | undefined;
  let url: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    url = pg.url;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('reports max connections in use and the rest waiting', async () => {
    const client = postgres(url, { max: 2, onnotice: () => undefined });
    const usage = new PoolUsage('runtime', 2);
    const sql = usage.track(client);
    try {
      const all = Promise.all([1, 2, 3, 4].map(() => sql`select pg_sleep(0.4)`));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(usage.snapshot()).toEqual({ pool: 'runtime', max: 2, inUse: 2, waiting: 2 });
      await all;
      expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it('counts a transaction once and releases failed queries', async () => {
    const client = postgres(url, { max: 2, onnotice: () => undefined });
    const usage = new PoolUsage('runtime', 2);
    const sql = usage.track(client);
    try {
      let inside: number | undefined;
      await sql.begin(async (tx) => {
        await tx`select 1`;
        await tx`select 2`;
        inside = usage.snapshot().inUse;
      });
      expect(inside).toBe(1);
      await expect(sql`select 1/0`).rejects.toThrow();
      expect(usage.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
    } finally {
      await client.end({ timeout: 1 });
    }
  });
});
```

Fallback (lane S Task 1 not merged): replace everything above the first `it(` with the inline container that
`libs/database/test/database.int-spec.ts` uses at `9600510`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoolUsage } from '../src/drizzle/pool-usage.js';

const IMAGE = 'postgres:18.6-alpine3.24';

describe.skipIf(process.env['INTEGRATION'] !== '1')('PoolUsage on a real postgres.js pool', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let url: string;

  beforeAll(async () => {
    const shared = process.env['INTEGRATION_DATABASE_URL'];
    if (shared !== undefined) {
      url = shared;
      return;
    }
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('app')
      .withUsername('app')
      .withPassword('app')
      .start();
    url = container.getConnectionUri();
  });

  afterAll(async () => {
    await container?.stop();
  });
```

(lane S then migrates this spec with the others; record it in the merge notes).

Run (Docker, sandbox off): `INTEGRATION=1 npx vitest run --project database:int pool-usage` — Expected: PASS.

- [ ] **Step 6: Docs.** `docs/OBSERVABILITY.md` "### What is exported": rows for the three `db_pool_*` gauges with
      the semantics from **Interfaces** (operations, not connections; `waiting > 0` sustained = raise
      `DATABASE_POOL_MAX` or shorten transactions; behind PgBouncer (program spec §16, sharding design) they
      describe the app's client pool towards PgBouncer, whose `SHOW POOLS` `cl_waiting` / `sv_active` is the
      server-side view). In "## Known follow-ups" delete the "**No app-level gRPC, Kafka,
      cache or database metrics**" bullet and add one: "**Cache metrics** (hit/miss of `AppCacheService`) are not
      exported yet." `libs/database/README.md`: rows for `PoolUsage`, `registerPoolUsage` and the gauges.

- [ ] **Step 7: Wider checks.** `npx biome check --write libs/database`; `npx prettier --write docs/OBSERVABILITY.md
libs/database/README.md`; `bun run check` — Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add libs/database docs/OBSERVABILITY.md
git commit -S -m "feat(database): pool in-use and waiting gauges for the runtime pool" \
  -m "db_pool_connections_in_use, db_pool_operations_waiting and db_pool_connections_max {pool};" \
  -m "PoolUsage counts awaited queries and transactions (postgres.js exposes no pool stats)."
```

### Task 11: G-13 docs for metrics and packaging, README test count (G-13 subset)

**Files:**

- Modify: `docs/DOCKER.md`, `docs/PERFORMANCE.md:585-605`, `docs/SECURITY.md`, `docs/TESTING.md`, `README.md`
  (metrics mentions, test count `:63`), `apps/*/README.md` (lines that place `/metrics` on the HTTP port)

**Interfaces:**

- Consumes: Tasks 1-10 merged into `feat/domains-tenancy`;
  `docs/superpowers/plans/2026-11-09-g-metrics-packaging/artifacts/image-sizes.txt` (Task 5).
- Produces: documentation only. The "no outbox" notes (`docs/ARCHITECTURE.md:566`, `README.md:456`,
  `docs/TESTING.md:283-287`, the PERFORMANCE "Transactional outbox" bullet) stay: they belong to G-3.

**Wave:** after both lanes are merged (Tasks 5 and 10).

- [ ] **Step 1: Find every stale statement.**
      `rg -n "/metrics|METRICS_|metrics listener|same port as the API|3000.*metrics|metrics.*3000" README.md docs apps/*/README.md libs/*/README.md -g '!docs/superpowers/**'`
      and `rg -n "assemble-image|whole .dist|294 MB|image size|TRACE_FILES|@domain/[a-z]+/api" docs README.md -g '!docs/superpowers/**'`.

- [ ] **Step 2: Edit.**
  - `docs/DOCKER.md`: the metrics port (9464 in-network, not published; Prometheus scrapes `:9464`); the image
    section: `assemble-image.mjs` traces `dist/main.js`, `instrument.js`, `migrate.js`, keeps non-JS assets of traced
    packages, prunes untraced workspace packages and node_modules packages outside the manifest closure, runs a load
    check of `dist/app.module.js`; `--build-arg TRACE_FILES=false` copies closure packages whole; a table of the
    before/after sizes from `image-sizes.txt`.
  - `docs/PERFORMANCE.md` "## Known follow-ups": delete the "**Slimmer gateway image.**", "**Separate metrics
    listener**" and "**No app-level gRPC / Kafka / pool metrics**" bullets; keep the outbox and real-database bullets;
    add the measured image sizes next to the existing image-size figures (replace the "294 MB" claim with the
    measured gateway size).
  - `docs/SECURITY.md`: wherever `/metrics` is said to share the API port or to need ingress filtering, state that it
    is served on `METRICS_PORT` (never published in compose; keep it cluster-internal; `METRICS_BEARER_TOKEN` as
    defence in depth).
  - `docs/TESTING.md`: in the toolbox / scripts section, add `scripts/check-api-subpaths.spec.ts` (fixture trees for
    the `./api` graph rule) and `scripts/docker/assemble-image.spec.ts` (fixture install trees for file tracing), and
    `libs/database/test/pool-usage.int-spec.ts` to the int-spec table.
  - `README.md` and `apps/*/README.md`: every "HTTP serves `/health` and `/metrics`" → `/health` on `PORT`,
    `/metrics` on `METRICS_PORT` (9464; host dev 9464-9467).

- [ ] **Step 3: Test count.** Sandbox off: `bun run test 2>&1 | tail -5` — note `Test Files N passed` and
      `Tests M passed`; in `README.md:63` replace the counts in `254 test files / 1891 tests at the time of writing`
      with N and M.

- [ ] **Step 4: Checks.** `npx prettier --write docs/DOCKER.md docs/PERFORMANCE.md docs/SECURITY.md docs/TESTING.md
README.md apps/*/README.md`; `bun run check` — Expected: exit 0. `rg -n "same port as the API" docs README.md
-g '!docs/superpowers/**'` — Expected: no hits.

- [ ] **Step 5: Commit.**

```bash
git add docs/DOCKER.md docs/PERFORMANCE.md docs/SECURITY.md docs/TESTING.md README.md apps/*/README.md
git commit -S -m "docs(docs): document the metrics port, app-level metrics, ./api entries and traced images" \
  -m "Updates the README test count. The outbox notes stay for G-3."
```

## Spec coverage

| Inventory item                                                                                                                 | Spec                                                       | Task(s)                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| G-11 Domain `./api` subpaths + barrel clean-up (FU-2)                                                                          | §12 "Gateway image" (each domain gets `./api`)             | 1, 2, 3                                                                                  |
| B1FU-1 identity internals out of the barrel (`TokenIssuer`, `PasswordHasher`, `DEV_JWT_REFRESH_SECRET`, `MAX_PASSWORD_LENGTH`) | §3.2, §12                                                  | 2                                                                                        |
| B1FU-2 test doubles out of production barrels (`FakeKafkaProducer`, `makeAuthUser`, `InMemoryStorageService`)                  | §3.2 ("./testing subpath"), §13                            | 4                                                                                        |
| G-12 `assemble-image` file tracing (FU-2)                                                                                      | §12 "copies only the files reachable … using file tracing" | 5                                                                                        |
| B1FU-7 specs for `assemble-image.mjs`                                                                                          | —                                                          | 5 (and 1 for the shared tracer)                                                          |
| G-4 metrics on `METRICS_PORT` 9464 (FU-3)                                                                                      | §12 "Metrics listener"                                     | 6                                                                                        |
| G-5 gRPC client/server metrics (FU-4)                                                                                          | §12 "App-level metrics"                                    | 7                                                                                        |
| G-6 circuit-breaker state (FU-4)                                                                                               | §12                                                        | 8                                                                                        |
| G-7 Kafka lag and handler outcomes (FU-4)                                                                                      | §12                                                        | 9                                                                                        |
| G-8 DB pool in-use/waiting (FU-4)                                                                                              | §12 (system pool once B3-10 lands)                         | 10 (runtime pool; API for B3-10)                                                         |
| AUDIT-F28 README snippets                                                                                                      | —                                                          | 3 (`README.md:228-229` now true; gateway `./api`), 4 (`libs/auth/README.md`)             |
| G-13 docs (metrics port, `./api`, images)                                                                                      | —                                                          | 2, 3, 6-10 (per-feature docs), 11 (DOCKER, PERFORMANCE, SECURITY, TESTING, README count) |
| G-13 "remove the no-outbox notes"                                                                                              | §12 outbox                                                 | not here: G-3's plan                                                                     |

## Self-review

- Every in-scope inventory item maps to a task (table above). G-1..G-3, G-9, G-10 and the outbox doc notes are left
  to later plans.
- Names used across tasks: `traceImports` / `collectSpecifiers` / `packageNameOf` (Task 1 → Task 5);
  `check-api-subpaths.mjs` flags `--root`, `--require-all` (Tasks 1, 3); `MetricsListener.start()` / `.scrape()`,
  `listenMetrics`, `startClusterPrimaryMetrics`, `startMetricsServer`, `scrapeMetrics`, `METRICS_NOT_FOUND` (Task 6,
  used in e2e edits); `getOrCreateCounter/Gauge/Histogram` (Task 7 → 8, 9, 10); `recordGrpcCall`,
  `parseGrpcOperation`, `grpcClientCode`, `trackCircuitBreakerStates` (Tasks 7, 8); `InstrumentedServerKafka.kafkaOptions`
  (Task 9 code and spec); `PoolUsage`, `registerPoolUsage` (Task 10, B3-10).
- Commit headers checked against `commitlint.config.ts` scopes and ≤ 100 chars; none carries an attribution line.
- Known approximations, stated in the docs they touch: Kafka lag is per batch end; pool usage counts operations, not
  connections; `grpc_service` is the fully qualified proto service name on both sides (Task 7 normalizes billing's
  adapter from `billing.BillingService` to `billing.v1.BillingService`).

## Plan review (2026-11-09)

Adversarial review (review:g), run 2026-11-10 against `feat/domains-tenancy` at `13030b0` (`9600510` + the
amended program spec `d0b9e2f` + lane E's first merge), with `lane/c-w1` at `c566f08` (C1-C3 executed, not merged)
and `lane/e-ci` at `61f9744` (`271eb91` and `61f9744` not merged yet). It replaces the cut-off earlier passes; their
in-place edits (the `grpc_service` normalization, neutral spec vocabulary, the third pass's fixes listed under
"Changes made") were re-checked and kept. Provenance: **[re-run]** = executed or read in this pass; **[3rd]** =
third-pass execution result whose inputs and anchors this pass re-checked against `13030b0`.

### Verified

- [re-run] Task 1: the two scripts, transcribed from the plan, print `API subpaths OK (0/4 domains …)` on the
  repository and list the four missing entries with `--require-all`. On a `lane/c-w1` tree with Tasks 2-3 applied
  (the four `src/api/index.ts` files, `./api` manifests, `forLocal()` without Core, gateway `…/api` imports) they
  print `API subpaths OK (4/4 domains …)`: lane C's new rate-limit modules reach only `@platform/{config,redis}`
  and stay legal in `./api`. `node scripts/check-boundaries.mjs` prints `Layer boundaries OK (26 packages …)`.
- [re-run] All 11 commit messages pass `commitlint` (headers 61-89 characters, valid scopes, no attribution lines).
- [re-run] Anchors the steps quote: identity root barrel, `identity-api.module.ts:7,38,51`,
  `identity-core.module.ts:53`, `identity-api.module.spec.ts:23,88`, `testing/fake-identity-ports.ts:20`;
  `apps/monolith/src/app.module.ts:1-9,51,89-94` (C3 rewrites `:47-50` on `lane/c-w1` and keeps `:51` verbatim);
  gateway `app.module.ts:1-4`, `payment-user.resolver.ts:1-2`, `test/support/gateway-e2e-app.ts:2-3`; the five
  e2e `/metrics` tests (`monolith:92`, `gateway:96`, `identity-service:132`, `notifications-service:163`,
  `billing-service:180`); the apps' `PORT=` lines and env-example spec lines; `.env.example:53`;
  `docker-compose.yml:35`; `libs/auth/src/index.ts:39`, `libs/storage/src/index.ts:5,14`,
  `libs/transport/src/index.ts:22,44`; `grpc-call.ts:11,29-36`, `grpc-controller.decorator.ts:14,29`,
  `grpc-circuit-breakers.ts:81,106,116`; the Kafka interceptor/filter lines; the `connect-microservices.spec.ts`
  literals (`alerts-service`, `gateway-push`, `loaded-by-the-container`); `database.module.spec.ts:30`;
  `drizzle.factory.ts:45,58`; `tsconfig.base.json:20` (`useDefineForClassFields: false`, which Task 8's field
  initialiser relies on); the `assemble-image.mjs` symbols Task 5 reuses (`closure`, `kept`, `appPackage`,
  `WORKSPACE_SCOPES`, `listFiles`, `readJson`, `fail`; `realpathSync` and `pathToFileURL` already imported) and the
  Dockerfile `assemble` stage text; `integration.smoke.spec.ts` `/metrics` lines on both `13030b0` and
  `lane/c-w1` (text-anchored, so C's shift from `:211`/`:385` to `:222`/`:401` does not matter).
- [re-run] Task 4 Step 5 lists every importer of the three doubles from a root barrel (17 domain/app files; the
  same on `lane/c-w1` and `lane/e-ci`); the libs' own specs already import them relatively.
- [re-run] Third-party and internal APIs at the installed versions: `@willsoto/nestjs-prometheus` 6.1.1
  `makeCounterProvider` injects `PROMETHEUS_OPTIONS` as optional, so billing's counter
  (`billing-core.module.ts:40`) works without `PrometheusModule`; prom-client 15.1.3 `AggregatorRegistry`
  installs its IPC listeners in the constructor; `zPort` accepts `0..65535`; `timingSafeEqualStr`,
  `getContextType`, `isGrpcMetadata`, `grpcStatusName`, `isGrpcServiceError`, `exceptionToGrpcError`,
  `grpcErrorToDomainException`, `HTTP_DURATION_BUCKETS` exist with the used signatures; `@platform/transport` and
  `@platform/database` already depend on `@platform/observability`; nothing outside `libs/observability` and
  `run-clustered.ts:6,185` uses `MetricsController`, `requestClusterMetrics` or `enableClusterMetricsAggregation`;
  no spec mocks `PrometheusModule`; `runClustered()` calls the primary hook only in the multi-worker branch, so a
  one-worker app never binds `METRICS_PORT` twice.
- [re-run] `PoolUsage`: real postgres.js queries are `Query extends Promise` instances, so `await`, `.catch()`
  and `Promise.all` all go through the own `then` that `PoolUsage` installs. The unit fake is a native `Promise`,
  which `Promise.all` and `.catch()` reach through a `then` lookup but a bare `await` would not (it bypasses an own
  `then` on a native promise): keep the unit spec's `Promise.all` / `Promise.resolve(…).catch` shape.
- [re-run] `grpc_service` normalization (controller ruling): identity's adapters already write
  `identity.v1.<Service>` (`auth-grpc.adapter.ts:17`, `users-grpc.adapter.ts:16`), notifications uses its
  package constant (`notifications-grpc.adapter.ts:73`); billing's `billing.BillingService`
  (`billing-grpc.adapter.ts:103`) is the only outlier, `BILLING_GRPC_PACKAGE.package` is `'billing.v1'` (matches
  `billing.proto` `package billing.v1;`), both constants are already imported (`:1-3`) and nothing asserts the old
  string: Task 7's one-line change is the small change the ruling asked for.
- [re-run] Libs vocabulary (E Task 2, merged): every libs spec and `testing/` file the plan creates or edits uses
  the neutral names (`orders.v1.OrdersService`, `orders-gauge`, `orders.created.v1`, `orders-push`, `test.*`,
  `unit-pool`) or the file's existing `alerts-service` literals.
- [re-run] Lane E's unmerged tail: the rewritten `check-env-example.mjs` (`61f9744`) accepts `METRICS_PORT`
  (documented as `# METRICS_PORT=9464` above the compose-only section; compose sets it as a literal, no
  interpolation); `vitest.setup.ts` (`271eb91`) silences Nest logging and no G spec asserts on log output.
- [3rd] Executed in scratch trees with the repo's Vitest, SWC, `tsc`, Biome, ESLint: Task 1 (9/9) and Task 5
  (6/6) specs fail before and pass after; the four `api-surface.spec.ts` files (13 tests) and the modules specs;
  the Lane M unit projects (598 tests; loopback files with the sandbox off); the tracer on a real swc build of all
  26 packages (gateway: 332 files, no core, handler, persistence, `drizzle-orm`, `postgres`, `stripe`, argon2 or
  `cassandra-driver`).
- Coverage: G-4..G-8, G-11 (FU-2, B1FU-1, B1FU-2), G-12 (B1FU-7), AUDIT-F28 and the G-13 subset map to Tasks 1-11
  with the spec §12 values (`METRICS_PORT` 9464, `./api` per domain, file tracing); §3 is unchanged by G (the
  `./testing` subpaths extend §3.2's rule to the libs' doubles); §16 changes nothing here except that pool gauges
  behind PgBouncer are client-side (Task 10 Step 6).

### Changes made

This pass:

1. Task 4: `docs/TESTING.md:91-93` names `@platform/transport`, `@platform/storage` and `@platform/auth` as the
   import path of the three doubles, and `docs/` was outside the commit's `git add`, so the edit Step 6's `rg`
   asked for would have been left unstaged. Added exact edits for `docs/TESTING.md:91-93`,
   `libs/transport/README.md:41` and `libs/storage/README.md:18`, and `docs/TESTING.md` to Files, Prettier and
   `git add`.
2. Task 3 Step 12: three comments still said an Api module imports its core (`billing-core.module.ts:18-20`,
   `domains/notifications/README.md:73`, `domains/billing/README.md:72`); added the rewrites.
3. Task 6: `startClusterPrimaryMetrics` now rejects `METRICS_PORT` equal to `PORT`, like `MetricsListener`;
   otherwise the cluster primary holds the API port and every worker crash-loops on `EADDRINUSE`. Spec test added
   (it fails before Step 7 like the rest of the file).
4. Task 7: `grpc-call.ts`'s `operation` doc comment gave `orders.OrdersService/GetOrder`, contradicting the
   normalization; it now states `<proto package>.<Service>/<Method>` so B2's new adapters label `grpc_service`
   correctly.
5. Shared files: the barrel row cited a non-existent C1 commit (`93098b2`) and assumed C would write into
   `./api`; C1-C3 are executed against the old roots, so C-after-G is a whole-root-rewrite versus append conflict,
   with the resolution now stated. New rows: `billing-core.module.ts` (L-7), the billing and notifications READMEs
   (C, L), the storage and transport READMEs (E Task 7), `docs/TESTING.md` (Task 4 + 11; E's hunks);
   `docs/CONFIGURATION.md` names E's unmerged tail.
6. Executive summary and this section consolidated into one review.

Third pass (kept, re-checked):

- Task 6: `namespaces.spec.ts` gains `metricsPort: 9464`; `create-http-app.spec.ts` edits (`MetricsListener`
  import, `GET /v1/ping/large`, metrics and bearer-token tests through `listener.scrape()`); the
  identity-service e2e metrics test is replaced like the other two services'.
- Task 7: `grpc-enhancers.spec.ts` expects `GrpcMetricsInterceptor`; `metric-registry.ts` has no unnecessary type
  assertion; the gRPC spec's `getHandler` stub has no empty block.
- Task 10: `database.module.spec.ts:30` mock gains `getOrCreateGauge`; the `pool-usage.spec.ts` fake is a real
  promise (Biome `noThenProperty`).
- Task 9: the `connect-microservices.spec.ts` blocks keep the `alerts-service` literals.
- Task 2 Step 9: the monolith comment `:51` rewrite.
- Target export map: no entry changed; one clarifying paragraph on lane C's edge config namespaces.

### Unresolved

- Not executable without Docker: Task 5 Step 6 (image sizes, traced-image topology boot, the in-build load check
  against the pruned `node_modules`) and Task 10 Step 5 (real-pool int spec). Neither blocks Tasks 1-4.
- Merge order with lane C (a rule, not a defect): if `lane/c-w1` merges after G Tasks 2-3, the resolver keeps G's
  roots, moves `identityRateLimitConfig` / `notificationsRateLimitConfig` (and their types) into the domain's
  `src/api/index.ts` and appends the value names to `API_VALUES` (Shared files row).
- Known tracer approximation (stated in `trace-imports.mjs`): regex comment stripping treats `/*` inside a string
  literal as a comment start, so a dynamic `import('…')` below such a string in the same file can be missed; the
  load check of `app.module.js` is the backstop.
