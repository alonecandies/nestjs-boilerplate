# Code and architecture audit fixes: plan

## Goal

Close all 28 findings of the code and architecture audit of `master` at `a9ebb65`: 24 confirmed and
4 already documented but still open. The audit, with file and line evidence, consequences, fix
sketches and skeptic notes, is `docs/superpowers/plans/program-work/audit-2026-11-23-code-architecture.md`.
Read the named finding before starting a task. That path is relative to the main checkout
(git-excluded, so it is not in a clone); it does not exist in a lane worktree, so each task below
carries what a lane needs.

The work lands in three batches, each merged and pushed on its own after its gate and review:

- **Batch 1, ops risks:** OPS-2, ARCH-1, OPS-3, OPS-1, OPS-4, OPS-5, ARCH-8 and five docs-drift
  items. Two go to the task that already edits their file (config-ref-pre-ledger-wiring to Task 6,
  obs-app-metrics-sentence-stale to Task 7); the three whose files no other batch-1 task touches
  (api-subpath-followup-stale, devdocs-kafka-section-pre-outbox, spec-roadmap-status-stale) form
  Task 10.
- **Batch 2, security:** SEC-1, grpc-principal-unsigned, ws-revocation-poll-only, ARCH-2, ARCH-4.
- **Batch 3, architecture, CI, tests:** ARCH-5, notif-push-best-effort, TEST-1,
  cache-metrics-missing, ARCH-3, ARCH-7, ARCH-6, CI-2, test-gap-statements-stale, DOC-1, CI-1.

No item moved between batches. test-gap-statements-stale sits in the CI-2 task (both edit
`docs/TESTING.md`), and OPS-3's dead-letter alert (batch 1) lands before the notification push
change (batch 3) that relies on it.

User decision for ARCH-4, binding: "names open, PII gated". Every member sees co-members' display
names; emails and roles are returned only to callers holding `users:read`, in both topologies and
on every transport.

### Verified before designing

Each point was checked at `a9ebb65` on 2026-11-23. "Probe" means run in a throwaway container or
script, removed afterwards; "read" means read in the code; UNTESTED means not run.

1. **OPS-1, re-post after an immudb restore (read; UNTESTED at runtime).**
   - R4 does not double-post. `ImmudbLedgerAdapter.post` looks the entry up by
     `ledgerEntryId(sourceKey)` inside the immudb transaction (`immudb-ledger.adapter.ts`,
     `postOnce`); a restored store lacks the entry, so the re-enqueued request inserts it once and
     returns `posted`.
   - The Postgres ref is not refreshed. `recordEntryRef` and `recordEntryRefs` are
     `INSERT … ON CONFLICT DO NOTHING` (`drizzle-ledger-receipts.repository.ts:39-44`), so the row
     keeps the lost history's `immudb_tx_id` and `posted_at`.
   - A re-anchor alone does not suffice. R5's `needsVerification` skips a ref whose tx id is above
     the new state's ("verified by the next run"), and R5 lists only refs posted since
     `min(from, cutoff)`. A lost-window ref with a stale tx id is therefore skipped now and falls
     out of the 72 h listing window before the new history passes its tx id.
   - The existing door cannot re-anchor: `assertTrustedStateAdvance` refuses a lower tx id
     (`ledger.system-repository.ts:200-213`) and the SQL is a compare-and-set on tx id and hash.
   - The signature is checked only when a key is pinned (`grpc-immudb.client.ts:133-136`); with no
     key, a first-use state is taken on trust. A re-anchor must therefore refuse without a pinned
     key.
   - R4 sees Stripe transactions only in `[from, to)` (default lookback 72 h), so the lost window
     must be an explicit input.
2. **grpc-principal-unsigned (read; peer certificate probed).**
   - What unsigned metadata unlocks. Any asserted `(user, tenant)` passes `requireActingIn` and
     `requireTenantActor`, which compare only the asserted ids (`tenant-actor.ts:10-27`), so the
     tenant-scoped system reads (ListUsers, GetUser) answer. Billing computes `billing:read-all`
     from the asserted roles (`list-payments.handler.ts:35-41`). Notifications needs the exact
     `(tenant, user)` pair. `x-staff: true` additionally makes `actorTenantRoles` return the
     asserted roles without a membership lookup (`tenant-actor.ts:43-51`): invite, change roles,
     remove members and rename the tenant in any tenant, with no membership there. Staff is refused
     for leave-tenant, accept-invitation and tenant bootstrap.
   - `@grpc/grpc-js` 1.14.6 exposes the peer certificate. Probe: an mTLS server handler read
     `call.getAuthContext().sslPeerCertificate.subjectaltname` = `DNS:gateway, …` and
     `transportSecurityType` = `ssl`. Reaching the call object from a Nest interceptor is UNTESTED.
   - No Kafka consumer makes a gRPC call (read: the consumers are billing's ledger-posting and
     notifications' identity-events, billing-events and notification-push; gRPC clients are
     registered only by the four `*-api.module.ts` files and by ai-service's tool sources).
   - Decision (Tasks 12 and 13): a short-lived principal assertion signed with a private key only
     the edge holds (ES256), verified by the services with the public key, forwarded unchanged on
     service-to-service calls. Not chosen: forwarding the access token (every service would need
     the HS256 secret and could then mint edge tokens; a token can expire mid-chain; consumers have
     none) and peer-SAN authorization (no peer certificate in the documented
     `GRPC_ALLOW_INSECURE` behind a mesh mode; it cannot stop an allowed peer such as ai-service
     from asserting any user).
3. **CI-1 (probes).**
   - `bun audit` exists and works on Bun 1.4.3 (the `oven/bun:1.4.3-slim` image over a copy of the
     manifests and `bun.lock`) and on the local 1.4.5: 68 advisories (24 high, 35 moderate, 9 low,
     0 critical); with `--production` 56, of them 22 high. Exit codes: `--audit-level=critical`
     exits 0 on both versions; `--audit-level=high` exits 1 on 1.4.5 (on 1.4.3 only the counts
     were captured, the exit code is UNTESTED). `bun audit fix --dry-run` would fix 34 inside the
     declared ranges and leave 34. A gate at `high` does not start green: Task 26 fixes first.
   - Image scanner: `aquasecurity/trivy-action` tag `v0.36.0` = commit
     `ed142fd0673e97e23eac54620cfb913e5ce36c25` (`git ls-remote`); its `action.yaml` has the inputs
     `image-ref`, `vuln-type`, `severity`, `ignore-unfixed`, `exit-code`. Trivy 0.76.2
     (`aquasec/trivy`) on `gcr.io/distroless/nodejs24-debian13:nonroot` with
     `--pkg-types os --severity HIGH,CRITICAL --ignore-unfixed` reports 0, so an OS-package gate
     starts green on the base. The six app images were not built: UNTESTED.
   - The floating base tag resolved to
     `sha256:39b0407357c9fadf1a9708d22088f02de21f0e1e8a688474eea2d8701e7d5693` and runs Node
     v24.22.3, while the toolchain pins 24.21.0. The digest was read on an arm64 host; that it is
     the multi-arch index digest is UNTESTED, so Task 27 resolves it again with
     `docker buildx imagetools inspect`.
   - Coverage: `test:cov` runs `vitest run --coverage` (`@vitest/coverage-v8` 5.0.3, no
     thresholds). The only summary on disk is from 2026-10-05 (95.4 % lines of 4,501), so the
     baseline at HEAD is UNTESTED and Task 27 measures it first.
   - Update bot: Renovate's bun manager reads `bun.lock` and workspaces, but its extraction shows
     no handling of the root `catalog` this repo pins every version in; Dependabot's catalog
     support was not confirmed either. Both UNTESTED for npm. Task 27 uses Dependabot for
     `github-actions` and `docker` only, and the advisory gate for npm.
   - Current action tags and commits (`git ls-remote`): `actions/checkout` v7.0.1 `3d3c42e`,
     `actions/setup-node` v7.1.0 `949feb2`, `oven-sh/setup-bun` v2.2.0 `0c5077e`, `actions/cache`
     v6.1.0 `55cc834`, `docker/setup-buildx-action` v4.4.1 `f87e599`, `docker/build-push-action`
     v7.4.0 `c3c9e26`, `actions/upload-artifact` v7.0.2 `cf430e0`, `actions/download-artifact`
     v8.0.2 `9000827`. Task 27 re-resolves the full SHAs.
4. **ARCH-5 (read).** No new column is needed. The outbox row has no headers column, but its
   `envelope` is jsonb; envelopes are built by `KafkaProducer.createRecord` on both write paths
   (`OutboxWriter.enqueue`, and `record` for R4's system insert); the envelope schema strips unknown
   keys, and `publishStored` sends the stored object unchanged. The kafkajs instrumentation injects
   the active context into the record headers on send and extracts it on consume
   (`@opentelemetry/instrumentation-kafkajs`, `instrumentation.js:482`, `:178`), so the relay only
   has to send under the stored context. No migration on a distributed table.
5. **Restore procedures.**
   - Citus 14.2.0 on Postgres 18.4 (probe, coordinator plus one worker):
     `select citus_create_restore_point('…')` returns an LSN. A full PITR (base backup, WAL
     archive, recovery to the named point on every node) is UNTESTED.
   - Cassandra 5.0.9 (probe of the image CLI): `nodetool snapshot` (`-t <tag>`, `--ttl`,
     keyspaces), `nodetool import`, `nodetool refresh` and `sstableloader` exist. A snapshot and
     restore round trip is UNTESTED.
   - immudb 1.11.2 (probe of the image): `immuadmin backup` and `restore` (pause the server, copy
     the data directory), `immuadmin hot-backup <db> -o <file> [--start-tx]` and
     `hot-restore <db> -i <file> [--append] [--verify-only]`, and the server flags
     `--replication-sync-enabled`, `--replication-sync-acks`, `--signingKey`. The image has no
     shell. Every round trip is UNTESTED.
6. **OPS-2, lock waits on Citus (probe, coordinator plus one worker).**
   - A session `SET lock_timeout = '3s'` on the coordinator stops an `ALTER TABLE` blocked by a
     transaction opened through the coordinator (55P03 after 3 s).
   - It does not reach the worker connections: with a blocker held on a worker shard only, the same
     `ALTER` waited the blocker's whole 12 s and succeeded.
   - `SET LOCAL` with `citus.propagate_set_commands = 'local'` failed with "operation is not
     allowed on this node".
   - A role default does reach them. `ALTER ROLE … SET lock_timeout`, also run by a non-superuser
     on itself, is propagated to the worker; a new session's `ALTER` then fails with 55P03 "while
     executing command on <worker>" after 3 to 4 s. The session that ran the `ALTER ROLE` keeps
     its cached worker connection and still waits.
   - A lock timeout breaks a concurrent index build (probe, plain table on Postgres 18.4): with
     `lock_timeout = '3s'` and an unrelated write transaction open for 12 s,
     `CREATE INDEX CONCURRENTLY` is cancelled after 3 to 4 s and leaves an invalid index; with
     `lock_timeout = 0` it waits and the index is valid. Online steps therefore need their own
     timeout. Switching the role default between the two phases on a multi-node cluster is
     UNTESTED.

## Global Constraints

- One branch per batch from `master`: `fix/audit-b1`, `fix/audit-b2`, `fix/audit-b3`; a batch
  starts when the one before it is merged and pushed. Lanes are worktrees under the session
  scratchpad, merged into the batch branch with `--no-ff -S`.
- One GPG-signed commit per task, with the message the task gives (header at most 100 characters,
  body lines at most 100). A reviewed task may add one fix commit. Signed commits need the sandbox
  off.
- Behaviour changes and bug fixes are test-first: the acceptance test fails at the base for the
  stated reason, then passes. Refactors and docs get the guard or characterisation test named.
- Scoped checks per task, on the changed files and touched packages: `biome ci`,
  `eslint --max-warnings=0`, `prettier --check`, `tsc -p` per touched package,
  `node scripts/check-boundaries.mjs`, and `node scripts/check-api-subpaths.mjs --require-all` when
  exports change. The whole-repo `bun run check` runs once per lane merge and at the batch gate.
- Vitest runs with `--maxWorkers=2`. An `:int` project runs only where a task names it, with
  `INTEGRATION=1 TEST_POSTGRES_STARTUP_TIMEOUT_MS=360000 --maxWorkers=1`, and `REDIS_URL` and
  `INTEGRATION_REDIS_URL` pointing at a throwaway Redis the main loop runs (never `localhost:6379`).
  Other lanes share the emulated Citus, so a container start or hook timeout is load: re-run that
  project alone before treating it as a failure. e2e and gRPC round-trip specs need the sandbox off.
- No test calls the real OpenRouter or Stripe API.
- `bun install` and any lockfile change run in the main loop only, one at a time.
- Docker: only containers the task starts, removed afterwards; never the developer's Postgres,
  Redis or MySQL containers or the default `boilerplate` compose project.
- Docs and doc comments change in the same commit as the behaviour they describe. The README test
  count is refreshed by the main loop at each batch gate, not by a task.
- Mixed versions: every wire or auth change must work while old and new replicas run side by side.
  Each such task names its mixed-version acceptance test.
- Batch gate: `bun run check`, the full `vitest run`, `bun run build`, the `:int` projects the
  batch's tasks name, and for batch 2 also `node scripts/docker/check-topology.ts up microservices`.
  Then the reviews below, then merge and push.

## Review Focus

Each batch ends with one final review (`code-review high`). Six reviews of their own, for the
high-risk tasks (marked **review**):

- **Task 2 (OPS-2, covers Tasks 1 and 2, migrations):** the lock timeout is in force on the
  coordinator session and on worker connections before any DDL; a retry never re-applies a
  committed file; an online step that fails leaves nothing half-recorded; boot-time migration
  behaves as the release job.
- **Task 3 (ARCH-1, money path):** the Stripe-backed deadline is the only one that changed; a
  timed-out checkout cannot be retried into a second charge by the gateway itself; the Stripe
  breaker cannot open the `billing` breaker and the reverse.
- **Task 5 (OPS-1, ledger trusted state):** no path re-anchors without a pinned key and a valid
  signature; the audit row and the state change commit together or not at all; nothing but the CLI
  reaches the new system method; a state that still extends the trusted one is refused; lost-window
  refs are verified whatever tx id they carry.
- **Task 11 (SEC-1, signing):** a retired secret stops verifying as soon as it leaves the list; an
  unknown key id never falls back to trying every key; production guards cover every listed
  secret; no secret or key id reaches a log.
- **Task 13 (grpc-principal-unsigned, covers Tasks 12 and 13, auth):** under `enforce` no principal
  comes from unsigned metadata; the signed claims, not the plain headers, build the principal; an
  expired, replayed-after-expiry or other-key assertion fails closed; anonymous calls still pass;
  the private key is read only by the edge.
- **Task 16 (ARCH-4, authorization):** no transport and neither topology returns an email or roles
  to a caller without `users:read`; the permission comes from the membership row, not the forwarded
  roles; the testing fakes follow the same rule.

The batch-3 final review looks hard at Task 23 (it rewires the Stripe webhook handler's
dependencies) and Task 18 (it changes delivery semantics on purpose).

## Shared files

Tasks that touch the same file sit in the same lane, in order:

- `libs/database/src/migrator/run-migrations.ts`, `libs/database/README.md`: Tasks 1 → 2 (lane db).
- `scripts/docker/assemble-image.mjs`, the apps' `src/cli/` folders, `domains/billing/README.md`:
  Tasks 3 → 4 → 5 (lane bill).
- `libs/config/src/namespaces/app.config.ts`, the `docs/SECURITY.md` production checklist,
  `scripts/docs-audit.spec.ts` (new): Tasks 6 → 7 → 8 → 9 → 10 (lane ops).
- `libs/transport/src/grpc/*`, `docker-compose.yml`: Tasks 12 → 13 (lane mesh).
- `libs/auth/src/ws/*`, the WebSocket entry points: Tasks 14 → 15 (lane ws).
- `libs/transport/src/kafka/*`, `libs/outbox/src/*`, the notification handlers and the realtime
  e2e suites: Tasks 17 → 18 → 19 (lane events).
- `docker/prometheus/rules/*`, `scripts/prometheus-rules.spec.ts`,
  `libs/redis/src/cache/cache.service.*`: Tasks 20 → 21 (lane obs).
- `domains/billing/src/application/**`, `scripts/check-boundaries.mjs`: Tasks 22 → 23 (lane arch).
- `.github/workflows/ci.yml`, `vitest.config.ts`, `package.json`, `docs/TESTING.md`,
  `docs/RELEASING.md`, `scripts/docs-audit.spec.ts`: Tasks 24 → 25 → 26 → 27 (lane ci).
- Across lanes, only docs and env files overlap, on different sections or adjacent list items:
  `docs/SECURITY.md`, `docs/CONFIGURATION.md`, `docs/OBSERVABILITY.md`, `docs/ARCHITECTURE.md`,
  `docs/DEVELOPMENT.md`, `docs/DOCKER.md`, `docs/API.md`, `README.md`, `domains/billing/README.md`,
  `.env.example`.
  The main loop resolves those at merge time.
- To keep it to that: a new config case goes in a new spec file next to its namespace (as
  `observability-metrics-port.spec.ts` does), not in the shared `namespaces.spec.ts`; a new e2e
  case that another lane's suite would also need goes in a new e2e file.
- Cross-lane order in batch 1: Task 5 adds a migration, so lane bill merges lane db's Task 1 into
  its worktree before starting Task 5. Lane bill works on Tasks 3 and 4 meanwhile.

## Interfaces

- **Env (all optional, defaults keep today's behaviour unless noted):**
  `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` (5000; new behaviour), `DATABASE_MIGRATION_LOCK_RETRIES` (5),
  `DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS` (0),
  `BILLING_GRPC_STRIPE_DEADLINE_MS` (30000; new behaviour), `SHUTDOWN_DRAIN_MS` (0),
  `JWT_ACCESS_KEY_ID`, `JWT_ACCESS_VERIFY_SECRETS`, `JWT_REFRESH_KEY_ID`,
  `JWT_REFRESH_VERIFY_SECRETS`, `GRPC_PRINCIPAL_ASSERTION` (`off` | `warn` | `enforce`, default
  `off`), `GRPC_PRINCIPAL_SIGNING_KEY` / `_FILE`, `GRPC_PRINCIPAL_SIGNING_KEY_ID`,
  `GRPC_PRINCIPAL_PUBLIC_KEYS`, `GRPC_PRINCIPAL_ASSERTION_TTL_SEC` (120).
- **Wire:** gRPC metadata key `x-principal-assertion`; access and refresh JWT header `kid`; event
  envelope fields `traceparent` and `tracestate` (optional); Redis channel
  `{prefix}:auth:revoked`; `Member.email` = `""` and `Member.roles` = `[]` when withheld (proto
  unchanged), `null` in REST and GraphQL.
- **Database:** table `billing.ledger_reanchors` (coordinator-local, system-only, insert and
  select); system method `ledgerTrustedState.reanchor`; online migration steps with a bookkeeping
  table `<schema>.__online_migrations`.
- **Entrypoints in the images:** `dist/cli/dlq-replay.js` (gateway, monolith,
  notifications-service, billing-service), `dist/cli/ledger-reanchor.js` (monolith,
  billing-service). `assemble-image.mjs` traces every `src/cli/*.ts` of an app.
- **Metrics:** `grpc_principal_assertions_total{outcome}`, `cache_requests_total{cache,outcome}`,
  `mail_jobs_total{outcome}`, `redis_eviction_policy_safe`.
- **Libraries:** `@platform/common` gains the Idempotency-Key schema, constants and parameter
  decorator; `@platform/database` gains a page-size helper next to `normalizePageLimit`;
  `@platform/observability` gains capture and run-with helpers for a W3C trace carrier;
  `AppCacheService.getOrSet` takes an optional cache name.
- **Tooling:** `check-boundaries.mjs` gains a per-domain layer rule with an allowlist;
  `scripts/check-audit.mjs` and `.github/audit-ignore.json`; `.github/dependabot.yml`.

## Lanes and files

| Batch | Lane   | Worktree branch  | Tasks                                                                                      |
| ----- | ------ | ---------------- | ------------------------------------------------------------------------------------------ |
| 1     | db     | `lane/a1-db`     | 1 OPS-2 lock waits, 2 OPS-2 online steps (review, covers 1 and 2)                          |
| 1     | bill   | `lane/a1-bill`   | 3 ARCH-1 (review), 4 OPS-3, 5 OPS-1 re-anchor (review)                                     |
| 1     | ops    | `lane/a1-ops`    | 6 OPS-4 + config-ref, 7 OPS-5 + obs-app-metrics, 8 ARCH-8, 9 OPS-1 runbooks, 10 docs drift |
| 2     | jwt    | `lane/a2-jwt`    | 11 SEC-1 (review)                                                                          |
| 2     | mesh   | `lane/a2-mesh`   | 12 grpc-principal warn, 13 grpc-principal enforce (review, covers 12 and 13)               |
| 2     | ws     | `lane/a2-ws`     | 14 ws-revocation-poll-only, 15 ARCH-2                                                      |
| 2     | id     | `lane/a2-id`     | 16 ARCH-4 (review)                                                                         |
| 3     | events | `lane/a3-events` | 17 ARCH-5, 18 notif-push-best-effort, 19 TEST-1                                            |
| 3     | obs    | `lane/a3-obs`    | 20 cache-metrics-missing, 21 ARCH-3                                                        |
| 3     | arch   | `lane/a3-arch`   | 22 ARCH-7, 23 ARCH-6                                                                       |
| 3     | ci     | `lane/a3-ci`     | 24 CI-2 + test-gap-statements-stale, 25 DOC-1, 26 CI-1 fixes, 27 CI-1 gates                |

Batches 2 and 3 have no leftover docs task: every docs edit there belongs to a task that changes
the behaviour or already owns the file.

## Task 1: OPS-2, migrations stop waiting for a lock without limit

- **Goal:** a release-job `ALTER` that meets an open transaction gives up after a bounded wait and
  retries, instead of queueing every query on the table behind it.
- **Design:** verified point 6. Three parts, all needed.
  - The migration session sends `lock_timeout` as a startup parameter
    (`DATABASE_MIGRATION_LOCK_TIMEOUT_MS`, default 5000; 0 disables).
  - On Citus, before the migration session opens, a short preliminary connection makes sure the
    connecting role's default `lock_timeout` equals that value (`ALTER ROLE CURRENT_USER SET …`
    only when it differs) and closes; the migration session's worker connections then start with
    it. `docker/postgres/init/02-roles.sql` and the production SQL in `docs/SECURITY.md` set the
    same default for `app_owner`.
  - A set that fails with 55P03 is rolled back by drizzle and retried with backoff, up to
    `DATABASE_MIGRATION_LOCK_RETRIES` (default 5), under the same advisory lock; then the run
    fails naming the set and the lock timeout.
  - Docs: "one lock-taking change per release" and what a 55P03 failure means, in
    `docs/RELEASING.md` and `libs/database/README.md` (Task 10 adds the pointer from
    `docs/DEVELOPMENT.md`).
- **Files:** `libs/database/src/migrator/run-migrations.ts` and spec, `migrate-cli.ts`,
  `libs/config/src/namespaces/database.config.ts` and a new spec file beside it,
  `libs/database/test/database.int-spec.ts`,
  `docker/postgres/init/02-roles.sql`, `.env.example`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`,
  `docs/RELEASING.md`, `libs/database/README.md`.
- **Acceptance:** `database:int`. A second connection holds `ACCESS SHARE` on a table inside an
  open transaction; a fixture set that alters that table, run with a 500 ms timeout and 1 retry,
  rejects within a few seconds with the set's name and SQLSTATE 55P03 as cause, and its bookkeeping
  table has no new row. At the base the run waits until the test's own timeout. Second case: the
  blocker commits during the backoff and the retry applies the set once. Unit: the startup
  parameters carry `lock_timeout`, and on Citus the preliminary connection runs before the
  migration session. Worker-only blockers on a multi-node cluster stay as probed, not in a spec
  (the int container is single-node): say so in the README.
- **Commit:** `fix(database,docs): bound migration lock waits on the coordinator and citus workers`

## Task 2: OPS-2, online migration steps outside the transaction (**review**, covers Tasks 1 and 2)

- **Goal:** a supported path for `CREATE INDEX CONCURRENTLY` and `VALIDATE CONSTRAINT`, which the
  one-transaction-per-set runner cannot run.
- **Design:** an optional `online/` folder per migration set, holding numbered `.sql` files of one
  statement each. After the set's transactional migrations, under the same advisory lock, each
  pending file runs outside a transaction and is recorded in `<schema>.__online_migrations`
  (name, applied time) only after it succeeds. Statements must be re-runnable (`IF NOT EXISTS`); a
  file that left an invalid index is retried after dropping that index. `DatabaseMigrationSet`
  gains the optional folder; the run summary counts online steps. Domains add no online step in
  this task. Task 1's timeout must not apply here (verified point 6: it cancels a concurrent
  build and leaves an invalid index). Online steps run in a second session, opened while the
  first keeps the advisory lock, with `DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS` (default 0, wait:
  these statements hold no lock that blocks traffic). On Citus the runner sets the role default to
  that value before opening the second session and restores Task 1's value after it; Task 1's
  start-of-run check repairs a value a crashed run left behind.
- **Files:** `libs/database/src/migrator/run-migrations.ts` and spec, the migration set type and
  `assertMigrationSets`, `libs/config/src/namespaces/database.config.ts`,
  `libs/database/test/database.int-spec.ts` and a fixture set, `.env.example`,
  `docs/CONFIGURATION.md`, `libs/database/README.md`.
- **Acceptance:** `database:int`. A fixture set with one online file
  (`CREATE INDEX CONCURRENTLY IF NOT EXISTS …`) applies it once, records it, and a second run
  applies 0. A file that fails records nothing and fails the run naming the file; the next run
  retries it. The same fixture on a distributed table creates the index on its shards. With
  Task 1's timeout at 500 ms and another transaction open for 3 s, the online step still waits and
  ends with a valid index, and the role default is back at Task 1's value afterwards. At the base
  the option does not exist.
- **Commit:** `feat(database,docs): run online migration steps outside the migration transaction`

## Task 3: ARCH-1, Stripe-backed billing RPCs get their own deadline and breaker (**review**)

- **Goal:** in the microservices topology, checkout creation and webhook ingestion get the budget
  the monolith gives them, and slow Stripe calls cannot open the breaker `ListPayments` uses.
- **Design:** follow `AI_GRPC_CHAT_DEADLINE_MS`, at both layers a deadline exists.
  `BILLING_GRPC_STRIPE_DEADLINE_MS` (default 30000, the monolith's `HTTP_HANDLER_TIMEOUT_MS`) in
  billing's gRPC client namespace becomes the channel's service-config deadline
  (`GrpcClientsModule.register(target, { client: { deadlineMs } })`, as `ai-api.module.ts` does;
  without it grpc-js itself ends every billing call at `GRPC_DEADLINE_MS`). The adapter's local
  deadline is that value for `CreateCheckoutSession` and `HandleStripeWebhook` and stays
  `GRPC_DEADLINE_MS` for every other method. Those two methods use a second breaker,
  `billing-stripe`. The gateway cannot read billing's
  Stripe settings, so there is no cross-check against `STRIPE_TIMEOUT_MS`: the docs say the HTTP
  handler timeout still cuts the request at 30 s, as in the monolith, and that Stripe's worst case
  (20 s × 3) is above both.
- **Files:** `domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.ts` and
  spec, `billing-grpc.adapter.ts` and spec in the same folder, a new round-trip spec beside them,
  `billing.constants.ts`, `domains/billing/src/billing-api.module.ts`, `.env.example`,
  `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md` (the breaker table), `domains/billing/README.md`.
- **Acceptance:** a round-trip spec (sandbox off): a real grpc-js server for
  `BILLING_GRPC_PACKAGE` whose handlers answer after 600 ms, and the client registered through
  `BillingApiModule.forRemote()` with `GRPC_DEADLINE_MS=200` and
  `BILLING_GRPC_STRIPE_DEADLINE_MS=2000`. `createCheckoutSession` and `handleStripeWebhook`
  resolve; `listPayments` rejects with the gateway timeout. At the base all three reject at 200 ms.
  `billing-grpc.adapter.spec.ts`: ten timed-out `createCheckoutSession` calls open
  `billing-stripe` while a following `listPayments` still reaches the stub; at the base it fails
  fast.
- **Commit:** `fix(billing,docs): give stripe-backed billing rpcs their own deadline and breaker`

## Task 4: OPS-3, dead letters raise an alert and the replay ships in the images

- **Goal:** a dead-lettered event pages someone, and the replay runs as a one-off job from a
  production image.
- **Design:**
  - New `docker/prometheus/rules/platform.rules.yml` with `KafkaDeadLetters`
    (`increase(kafka_consumer_messages_total{outcome="dead_letter"}[15m]) > 0`), pinned in
    `scripts/prometheus-rules.spec.ts`; one Grafana panel for the same series.
  - The replay body moves into `@platform/transport` as a CLI function (as `runMigrationsCli`
    does for migrations). Each consuming app gets `src/cli/dlq-replay.ts`.
    `assemble-image.mjs` traces every `src/cli/*.ts` of the app next to `main`, `instrument` and
    `migrate`, and the Dockerfile's load check covers them. `libs/transport/scripts/kafka-dlq-replay.mjs`
    becomes a thin wrapper for a checkout.
  - Runbook next to the outbox one in `docs/OBSERVABILITY.md`: what the alert means, the replay
    command as a Job, the 14-day `.dlq` retention and the need to raise it or archive in production.
- **Files:** `docker/prometheus/rules/platform.rules.yml`, `scripts/prometheus-rules.spec.ts`,
  `docker/grafana/dashboards/nestjs-overview.json`, `libs/transport/src/kafka/` (the CLI function
  and spec), `libs/transport/scripts/kafka-dlq-replay.mjs`, `apps/{gateway,monolith,notifications-service,billing-service}/src/cli/dlq-replay.ts`,
  `scripts/docker/assemble-image.mjs` and spec, `Dockerfile`, `docs/OBSERVABILITY.md`,
  `docs/DOCKER.md`.
- **Acceptance:** the rules spec fails at the base because no rule reads the dead-letter series.
  `assemble-image.spec.ts`: an app with `src/cli/x.ts` gets `dist/cli/x.js` in its entrypoints (the
  base lists only three). The CLI function's spec: no topic prints the usage and exits 2;
  `--dry-run` replays nothing. Once, by the main loop at the gate: build the notifications-service
  image and run `node dist/cli/dlq-replay.js` in it; it exits 2 with the usage.
- **Commit:** `feat(transport,docker,docs): alert on dead letters and ship the dlq replay in the images`

## Task 5: OPS-1, an audited re-anchor of the ledger trusted state (**review**)

- **Goal:** after an immudb restore, an operator has one supported, recorded way to make R5 pass
  again without hand-editing `billing.ledger_trusted_state`. Starts after Task 1 is merged into the
  lane (it adds a migration).
- **Design:** verified point 1.
  - Migration `0001`: `billing.ledger_reanchors`, coordinator-local and system-only like the
    trusted state, with grants for insert and select only. Columns: id, database, the replaced tx
    id and hash, the new tx id and hash, lost-from time, operator, reason, created time.
  - A new system method `ledgerTrustedState.reanchor` inserts the audit row and compare-and-sets
    the trusted row from the stored state to the new one in one transaction, storing the lost-from
    time as the row's read time. The existing `advance` door keeps refusing a lower tx id.
  - A command, reachable only from `src/cli/ledger-reanchor.ts` (monolith and billing-service),
    with required `--database`, `--lost-from`, `--operator`, `--reason`. In order it refuses when
    the ledger is off, when no signing key is pinned (`LEDGER_ALLOW_UNVERIFIED` does not help),
    when the current state's signature does not verify, and when the current state still extends
    the trusted one (nothing to re-anchor). Then it writes the audit row and the state, and runs
    `ReconcileLedgerCommand` over `[lost-from, now)`.
  - R5 reads the latest re-anchor: a ref posted before it whose tx id is above the re-anchored
    state's comes from the lost history and is verified like a ref without a tx id. A ref whose
    entry is still missing reports `verification_failed`; R4 re-enqueues what Stripe lists in the
    window, and the posting path re-posts it once (the Postgres ref keeps its old tx id).
  - Docs: `docs/SECURITY.md` ("Losing or replacing the server") points at the command;
    `domains/billing/README.md` describes the door and the first run's expected findings.
- **Files:** `billing.schema.ts`, the new migration and its snapshot, `billing.migrations.spec.ts`,
  `billing.system-methods.ts` and spec, `drizzle-ledger.system-repository.ts`,
  `application/repositories/ledger.system-repository.ts`, a new `reanchor-ledger` command folder,
  `checks/r5-verification.ts` and spec, `billing-core.module.ts`,
  `apps/{monolith,billing-service}/src/cli/ledger-reanchor.ts`, `billing.ledger.rls.int-spec.ts`,
  a new `ledger-reanchor.int-spec.ts`, the int specs that enumerate billing's tables or compare
  catalogs (`billing.migrations.int-spec.ts`, `billing.distribution.int-spec.ts`, and
  `billing.squash.int-spec.ts`, which must keep comparing the stacked fixture with the baseline
  only), `docs/SECURITY.md`, `domains/billing/README.md`.
- **Acceptance:** `billing:int`, real immudb with a signing key. Post entries A and B, let R5
  advance, then point the adapter at a fresh immudb database holding only A (the restore). (1) R5
  fails: the characterisation of the audit's finding. (2) The command without a pinned key, and
  with another key pinned, rejects and writes nothing. (3) With the right key it writes one audit
  row and the new state in one transaction; `app_runtime` cannot read the table and `app_system`
  cannot update or delete a row. (4) The follow-up run reports B's ref as `verification_failed` and
  re-enqueues B; after the consumer handles it, immudb holds exactly one entry B, Postgres still
  one ref for B, and the next run is clean. (5) A run on a healthy ledger refuses to re-anchor. At
  the base none of this exists and (1) is the only outcome.
- **Commit:** `feat(billing,docs): add an audited re-anchor of the ledger trusted state after a restore`

## Task 6: OPS-4 and config-ref-pre-ledger-wiring, a drain delay every app can set from the environment

- **Goal:** `SHUTDOWN_DRAIN_MS` makes every app keep serving for that long after SIGTERM while
  readiness already fails, without editing six app modules.
- **Design:** `SHUTDOWN_DRAIN_MS` in the `app` namespace (default 0; about 5000 behind a Service);
  refused unless below `SHUTDOWN_TIMEOUT_MS`. `ObservabilityModule` uses it when its
  `shutdownDrainMs` option is not passed. Docs: `docs/OBSERVABILITY.md` (replace "No app sets
  shutdownDrainMs today"), `docs/CONFIGURATION.md`, the production checklist. The same commit
  fixes config-ref-pre-ledger-wiring in the two files it already edits:
  `docs/CONFIGURATION.md:265-266` (immudb is loaded by the monolith and billing-service with
  `LEDGER_ENABLED=true`) and `:320-321` (billing-service's pinned consumer group), and
  `.env.example:201` (drop "not loaded by any app yet").
- **Files:** `libs/config/src/namespaces/app.config.ts` and a new spec file beside it,
  `libs/observability/src/observability.module.ts` and spec, `.env.example`,
  `docs/OBSERVABILITY.md`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`,
  `scripts/docs-audit.spec.ts` (new).
- **Acceptance:** the module built with `SHUTDOWN_DRAIN_MS=5000` and no option hands 5000 to the
  health module (0 at the base); an explicit option still wins; a drain equal to or above
  `SHUTDOWN_TIMEOUT_MS` fails config validation naming both variables. A docs spec case fails at
  the base on "not loaded by any app yet"; `node scripts/check-env-example.mjs` passes.
- **Commit:** `feat(config,observability,docs): add a shutdown drain delay every app reads from env`

## Task 7: OPS-5 and obs-app-metrics-sentence-stale, the production Redis requirements are documented and checked

- **Goal:** an operator learns from the checklist, and from the logs, that this Redis must not
  evict and must persist.
- **Design:** the production checklist and `docs/CONFIGURATION.md` state the eviction policy
  `noeviction`, AOF, sizing guidance and a memory alert, and why (the denylist, queues, locks and
  throttle counters share `REDIS_URL`). At boot, `@platform/redis` reads `maxmemory_policy` from
  `INFO memory`, logs one structured error line when it is not `noeviction`, and sets the gauge
  `redis_eviction_policy_safe` (1, 0, or absent when the server hides the value). It never fails
  the boot. The same commit fixes obs-app-metrics-sentence-stale in the metrics catalogue it
  already edits: narrow `docs/OBSERVABILITY.md:208-209` to "no Redis command or query-latency
  metrics", add rows for `db_system_calls_total` and `db_rls_elevations_total`, and mention
  `pool="system"` and `DATABASE_SYSTEM_POOL_MAX` in the `db_pool_*` rows.
- **Files:** `libs/redis/src/` (a small boot check and spec, the module), `libs/redis/README.md`,
  `docs/SECURITY.md`, `docs/CONFIGURATION.md`, `docs/OBSERVABILITY.md`, `docs/DOCKER.md`,
  `scripts/docs-audit.spec.ts`.
- **Acceptance:** against `InMemoryRedis` answering `maxmemory_policy:allkeys-lru`, the check logs
  the error once and the gauge is 0; `noeviction` gives 1 and no log; an `INFO` error gives no
  gauge and no throw. No check exists at the base. Docs spec cases, failing at the base: no doc
  says "no app-level Redis or database metrics", and the catalogue has a row for every `db_*`
  series the code registers.
- **Commit:** `feat(redis,docs): warn on an evicting redis policy and document the production needs`

## Task 8: ARCH-8, the architecture doc includes ai-service and the NetworkPolicy advice is right

- **Goal:** `docs/ARCHITECTURE.md` describes six apps, and no doc tells an operator to cut
  ai-service off from the services its tools call.
- **Design:** add ai-service, `domains/ai`, `libs/ai` and `libs/immudb` to §1, §2 and §5
  (composition, readiness, bootstrap) and the ports table, with ai-service's gRPC calls to
  identity-, notifications- and billing-service and their trust model. Reword
  `docs/SECURITY.md:865` and `docs/DOCKER.md:680` to "only the gateway and ai-service reach the
  services' gRPC ports". Fix the stale comment at `apps/identity-service/src/app.module.ts:30`.
- **Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DOCKER.md`,
  `apps/identity-service/src/app.module.ts`, `scripts/docs-audit.spec.ts`.
- **Acceptance:** a docs spec case: every folder under `apps/` is named in
  `docs/ARCHITECTURE.md`, and no doc contains "only the gateway reaches" or "only lets the gateway
  reach". Fails at the base on `ai-service` and on both sentences.
- **Commit:** `docs(repo,identity-service): add ai-service to the architecture doc; fix the grpc policy`

## Task 9: OPS-1, backup and restore runbooks

- **Goal:** one place that says how each store is backed up and restored, and in what order. It
  sits in lane ops because it edits the production checklist; it names Task 5's entrypoint from
  the Interfaces section and does not wait for that task.
- **Design:** verified point 5; a new `docs/OPERATIONS.md`, linked from `README.md`,
  `docs/DOCKER.md` (replacing the stop-and-snapshot paragraph) and the production checklist in
  `docs/SECURITY.md` (a new backup item). Sections: Postgres/Citus (base backups and WAL archive
  per node, `citus_create_restore_point` before a release, recover every node to the same point);
  Cassandra (`nodetool snapshot` per node, restore with `nodetool import` or `sstableloader`);
  immudb (`immuadmin hot-backup` on a cadence shorter than the acceptable loss, or synchronous
  replication, then Task 5's re-anchor); the restore order (Postgres first, then immudb and the
  re-anchor, Cassandra independent) and what each store's loss window means for the others. Every
  step that was not run end to end carries the word UNTESTED.
- **Files:** `docs/OPERATIONS.md`, `README.md`, `docs/DOCKER.md`, `docs/SECURITY.md`,
  `scripts/docs-audit.spec.ts`.
- **Acceptance:** a docs spec case: `docs/OPERATIONS.md` exists, is linked from the README's docs
  list, and names `citus_create_restore_point`, `nodetool snapshot`, `immuadmin hot-backup` and the
  re-anchor entrypoint. Fails at the base (no file).
- **Commit:** `docs(repo): add backup and restore runbooks for postgres, cassandra and immudb`

## Task 10: batch 1 docs drift

- **Goal:** the three stale statements in files no other batch-1 task touches say what the code
  does.
- **Design:**
  - api-subpath-followup-stale: `docs/DEVELOPMENT.md:373` becomes "the build stage compiles every
    lib and domain; the runtime image keeps only traced files"; drop "(per-domain API subpath
    exports)" from `docs/API.md:1059`.
  - devdocs-kafka-section-pre-outbox: `docs/DEVELOPMENT.md:603-620` links to
    `docker/kafka/topics.txt` for the six topics and says Postgres contexts enqueue through their
    outbox; only a context without a store calls `KafkaProducer.publish`.
  - spec-roadmap-status-stale: one status line under the header of
    `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` and the roadmap rows
    marked shipped.
  - One sentence in the expand/contract section of `docs/DEVELOPMENT.md` points at Task 1's lock
    timeout and Task 2's online steps in `libs/database/README.md`.
- **Files:** `docs/DEVELOPMENT.md`, `docs/API.md`, the program spec, `scripts/docs-audit.spec.ts`.
- **Acceptance:** docs spec cases, each failing at the base: no doc says "Today there are three"
  or calls the per-domain API subpath exports a follow-up, and the program spec's roadmap has no
  row marked "next".
- **Commit:** `docs(repo): correct the stale follow-up, kafka and roadmap statements`

## Task 11: SEC-1, JWT secrets rotate in phases (**review**)

- **Goal:** either JWT secret can be rotated with no 401 window and no forced logout.
- **Design:** the signing secret stays `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`. New, optional:
  `JWT_ACCESS_KEY_ID` / `JWT_REFRESH_KEY_ID` (written as the `kid` header when set) and
  `JWT_ACCESS_VERIFY_SECRETS` / `JWT_REFRESH_VERIFY_SECRETS` (comma-separated `kid:secret`,
  verify-only). Verification: a known `kid` selects that key only; an unknown `kid` is
  `INVALID_TOKEN`; no `kid` tries the signing key, then each verify-only key. Every listed secret
  passes the existing guards (length, no development default, no known local value, access and
  refresh sets disjoint). All verifiers use one resolver: the passport strategy, `TokenService`,
  the refresh verification in the issuer, and `signTestAccessToken`. `docs/SECURITY.md` gains the
  three-phase procedure (add the new secret as verify-only everywhere; switch the signer and keep
  the old one as verify-only; drop the old one after the longest TTL) and says a leaked secret is
  still dropped at once.
- **Files:** `libs/config/src/namespaces/auth.config.ts` and a new spec file beside it,
  `libs/auth/src/strategies/jwt.strategy.ts`, `libs/auth/src/auth.module.ts`,
  `libs/auth/src/tokens/token.service.ts` and specs, `libs/auth/src/testing/sign-test-access-token.ts`,
  `domains/identity/src/infrastructure/security/refresh-token.config.ts`,
  `token-issuer.service.ts` and specs, `.env.example`, `docs/SECURITY.md`, `docs/CONFIGURATION.md`.
- **Acceptance:** unit, each failing at the base (one secret only). A token signed with secret A
  and no `kid` verifies on a verifier whose signer is B with A verify-only (the rotation window),
  through the strategy and through `TokenService`; the same for a refresh token. A token with a
  `kid` verifies on a single-secret verifier holding the same secret (an old replica). A token
  with an unknown `kid` is refused even when its signature matches a listed key. Removing A from
  the list refuses A's tokens. A production config with a development default inside a verify list
  is refused.
- **Commit:** `feat(auth,identity,config,docs): verify jwts against a key set so secrets rotate in phases`

## Task 12: grpc-principal-unsigned, the edge signs the principal and services verify it

- **Goal:** the gateway attaches a signed assertion of the principal to every gRPC call, services
  verify it, and nothing is refused yet.
- **Design:** verified point 2.
  - Assertion: a compact ES256 JWS built with `node:crypto` (no new dependency), claims user,
    tenant, roles, staff, issuer, key id, issued-at and expiry
    (`GRPC_PRINCIPAL_ASSERTION_TTL_SEC`, default 120; documented to stay above the longest gRPC
    deadline, `AI_GRPC_CHAT_DEADLINE_MS`). Metadata key `x-principal-assertion`.
  - Signer: a process with `GRPC_PRINCIPAL_SIGNING_KEY` (or `_FILE`) signs for the CLS principal
    on each outgoing call. A process that received an assertion forwards it unchanged instead
    (ai-service's tools); an override naming another user drops it, as it drops the tenant and
    roles today.
  - Verifier: `GRPC_PRINCIPAL_PUBLIC_KEYS` (`kid=base64 PEM`, comma-separated, so keys rotate like
    Task 11's). Mode `off`: the header is ignored. Mode `warn`: the assertion is verified when
    present; a missing, expired or invalid one, or one whose claims differ from the plain headers,
    is logged and counted in `grpc_principal_assertions_total{outcome}`, and the plain headers
    still build the principal.
  - Production guard: the compose-local key pair is refused like other known local secrets.
- **Files:** `libs/transport/src/grpc/` (a new assertion module and spec, `grpc-metadata.ts`,
  `grpc-caller-context.ts`, `grpc-context.interceptor.ts`, `grpc-principal.ts`, `grpc.constants.ts`,
  `grpc-roundtrip.spec.ts`), `libs/config/src/namespaces/grpc.config.ts` and a new spec file beside it,
  `docker-compose.yml` (a generated local key pair, as for `immudb-signing`), `.env.example`,
  `libs/transport/README.md`.
- **Acceptance:** `grpc-roundtrip.spec.ts` and unit, failing at the base (no assertion). A call
  from a signing client carries an assertion the server verifies (`outcome="valid"`). In `warn`, a
  call with plain headers and no assertion (an old gateway) still reaches the handler with its
  principal and counts `missing`. A service that received an assertion forwards the same bytes on
  its own outgoing call. A server in `off` and an old server ignore the header. A tampered claim
  counts `invalid`.
- **Commit:** `feat(transport,config): sign and verify the grpc principal assertion in warn mode`

## Task 13: grpc-principal-unsigned, enforce mode and the rollout (**review**, covers Tasks 12 and 13)

- **Goal:** with `GRPC_PRINCIPAL_ASSERTION=enforce`, a mesh peer without the edge's private key
  cannot assert a user, a tenant, roles or the staff flag.
- **Design:** under `enforce` the principal is built from a valid assertion's claims only. A call
  with `x-user-id` and no valid assertion fails `UNAUTHENTICATED` `INVALID_PRINCIPAL`; a call
  without `x-user-id` stays anonymous (register, login, a signed webhook). Consumers make no gRPC
  call today; one added later either runs in a process that holds the signing key or calls
  anonymously, and the README says so. Rollout in `docs/SECURITY.md`: deploy with `off`,
  distribute the keys, switch services to `warn`, watch the counter reach only `valid`, then
  `enforce`. An old ai-service drops the assertion on its tool calls, so the owning services go
  to `enforce` only after every ai-service replica runs the new code. "Known gaps" lists unsigned metadata as the state under `off` and `warn`. The
  microservices compose topology and `check-topology.ts` run with `enforce`.
- **Files:** `libs/transport/src/grpc/grpc-principal.ts`, `grpc-context.interceptor.ts` and specs,
  a test signer among `@platform/transport`'s test helpers, new
  `apps/{identity-service,ai-service}/test/principal-assertion.e2e-spec.ts` (the existing service
  e2e specs keep running in `off` and are not edited), `docker-compose.yml`,
  `scripts/docker/check-topology.ts`, `docs/SECURITY.md`, `docs/CONFIGURATION.md`,
  `docs/ARCHITECTURE.md`, `apps/ai-service/README.md`.
- **Acceptance:** fails at the base (no mode). identity-service e2e under `enforce`: plain headers
  asserting `x-staff: true` and `owner` for a tenant without a membership are refused
  `UNAUTHENTICATED`; the same call with a test-signed assertion passes; register and login without
  any header pass; an expired assertion is refused. ai-service e2e under `enforce`: a tool call made
  late in a turn forwards the caller's assertion and the owning service accepts it. Batch gate:
  the microservices topology smoke passes with `enforce`.
- **Commit:** `feat(transport,docs): enforce signed grpc principals and document the rollout`

## Task 14: ws-revocation-poll-only, revoked sockets close at once

- **Goal:** a logout, tenant switch or staff switch-out closes the token's live Socket.IO and
  graphql-ws sessions within a round trip, not at the next sweep.
- **Design:** `AccessTokenDenylist.deny` also publishes the jti on `{prefix}:auth:revoked` (after
  the SET; a failed publish is logged, never thrown). Each replica's `RevocationSweeper`
  subscribes, with the subscriber plumbing `AppCacheService.broadcast` already uses, and ends the
  matching sessions. The timed sweep stays as the fallback. `docs/SECURITY.md` shrinks the known
  gap to that fallback and names the 300 s cap.
- **Files:** `libs/auth/src/tokens/access-token-denylist.service.ts` and spec,
  `libs/auth/src/ws/revocation-sweeper.ts`, its spec and a new int spec, `libs/auth/README.md`,
  `docs/SECURITY.md`, `docs/CONFIGURATION.md`, `docs/TESTING.md` (the int table).
- **Acceptance:** unit, with the sweep interval at its maximum: `deny(jti)` on one sweeper's Redis
  closes the session registered on a second sweeper before any timer fires (at the base it stays
  open). Mixed version: a key set without a publish (an old replica) is still closed by the next
  sweep, and a malformed message on the channel is ignored. A new
  `libs/auth/src/ws/revocation-sweeper.int-spec.ts` (project `auth:int`, the package's first int
  spec): the same across two real Redis connections.
- **Commit:** `feat(auth,docs): close revoked websockets at once through a redis revocation channel`

## Task 15: ARCH-2, maintenance mode covers graphql-ws and Socket.IO

- **Goal:** with `MAINTENANCE_MODE=true`, WebSocket clients get the same refusal REST clients get.
- **Design:** the three WebSocket entry points read the existing `MAINTENANCE_MODE` token:
  graphql-ws `onConnect` closes the connection, `onSubscribe` answers a `SERVICE_UNAVAILABLE`
  error, and the Socket.IO namespace middleware fails the handshake with the 503 problem. Docs
  keep "every request" but list the transports; `docs/ARCHITECTURE.md:303-307` says the switch is
  read by the middleware and by the WebSocket entry points, and that consumers, crons and the
  relay keep running.
- **Files:** `libs/graphql/src/apollo-config.factory.ts` and spec,
  `domains/notifications/src/presentation/ws/notifications.gateway.ts` and spec, a new
  `apps/monolith/test/maintenance.e2e-spec.ts`, `docs/API.md`, `docs/CONFIGURATION.md`,
  `docs/ARCHITECTURE.md`, `apps/monolith/README.md`.
- **Acceptance:** monolith e2e booted with maintenance on: a graphql-ws connection is refused, a
  Socket.IO handshake gets `connect_error` carrying status 503, and `/health/live` still answers.
  At the base both sockets connect.
- **Commit:** `fix(graphql,notifications,docs): apply maintenance mode to graphql-ws and socket.io`

## Task 16: ARCH-4, the member list returns emails and roles only with `users:read` (**review**)

- **Goal:** the user's decision, in both topologies and on REST, GraphQL and gRPC.
- **Design:** the gate is in `ListMembersHandler`, which both topologies run. It already resolves
  the actor's roles from the membership row (`actorTenantRoles`; a staff principal's from its
  token); it derives `users:read` from those roles and withholds `email` and `roles` of every
  other member when the permission is missing. The caller's own row stays complete. Display name,
  user id and join date are always returned. On the wire a withheld member has `email: ""` and
  `roles: []` (the proto is unchanged; the `memberships_roles_not_empty` check guarantees a real
  member has a role). The REST response and the
  GraphQL model map those to `null`, so their `email` and `roles` become nullable. The testing
  fakes and the in-memory tenancy apply the same rule. `UpdateMemberRoles` keeps returning the
  full member (it needs `members:manage`). Docs: the RBAC matrix in `docs/SECURITY.md`,
  `docs/API.md` (both transports) and `domains/identity/README.md`; roll identity-service before
  the gateway.
- **Files:** `domains/identity/src/application/queries/list-members/list-members.handler.ts` and
  spec, `application/mappers/member.mapper.ts`, `presentation/http/responses/member.response.ts`,
  `presentation/graphql/models/member.model.ts`, `presentation/graphql/tenancy.mapper.ts`,
  `src/testing/fake-tenancy-ports.ts`, `src/testing/in-memory-tenancy.ts`,
  `apps/{monolith,gateway}/test/tenancy-journeys.e2e-spec.ts`,
  `apps/monolith/test/tenancy-graphql.e2e-spec.ts`,
  a new `apps/identity-service/test/members-rpc.e2e-spec.ts`,
  `docs/SECURITY.md`, `docs/API.md`, `domains/identity/README.md`.
- **Acceptance:** each fails at the base, where every member gets every field. Handler spec: a
  `member` gets co-members with `email: ""` and `roles: []` and their own row complete; an `admin`
  gets everything; a principal whose token says `admin` but whose membership is `member` is
  treated as a member. Monolith and gateway e2e: `GET /v1/tenant/members` and `tenantMembers` as a
  member return `null` email and roles for others. identity-service e2e over gRPC: the same as
  `""` and `[]`. Mixed version: the gateway mappers pass a complete member through unchanged (an
  old service), and a withheld member satisfies the old non-null GraphQL type (an old gateway).
- **Commit:** `fix(identity,docs): return member emails and roles only to callers holding users:read`

## Task 17: ARCH-5, relayed events continue the request's trace

- **Goal:** the consumers of an outbox event appear in the trace of the request that wrote it.
- **Design:** verified point 4; no migration. `KafkaProducer.createRecord` adds the optional
  envelope fields `traceparent` and `tracestate` from the active span context (absent without a
  valid one), so the outbox row and a direct publish carry them. `publishStored` sends under the
  context extracted from those fields; the kafkajs instrumentation then parents the produce span
  and injects the record headers. The helpers live in `@platform/observability`. The envelope
  schema declares both fields as optional strings.
- **Files:** `libs/contracts/src/events/envelope.ts` and spec,
  `libs/transport/src/kafka/kafka-producer.service.ts` and spec,
  `libs/observability/src/tracing/` (helpers and spec), `libs/outbox/src/outbox-relay.spec.ts`,
  `libs/outbox/README.md`, `docs/OBSERVABILITY.md`, `docs/ARCHITECTURE.md`.
- **Acceptance:** with an in-memory span exporter, `createRecord` inside a span stores that span's
  `traceparent`, and `publishStored` of that envelope from a context without a span runs the send
  under the same trace id; at the base the send has no parent. Mixed version: an envelope without
  the fields is relayed and parsed as before; an envelope with them parses under a schema built
  without them (an old consumer strips them); without an active span the envelope is identical to
  today's, key for key.
- **Commit:** `feat(contracts,transport,observability,docs): carry the trace context through the outbox`

## Task 18: notif-push-best-effort, a failed push publish redelivers the event

- **Goal:** the real-time push is delivered at least once without a new store.
- **Design:** the audit's fix (b). The welcome and receipt handlers, the only
  production creators of a notification, publish `notifications.notification-created.v1`
  themselves, last, after `mail.enqueue`, and a failed publish throws. The saga that published
  after the commit goes, so there is one publish path; the three monolith e2e specs that create a
  notification directly and wait for its push dispatch the publish command too.
  The upstream event is then retried in process and dead-lettered if it keeps failing; Task 4's
  `KafkaDeadLetters` alert covers that. Redelivery is already idempotent (the notification id is
  derived, the mail job is deduplicated for 24 h, the edge claims `push:dedupe:<id>`). **This
  deliberately flips the spec that pins "never throws into the bus: a broker failure resolves
  false"**; the commit body says so and names the trade-off: a persistent publish failure
  dead-letters an event whose row and mail were already written. The item leaves all ten doc
  places the audit lists.
- **Files:** `domains/notifications/src/application/commands/publish-notification-created/*`,
  `welcome-user/welcome-user.handler.ts`, `send-payment-receipt/send-payment-receipt.handler.ts`,
  `create-notification/create-notification.handler.ts`, `application/sagas/notifications.sagas.ts`
  and their specs, `apps/monolith/test/{realtime-socket,realtime-graphql,tenant-isolation}.e2e-spec.ts`, `README.md`, `docs/ARCHITECTURE.md`, `docs/PERFORMANCE.md`, `docs/SECURITY.md`,
  `docs/DEVELOPMENT.md`, `docs/API.md`, `domains/notifications/README.md`.
- **Acceptance:** the flipped spec: a broker failure makes the welcome and the receipt handler
  reject (at the base they resolve). A second delivery of the same event after such a failure
  publishes once, writes no second row and enqueues no second mail. The publish happens after
  `mail.enqueue`.
- **Commit:** `fix(notifications,docs): fail the event when the push publish fails so it is redelivered`

## Task 19: TEST-1, specs stop depending on the wall clock

- **Goal:** the inventoried specs cannot fail from load alone, and the absence checks cannot pass
  vacuously. It follows Task 18 in lane events because both edit the realtime e2e suites.
- **Design:**
  - Revocation in the four realtime e2e files: await the close event (Task 14 makes it prompt)
    under the suite's normal timeout; drop `WITHIN_TWO_SWEEPS_MS`.
  - Elapsed-time upper bounds (`kafka.health.spec.ts`, `redis-store.util.spec.ts`,
    `redis-throttler.storage.spec.ts`, `telemetry-flush.service.spec.ts`, the gateway
    `app.e2e-spec.ts`): fake timers or call counts.
  - Absence sleeps (`outbox.e2e-spec.ts`, `tenancy-events.e2e-spec.ts`, `outbox.module.spec.ts`,
    `stream-message.handler.spec.ts`, `QUIET_MS`): a deterministic signal, such as the
    `tickRelays()` result or an awaited idle state. `send-message.handler.spec.ts:409` is an
    ordering sleep: replace it with an explicit gate.
  - `free-port.ts` in the four services: bind port 0 and read the bound port back.
- **Files:** the spec files above, `apps/{identity,billing,notifications,ai}-service/test/support/free-port.ts`
  and their callers.
- **Acceptance:** guard, a new `scripts/spec-hygiene.spec.ts` failing at the base: no spec under the listed paths
  compares elapsed wall-clock time to an upper bound or defines `WITHIN_TWO_SWEEPS_MS`, and no
  `free-port.ts` closes a listener before returning its port. Every touched spec passes three
  times in a row with `--maxWorkers=2`.
- **Commit:** `test(repo): remove wall-clock bounds, absence sleeps and the free-port race from the specs`

## Task 20: cache-metrics-missing, cache hits and misses are exported

- **Goal:** `cache_requests_total{cache,outcome="hit"|"miss"}` shows whether cached reads are
  served from the cache.
- **Design:** `AppCacheService.getOrSet` wraps the loader, so a call that ran it counts a miss and
  any other a hit. `cache` is an optional name the caller passes; without one it is the key's
  prefix before the first `:` when that matches a short safe pattern, else `other`; never the raw
  key. Registered with `makeCounterProvider` as the throttler's counters are. The user read cache
  passes its name. `docs/OBSERVABILITY.md` gets the row and loses the follow-up.
- **Files:** `libs/redis/src/cache/cache.service.ts` and spec, the cache module, the user read
  cache's caller, `libs/redis/README.md`, `docs/OBSERVABILITY.md`, `docs/PERFORMANCE.md`.
- **Acceptance:** two `getOrSet` calls for one key count one miss, then one hit, under the passed
  name; a key such as a raw uuid counts under `other`. No counter exists at the base.
- **Commit:** `feat(redis,docs): export cache hit and miss counters per cache name`

## Task 21: ARCH-3, alert rules for the platform and billing, and a mail job counter

- **Goal:** the failures the audit lists each have a rule in the shipped baseline.
- **Design:** extend Task 4's `platform.rules.yml`: sustained redelivery rate, growing consumer
  lag, a breaker open for more than 5 minutes, `rate_limit_fail_open_total` > 0, sustained
  `db_pool_operations_waiting`, the HTTP 5xx ratio, `redis_eviction_policy_safe == 0`. New
  `billing.rules.yml`: any increase of the `billing_checkout_paid_without_*`,
  `billing_checkout_amount_mismatch_total` and `billing_stripe_api_version_mismatch_total`
  counters. `MailProcessor` counts `mail_jobs_total{outcome="sent"|"retried"|"failed"}`, with a
  rule on `failed`. Extend `METRIC_NAMES` and the alert table in `docs/OBSERVABILITY.md`.
- **Files:** `docker/prometheus/rules/platform.rules.yml`, `billing.rules.yml`,
  `scripts/prometheus-rules.spec.ts`, `libs/mailer/src/mail.processor.ts` and spec, the mailer
  module, `libs/mailer/README.md`, `docs/OBSERVABILITY.md`.
- **Acceptance:** the rules spec, failing at the base: every rule's expression names only
  registered series, and each series above is read by at least one rule. Mailer spec: a sent job,
  a retried attempt and a job out of attempts each increment their outcome once.
- **Commit:** `feat(mailer,docker,docs): add platform and billing alert rules and a mail job counter`

## Task 22: ARCH-7, one Idempotency-Key parser and one page-size rule

- **Goal:** the public Idempotency-Key contract and the page-size rule each live in one place.
- **Design:** the schema (8 to 255 characters of `[A-Za-z0-9._:-]`), its constants and the
  parameter decorator move to `@platform/common`; billing and AI keep only their error codes. One
  helper next to `normalizePageLimit` treats 0 or absent as the default, falls back to the default
  for a non-integer and clamps to the maximum; `keysetPage` and `keysetFetchLimit` use it, and the
  five per-domain copies go.
- **Files:** `libs/common/src/` (decorator, schema, constants, index, spec),
  `libs/database/src/pagination/keyset.ts` and spec,
  `domains/billing/src/presentation/http/request-headers.decorator.ts`, `billing.constants.ts`,
  `domains/ai/src/presentation/http/idempotency-key.decorator.ts`, `ai.constants.ts`,
  `domains/ai/src/application/page-size.ts`, the list handlers of notifications, identity (users,
  members) and billing.
- **Acceptance:** characterisation first, green before and after: both domains' existing
  Idempotency-Key specs and the existing e2e cases that send the header, with the same status and
  error code. New: `keysetPage` given limit 0 returns the default page size (1 row
  at the base); a libs-vocabulary style case finds no second copy of the key pattern under
  `domains/`.
- **Commit:** `refactor(common,database,billing,ai): share the idempotency-key and page-size helpers`

## Task 23: ARCH-6, billing's application layer depends on ports, and a check keeps it so

- **Goal:** application and domain code imports infrastructure only through the documented
  exceptions, and a script fails when that erodes.
- **Design:** ports bound in `BillingCoreModule`: a platform-outbox port in front of
  `BillingOutboxSystemRepository.insertAsPlatform`, an outbox-writer port in front of
  `BillingOutbox` (the webhook handler and R4), a ledger-metrics port, and the ledger settings
  injected by token. `check-boundaries.mjs` gains a per-domain rule: files under `application/` or
  `domain/` may not import `infrastructure/` or `presentation/`, except an explicit allowlist that
  starts with the two documented exceptions (identity's `security/`, billing's `stripe/`) and
  identity's `IdentityOutbox`. `docs/ARCHITECTURE.md` §3 and `domains/billing/README.md` describe
  the rule and the allowlist. Last billing task of the program.
- **Files:** new files under `domains/billing/src/application/ports/`,
  `handle-stripe-webhook.handler.ts`, `reconcile-ledger.handler.ts`,
  `post-ledger-entry.handler.ts`, `process-ledger-posting.handler.ts`, `checks/r4-stripe.ts`,
  `checks/r5-verification.ts`, Task 5's command, `billing-core.module.ts`,
  `infrastructure/ledger/billing-ledger.module.ts`, `scripts/check-boundaries.mjs` and spec,
  `docs/ARCHITECTURE.md`, `domains/billing/README.md`.
- **Acceptance:** guard: a `check-boundaries.spec.ts` case runs the new rule over the repo and
  fails at the base, listing the ten imports the audit names. Characterisation, green before and
  after with assertions unchanged: billing's unit specs, `test/stripe-webhook.flow.spec.ts`, and
  `billing:int` `reconcile-ledger.int-spec.ts`.
- **Commit:** `refactor(billing,tooling,docs): put ports in front of billing infrastructure; check layers`

## Task 24: CI-2 and test-gap-statements-stale, the integration job and the test docs match the specs

- **Goal:** the integration job pulls every image its specs start, its hook budget exceeds every
  container budget, and the docs describe the coverage that exists.
- **Design:** a small script prints the int images from the testing packages' image constants;
  the job pre-pulls that list and is renamed. `intHookTimeoutMs` becomes the largest container
  start budget plus a margin. Docs: `docs/TESTING.md` (six e2e suites; the integration table as a
  per-package summary; "Known gaps" reduced to the Nest consumer stack on a real broker, with
  cross-process gRPC covered by the topology smoke), `docs/DOCKER.md:595-597` (the job's stores,
  six apps), `docs/RELEASING.md:169` replaced by a link to `docs/TESTING.md`.
- **Files:** `.github/workflows/ci.yml`, `scripts/` (the image list script and spec),
  `vitest.config.ts`, `scripts/vitest-config.spec.ts`, `docs/TESTING.md`, `docs/DOCKER.md`,
  `docs/RELEASING.md`.
- **Acceptance:** the script's spec: its output contains the Citus, Cassandra, Kafka, immudb,
  RustFS and fake-gcs images, and `ci.yml` pulls from it (at the base the workflow names one
  image). `vitest-config.spec.ts`: the int hook timeout is above 180 s plus the margin. A docs spec
  case: `docs/TESTING.md` names every package that has an `*.int-spec.ts`.
- **Commit:** `fix(ci,docs): pre-pull every int image, widen the hook budget and correct the test docs`

## Task 25: DOC-1, a database at the stacked tip upgrades in place

- **Goal:** the docs say what the specs pin, and an int test pins the upgrade end to end.
- **Design:** `docs/DEVELOPMENT.md:472-475`, `README.md:137-139`,
  `domains/identity/README.md:302-303` and `domains/billing/README.md:451-452` say that a database
  fully migrated before the squash skips the baseline, and only one stopped part-way must be
  recreated (the runner refuses it and says so). One int case per domain applies the stacked
  fixture to its tip, then the current set.
- **Files:** the four docs, `domains/billing/src/infrastructure/persistence/billing.squash.int-spec.ts`,
  `domains/identity/src/infrastructure/persistence/identity.squash.int-spec.ts`.
- **Acceptance:** `billing:int` and `identity:int`: after the stacked fixture, the current set
  skips `0000_init` and applies only the files added after the baseline (none for identity; Task
  5's `0001` for billing), and the catalog of the pre-squash tables is unchanged. It passes at the base (a characterisation of the
  behaviour the docs misdescribe); a docs spec case fails at the base on "must be recreated"
  without the part-way qualifier.
- **Commit:** `test(billing,identity,docs): pin the stacked-tip upgrade and correct the pre-squash docs`

## Task 26: CI-1, dependencies with a fixed high advisory are upgraded

- **Goal:** the advisory gate of Task 27 starts green.
- **Design:** verified point 3. The main loop runs it (it changes `bun.lock`). Apply
  `bun audit fix`, then bump the catalog pins or add `overrides` for the remaining high advisories
  that have a fixed version. An advisory with no fixed version, or whose fix needs a major the
  repo cannot take yet, goes to `.github/audit-ignore.json` with a reason and an expiry date. The
  local kafkajs patch must still apply.
- **Files:** `package.json`, `bun.lock`, `.github/audit-ignore.json`, `README.md` (the versions
  note, if a listed version changed).
- **Acceptance:** `bun audit --production --audit-level=high`, minus the ignore file, lists
  nothing (22 at the base); the batch gate is green on the new lockfile.
- **Commit:** `fix(deps): upgrade the dependencies that have a fixed high advisory`

## Task 27: CI-1, dependency, image and coverage gates; pinned base image and actions

- **Goal:** CI fails on a new high advisory, a fixable high OS vulnerability in an image or a
  coverage drop; builds are reproducible; the commit and proto gates run for direct pushes.
- **Design:** verified point 3.
  - `scripts/check-audit.mjs` runs `bun audit --json --production`, drops the ignores that have
    not expired and fails on any high or critical left; an expired ignore fails too. The verify
    job runs it, and a weekly scheduled run reports advisories without a push.
  - The image job scans each built image with `aquasecurity/trivy-action` pinned to the commit of
    `v0.36.0`: `vuln-type: os`, `severity: HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: 1`.
    Before turning the gate on, scan the six images once and record the result in the commit body.
  - `DISTROLESS_IMAGE` is pinned by its multi-arch index digest (resolved with
    `docker buildx imagetools inspect`); the "Inspect image" step prints the runtime Node version. Every action is pinned to a full commit SHA with its tag in a comment.
    `.github/dependabot.yml` covers `github-actions` and `docker`. Whether Dependabot bumps the
    `ARG` digest is UNTESTED: `docs/RELEASING.md` gives the manual bump.
  - commitlint and `check-proto-breaking` also run on push, against `github.event.before`.
  - The verify job runs the tests with coverage; `vitest.config.ts` gets global thresholds set to
    the measured batch-3 baseline minus two points. `docs/RELEASING.md` and `docs/TESTING.md`
    describe the gates.
- **Files:** `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/check-audit.mjs` and
  spec, `Dockerfile`, `vitest.config.ts`, `scripts/vitest-config.spec.ts`, `package.json` (a script
  entry), `docs/RELEASING.md`, `docs/TESTING.md`, `docs/DOCKER.md`.
- **Acceptance:** `check-audit` spec: a high advisory fails; the same advisory with an unexpired
  ignore passes; an expired ignore fails. A `scripts/` spec over `ci.yml` and the Dockerfile, failing
  at the base: every `uses:` is a 40-character SHA, the distroless image carries a digest, and the
  commitlint and proto steps have no pull-request-only condition. `vitest-config.spec.ts`: the four
  thresholds are set. Locally: `bun run test:cov` passes its thresholds, and Trivy with the same
  flags reports 0 on one built image.
- **Commit:** `ci(ci,docker,docs): gate on advisories, image os packages and coverage; pin by digest`
