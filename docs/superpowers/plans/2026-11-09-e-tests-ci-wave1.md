# E Wave 1 (Tests and CI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Executive summary

Eight wave-1 tasks from `feat/domains-tenancy`, in two lanes: `e-ci` (Tasks 1-6, in order) and `e-storage` (Task 7, in parallel). Task 8 closes the wave after both lanes are merged. Tasks 1 and 2 must land before B2 executes: the controller merges `e/ci-tooling` right after Task 2, and the lane goes on from there. The 2026-11-09 review renumbered the tasks (old number in each heading).

| Task | Inventory         | Deliverable                                                                                                                                        |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | E-6               | `bun run db:check` (`drizzle-kit check` per Postgres domain) in CI; a spec proves it catches forked snapshot chains                                |
| 2    | B1FU-9            | Neutral vocabulary in `libs/**` specs and fixtures, enforced by `scripts/libs-vocabulary.spec.ts` (`libs/auth/` exempt until B2-20)                |
| 3    | B1FU-10, B1FU-11  | `vitest.setup.ts` silences Nest's static logger and the `TestingLogger` (`TEST_LOGS=1` restores them); unit and `scripts` projects get 15 s / 30 s |
| 4    | AUDIT-F35, B1FU-8 | `check-env-example.mjs` also scans `apps/*/src` and every `libs/*/src`, and cross-checks the compose `${VAR}` knobs                                |
| 5    | E-5               | `scripts/check-proto-breaking.mjs`: `buf breaking` per contracts package against the PR base, new packages skipped, no override label              |
| 6    | E-4               | `scripts/docker/check-topology.ts` boots a topology in an isolated project, waits for `/health/ready`, registers a user, tears down                |
| 7    | E-3               | RustFS and fake-gcs testcontainer int specs for both storage drivers: upload, stream, head, delete, presigned PUT/GET                              |
| 8    | FU-9, FU-10       | Docs close-out: upstream blockers re-checked (no work), README test count                                                                          |

The review (2026-11-09, "Plan review" at the end) ran every script and spec of this plan in a scratch copy of the repo:

- All specs pass after their step and fail before it as stated. `tsc` and the repo's ESLint config pass on every `.ts` file. Every commit message passes commitlint.
- Task 7's int spec passes 12/12 against the real `rustfs/rustfs:1.0.0` and `fsouza/fake-gcs-server:1.56.1` images.
- Fixed: Task 3 also mutes the `TestingLogger` that `Test.createTestingModule().compile()` installs, which still printed errors. With the fix, a unit run prints 0 `[Nest]` lines, down from 38.
- Fixed: a Task 4 test that could never pass. Task 2's guard now also catches identifiers (`FIXTURE_PAYMENT_SUCCEEDED_EVENT`, `paymentId`, `notifications_by_user`): 120 hits in 29 files, not ~125 in 34.
- Also fixed: a Biome error (`escape` shadows a global), wrapped commit bodies (they were single lines over 100 characters), the TESTING.md timeouts cell, and DOCKER.md anchors that collided with S.

Contracts other lanes consume (details in "Interface contracts" and "Shared files"):

- After Task 2, any new or edited `libs/**` spec uses the neutral vocabulary. C's `rate-limit-policy.spec.ts` and G's `grpc-metrics`, `grpc-breaker-metrics`, `kafka-metrics` and `connect-microservices` specs, as currently planned, would fail the guard.
- After Task 4, every `${VAR}` in a root compose file must be documented in `.env.example`.
- Task 6 needs every app to sit in a topology profile and serve `/health/ready` on port 3000. Every infra service needs a healthcheck, and every host port knob is named `<X>_HOST_PORT` with a `:-default`.
- The smoke journey is `POST /v1/auth/register` → 201 `accessToken`, then `GET /v1/auth/me` → the same `email`. B2-7 and B2-18 keep it working or update `smokeJourney`.
- Proto policy (Task 5): no override label. A breaking change ships as `<ctx>.v2`, and B2 keeps `identity.v1` additive (deprecate, never delete fields).

Rulings applied: Tasks 1 and 2 first in `e-ci`, and both precede B2. The `buf breaking` policy is documented in Task 5. The topology job's runner memory (about 6 GiB for microservices) is documented in Task 6. No decision is left for the user.

**Goal:** Close the start-now part of phase E (spec §13): real storage-emulator specs, a cross-process topology smoke test in CI, `buf breaking` and `drizzle-kit check` gates, full `.env.example` coverage, quieter and less flaky unit runs, and libs specs that name no domain.

**Architecture:** Repo tooling only (`scripts/`, `vitest.*`, `.github/workflows/ci.yml`, docs) plus test-only files in `libs/storage` and renamed literals in `libs/**` specs. No production code changes. Every gate is a script with a spec in the `scripts` Vitest project or an `*.int-spec.ts` behind `INTEGRATION=1`.

**Tech Stack:** Node 24.4.0 (type stripping for `scripts/docker/check-topology.ts`), Bun 1.4.3, Vitest 5.0.3, @nestjs/testing 12.1.2, testcontainers 12.2.0 (`GenericContainer`), buf 1.73.0, drizzle-kit 0.31.11, Docker Compose v5, GitHub Actions (`actions/upload-artifact@v7`, `actions/download-artifact@v8`).

**Spec:** `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` (§1 success criteria, §2 roadmap row E, §13 testing strategy, §16 amendments); `docs/superpowers/plans/program-work/inventory.md` (E-3..E-6, AUDIT-F35, B1FU-8..11, FU-9, FU-10); `docs/superpowers/plans/program-work/conventions.md`.

What I checked on 2026-11-09, and what it means for the plan:

- E-5: `buf breaking` against a `git archive` extraction of the base ref, with `--against-config libs/contracts/buf.yaml`, exits 0 when nothing changed and 100 when a field is deleted. I ran both cases on billing's proto. `origin/master` is `9600510`, so `bun run proto:breaking` compares against the B1 state.
- E-6: `drizzle-kit check` (0.31.11) runs offline in about 0.2 s. It passes on billing's history and exits 1 on two snapshots that share a `prevId` ("… is a collision"). `--out` must be relative to the working directory. `bun run --filter '@domain/*' <script>` skips packages without the script and prefixes every output line.
- E-4: the app images have a `/health/live` HEALTHCHECK, so `docker compose up --wait` already covers liveness. Readiness is probed at `http://<svc>:3000/health/ready` from inside the compose network. The script finds the app services from `docker compose config --format json` profiles (checked with Compose v5.6.1: `profiles` is `null` for infra services). So a later app or infra service (Citus, PgBouncer, immudb) needs no change to the script.
- E-3: fake-gcs-server 1.56.1 matches `-public-host` by hostname only when the value has no port (`fakestorage/server.go` `publicHostMatcher`). Signed-URL PUT/GET and the JSON API therefore work on a random testcontainer port.
- B1FU-10: a sandboxed unit run printed 38 `[Nest]` lines (DEBUG, LOG, WARN and ERROR, some with stack traces). B1FU-11: unit projects run at Vitest's 5 s / 10 s defaults while gRPC round-trip specs boot Nest in them.
- FU-9 is still blocked upstream: `@opentelemetry/instrumentation-nestjs-core` 0.72.0 supports `@nestjs/core <12`, `instrumentation-graphql` 0.73.0 supports `graphql <17`, and there is no postgres.js instrumentation. FU-10 is also still blocked: grafana/grafana#112336, grafana/grafana#112348 and jaegertracing/jaeger#7595 are open. So neither gets a task, and Task 8 records the re-check.

## Global Constraints

- **Node.** Prefix every command with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;`. Under Node 20 the pre-commit hook fails.
- **Sandbox.** These run outside the sandbox: the full Vitest run, anything that binds a port (the gRPC round-trip and `listen` specs), Docker (testcontainers, compose, `docker run`), `git fetch`, and GPG signing.
- **Worktrees.** One per lane under the session scratchpad, never inside the repo: lane `e-ci` on branch `e/ci-tooling`, lane `e-storage` on branch `e/storage-int`, both cut from `feat/domains-tenancy`. Only the controller runs `bun install` (`--frozen-lockfile` in a new worktree; plain `bun install` after Task 7 changes `libs/storage/package.json`) and commits `bun.lock`. Lanes merge one at a time with `git merge --no-ff -S`, subject `chore(repo): merge <branch> — <summary>`. **Early merge:** after Task 2 is committed, the controller merges `e/ci-tooling` into `feat/domains-tenancy` (subject `chore(repo): merge e/ci-tooling — db:check gate and libs vocabulary guard`) before any B2 task starts. The lane continues on the same branch, which is merged again after Task 6.
- **Commits.** One GPG-signed commit per task: `git commit -S`, never `--no-verify`. **No attribution lines.** No `Co-Authored-By` or any other trailer. This user decision (2026-11-09) overrides conventions.md §1.2 and §4.2. Header `<type>(<scope>[,<scope>]): <subject>`, at most 100 characters, subject starting lower-case, no trailing period. Body lines at most 100 characters. Types: `build chore ci docs feat fix perf refactor revert style test`. Scopes used here: `tooling` (`scripts/**`, `vitest.*`), `ci` (`.github/workflows/ci.yml`), `docker`, `storage`, `identity`, `billing`, `repo`, `docs`. `scripts`, `vitest` and `e2e` are NOT scopes. Every Commit step writes the message to `$TMPDIR/e-msg.txt`, checks it with `bunx commitlint < "$TMPDIR/e-msg.txt"` (no `✖` and no `⚠`), then commits with `git commit -S -F "$TMPDIR/e-msg.txt"`. Never push, merge to master or open a PR without asking.
- **Search.** Use `rg` and `fd`; `jaq` for JSON. A hook blocks `grep`, `find` and `jq`.
- **Edits.** Line numbers are hints. Match every edit on the quoted text. After editing TypeScript or `.mjs`, run `npx biome check --write <files>`. After editing Markdown or YAML, run `npx prettier --write <files>`. Before each commit, run `bun run check`. It must end with `Layer boundaries OK (<n> packages: apps -> domains -> contracts -> libs).`, where `<n>` is 26 at `9600510` and grows by one for each package another lane has merged (27 after L-1's `@platform/immudb`). This plan adds no package.
- **Tests.** A single spec: `npx vitest run --project scripts <path>` or `npx vitest run --project <pkg> <path>`. Integration: `INTEGRATION=1 npx vitest run --project storage:int` (sandbox off, Docker). Everything: `bun run test` (sandbox off).
- **Layering.** `libs/` names no domain. Specs and fixtures use the neutral example vocabulary (`orders`, `catalog`, `alerts`, `shipments`). `scripts/` is repo tooling, not a workspace package. Biome lints `scripts/**/*.mjs`, and ESLint plus `tsc` cover `scripts/**/*.ts` and the root `*.ts` files. Root files (`vitest.setup.ts`, `scripts/**`) resolve `@nestjs/*` through the hoisted root `node_modules`. They are not root devDependencies, and Biome's root override turns `noUndeclaredDependencies` off for them.
- **Env.** This plan adds no runtime variable. `TEST_LOGS`, `NO_BUILD`, `KEEP`, `PROJECT`, `WAIT_TIMEOUT` and `READY_TIMEOUT_MS` are read only by test tooling. They must NOT be added to `.env.example`, because `check-env-example` would then flag them as unknown. After Task 4, any new `${VAR}` in a root compose file must be documented in `.env.example`.
- **Docker.** Never touch the developer's containers (Postgres 5432, Redis 6379, MySQL) or the `boilerplate` compose project. The topology smoke uses project `bp-topology-<topology>` and host ports shifted by 20000. testcontainers picks random ports. Every `down -v` is preceded by the project-name guard (`projectName()` in Task 6). Task 8's Redis container is removed by its own name only.
- **Extensibility.** Later lanes swap the Postgres image to Citus (S0) and add PgBouncer and immudb services. Nothing in this plan hard-codes the infra service list:
  - `check-topology.ts` derives the apps from compose profiles and the host ports from `${*_HOST_PORT:-n}`.
  - `check-env-example.mjs` reads every root `docker-compose*.yml` or `compose*.yaml`.
  - `scripts/libs-vocabulary.spec.ts` derives the domain words from the `domains/*` folders.

## Review Focus

The five inputs most likely to bite users that no existing test exercises, and the task that adds a test for each:

1. **Presigned URL signed for a public host that differs from the internal endpoint, with a key containing spaces and non-ASCII characters** (browser vs. in-cluster names, SigV4/v4 path encoding). Task 7: the S3 internal endpoint is `127.0.0.1`, the public one `localhost`; the same holds for GCS. The key is `über file (1).csv`. The spec PUTs through the presigned URL, then GETs and compares the bytes.
2. **Size-pinned presigned S3 upload receiving a bigger body; streamed upload larger than one multipart part.** Task 7: `contentLength: 4` with a 6-byte body must be rejected and leave no object. A 5 MiB + 1 KiB stream must HEAD at its exact size.
3. **Two lanes generating migrations in the same domain** (forked snapshot chain, two snapshots with one `prevId`). Task 1: the spec forges the fork in a copy of billing's history and expects `drizzle-kit check` to fail with "collision".
4. **A brand-new contracts package, or an additive field, in a PR** (B2, LEDGER) must not trip the breaking gate, while a deleted field must. Task 5: temp-git-repo spec with unchanged, additive, deleted-field, new-package and unknown-ref cases.
5. **The smoke test running on a developer laptop** must not reuse the `boilerplate` project or default host ports, and must pick up new app services by itself. Task 6: `projectName` refuses `boilerplate`, `shiftedHostPorts` moves every `*_HOST_PORT` knob of the real compose file and keeps env overrides, and `appServices` derives apps from profiles.

## Lane and files

**Lane `e-ci`** (branch `e/ci-tooling`; Tasks 1, 2, 3, 4, 5, 6 in that order; merged into `feat/domains-tenancy` after Task 2 and again after Task 6) owns:

- `scripts/check-drizzle-history.spec.ts` (new)
- `scripts/libs-vocabulary.spec.ts` (new), and the 29 `libs/**` spec/fixture files that Task 2 Step 2 lists (all outside `libs/auth/`; none in `libs/storage/`)
- `vitest.config.ts`, `vitest.setup.ts` (new), `scripts/vitest-config.spec.ts` (new)
- `scripts/check-env-example.mjs`, `scripts/check-env-example.spec.ts` (new)
- `scripts/check-proto-breaking.mjs` (new), `scripts/check-proto-breaking.spec.ts` (new)
- `scripts/docker/check-topology.ts` (new), `scripts/docker/check-topology.spec.ts` (new)

**Lane `e-storage`** (branch `e/storage-int`; Task 7) owns: `libs/storage/test/emulators.ts`, `libs/storage/test/emulator-images.spec.ts`, `libs/storage/test/storage-drivers.int-spec.ts`, `libs/storage/package.json`, `libs/storage/README.md`.

**Task 8** runs on `feat/domains-tenancy` after both lanes are merged.

**Shared files** (exact change per task):

| File                                                           | Task    | Change                                                                                                                                                                    |
| -------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (root `scripts`)                                | 1       | add `"db:check": "bun run --filter '@domain/*' db:check"` after `db:generate`                                                                                             |
| `package.json` (root `scripts`)                                | 5       | add `"proto:breaking": "node scripts/check-proto-breaking.mjs --against origin/master"` after `proto:lint`                                                                |
| `package.json` (root `scripts`)                                | 6       | add `"docker:smoke": "node scripts/docker/check-topology.ts up"` after `docker:down`                                                                                      |
| `domains/identity/package.json`                                | 1       | add `"db:check": "drizzle-kit check"` after `db:generate`                                                                                                                 |
| `domains/billing/package.json`                                 | 1       | add `"db:check": "drizzle-kit check"` after `db:generate`                                                                                                                 |
| `libs/storage/package.json`                                    | 7       | `devDependencies` gains `"testcontainers": "catalog:"` (already in the catalog at 12.2.0)                                                                                 |
| `bun.lock`                                                     | 7       | controller runs `bun install` after the `libs/storage/package.json` edit; no new version                                                                                  |
| `.github/workflows/ci.yml`                                     | 1       | drift step: new name, one comment line, `bun run db:check` after `bun run db:generate`                                                                                    |
| `.github/workflows/ci.yml`                                     | 5       | new `verify` step "Proto breaking changes (buf, PRs only)" after commitlint                                                                                               |
| `.github/workflows/ci.yml`                                     | 6       | header comment; `image` job saves and uploads each image; new `topology` job (matrix `monolith`, `microservices`, `needs: image`)                                         |
| 29 `libs/**` spec and fixture files                            | 2       | domain words become the neutral vocabulary (Task 2 Step 3)                                                                                                                |
| `docs/TESTING.md`                                              | 3, 7    | 3: `<name>` row of "Vitest projects" (`Vitest defaults` → `15 s / 30 s`), new "Test output and timeouts" section; 7: one row in the integration table, `storage:int` line |
| `docs/RELEASING.md`                                            | 1, 5, 6 | CI table cells, the local-gate block, the **Contract changes** paragraph (5) and the "What CI does not do" list                                                           |
| `docs/DOCKER.md` (section `## CI` only)                        | 1, 5, 6 | 1: `db:check` in the **verify** bullet; 5: `buf breaking` in it; 6: **topology** bullet and a `### Topology smoke test` subsection at the end of `## CI`                  |
| `docs/DEVELOPMENT.md`                                          | 1, 4    | 1: `db:check` paragraph in "Database migrations"; 4: the `check-env-example` sentences (`:286`, and `:56`/`:530` if they still name only libs/config and domains)         |
| `docs/CONFIGURATION.md`, `docs/SECURITY.md`                    | 4       | the `check-env-example` row (`:645`); `:297` if needed                                                                                                                    |
| `libs/database/README.md:168-169`                              | 1       | the manual `bunx drizzle-kit check` sentence becomes "CI runs `bun run db:check`"                                                                                         |
| `domains/{billing,identity,notifications}/contracts/README.md` | 5       | manual `buf breaking` block replaced by `bun run proto:breaking`                                                                                                          |
| `README.md:339`                                                | 6       | `scripts/` tree line                                                                                                                                                      |
| `docs/OBSERVABILITY.md:437-439`, `README.md:63`                | 8       | upstream re-check note; test count                                                                                                                                        |

No `apps/*/src/app.module.ts`, `docker-compose.yml`, `Dockerfile`, `scripts/docker/check-infra.sh` or `.env.example` change.

**Overlaps with the other lanes' plans** (C rate limiting, G metrics/packaging, L ledger wave 0, S sharding wave 0, as written on 2026-11-09). Rule for every row: the lane that merges second resolves by keeping both changes. No row needs an order beyond "E Tasks 1-2 and S0 before B2":

| File                                                                                        | Other lane's change                                                                                                                                                                                                                                                          | What E does / how to resolve                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                                                  | S Task 2: `integration` job comment (`:101-103`) and one step. L-1: the drift step's `git diff` / `git status` paths (`:80-81`) gain `libs/immudb/…`                                                                                                                         | Task 1 inserts `bun run db:check` after `:79`, next to L-1's lines. On a conflict keep both: `db:check` stays after `db:generate`, and the paths are L's. Task 5 and Task 6 touch other jobs and steps.     |
| root `package.json` `scripts`                                                               | L-1: `proto:gen` (`:155`) gains `--filter @platform/immudb`. G: the `check` script (`:149`)                                                                                                                                                                                  | Task 5 inserts after `proto:lint` (`:156`), Task 1 after `db:generate` (`:157`). On a conflict keep L's `proto:gen` line and E's new lines                                                                  |
| `domains/{identity,billing}/package.json`                                                   | S Task 1 removes `@testcontainers/postgresql` from `devDependencies`                                                                                                                                                                                                         | Task 1 edits `scripts` only: separate hunks                                                                                                                                                                 |
| `libs/storage/package.json`, `bun.lock`                                                     | G adds an `./testing` export to `libs/storage/package.json`; S Task 1 adds dependencies to `libs/testing`; C and L add catalog entries                                                                                                                                       | Task 7 edits `devDependencies` only. On a `bun.lock` conflict the controller takes either side, re-runs `bun install` and commits the result in the merge                                                   |
| `libs/storage/README.md`                                                                    | G documents the `./testing` subpath                                                                                                                                                                                                                                          | Task 7 appends `## Testing`. If G added a testing section, merge the paragraph into it                                                                                                                      |
| `docs/TESTING.md`                                                                           | S Task 1: mermaid node, pyramid row, toolbox row, "Needs" cells of the integration table (`:240-253`); G and C: toolbox and e2e lists                                                                                                                                        | Prettier re-pads whole tables. Whoever merges second takes the other side's table, re-adds its own row or cell, then runs `npx prettier --write docs/TESTING.md`                                            |
| `docs/DOCKER.md`                                                                            | S Task 2: stack-map row (`:35`) and a "Postgres runs Citus" subsection at the end of `## Bootstrap jobs & migrations`. G and L: other sections                                                                                                                               | E edits only `## CI` (`:429-443`), so there is no shared anchor                                                                                                                                             |
| `docs/DEVELOPMENT.md`                                                                       | S Task 4: `### Citus-ready schema rules` before `## Cassandra CQL migrations`; G                                                                                                                                                                                             | Task 1's paragraph goes right after the `bun run db:generate` paragraph of "Database migrations", above S's subsection                                                                                      |
| `libs/database/README.md`                                                                   | S Task 3 (`:138`), G                                                                                                                                                                                                                                                         | Task 1 edits `:168-169` only                                                                                                                                                                                |
| `libs/database/src/migrator/run-migrations.spec.ts`                                         | S Task 3 adds two tests (neutral `orders` sets)                                                                                                                                                                                                                              | Task 2 rewrites 18 lines of the same file. Both land before B2. The second to merge re-applies its edits                                                                                                    |
| `libs/config/src/namespaces/namespaces.spec.ts`                                             | C grows the throttle `toEqual` per task; L-2a adds `immudb`                                                                                                                                                                                                                  | Task 2 edits only `:24-25` (the "holds no domain namespace" test), `:173-175` (the `identity-service` kafka literals) and `:206` (the `@domain/files` title)                                                |
| `libs/common/src/filters/all-exceptions.filter.spec.ts`, `…/errors/problem-details.spec.ts` | C6 adds ws tests. C's plan already uses the mapping (`notifications.markRead` → `alerts.markRead`)                                                                                                                                                                           | Task 2 renames the existing lines. C's new lines must use `alerts`                                                                                                                                          |
| `libs/transport/src/hybrid/connect-microservices.spec.ts`                                   | G rewrites `:67-140` and asserts `clientId: 'notifications-service'`                                                                                                                                                                                                         | Task 2 renames these literals to `alerts-service`. G must use `alerts-service` once Task 2 has merged                                                                                                       |
| New `libs/**` specs of C and G                                                              | C: `libs/redis/src/throttler/rate-limit-policy.spec.ts` (`'identity.credentials'`). G: `grpc-metrics.spec.ts` (`identity.v1.AuthService`, `billing.BillingService`), `grpc-breaker-metrics.spec.ts` (`identity-gauge`), `kafka-metrics.spec.ts` (`notifications.created.v1`) | After Task 2 the guard fails them. They must use the neutral vocabulary of Task 2 Step 3 (`orders.v1.OrdersService`, `catalog.CatalogService`, `orders-gauge`, `alerts.created.v1`, `'orders.credentials'`) |
| `docs/OBSERVABILITY.md` "Known follow-ups"                                                  | G deletes the "Separate metrics listener" and "No app-level … metrics" bullets, next to Task 8's two bullets                                                                                                                                                                 | Task 8 matches only its two bullets. On a conflict keep G's deletions and Task 8's text                                                                                                                     |
| `README.md:63` (test count)                                                                 | C, G, L, S                                                                                                                                                                                                                                                                   | Task 8 matches on `test files /`, not on the old numbers                                                                                                                                                    |
| `docker-compose.yml`, `.env.example`, `scripts/docker/check-infra.sh`                       | S Task 2 (Citus image, `platform: linux/amd64`), L-6 (immudb), G (metrics ports), C (throttle knobs)                                                                                                                                                                         | E edits none of them. Task 4 makes every new compose `${VAR}` need a `.env.example` entry. Task 6 needs `<X>_HOST_PORT` knobs with a `:-default` and a healthcheck on every new infra service               |

### Execution order

| #   | Task                       | Lane      | Needs      | Notes                                                                        |
| --- | -------------------------- | --------- | ---------- | ---------------------------------------------------------------------------- |
| 1   | `db:check` gate            | e-ci      | –          | first; must be merged before B2 executes (its specs need no raised timeout)  |
| 2   | Libs vocabulary            | e-ci      | 1          | then the controller merges `e/ci-tooling`; must be merged before B2 executes |
| 3   | Vitest hygiene             | e-ci      | 2          |                                                                              |
| 4   | check-env-example coverage | e-ci      | 3          |                                                                              |
| 5   | `buf breaking` gate        | e-ci      | 4          | needs `git fetch origin master` (sandbox off) for its real run               |
| 6   | Topology smoke test        | e-ci      | 5          | needs Docker; longest task; then the controller merges `e/ci-tooling` again  |
| 7   | Storage emulator int specs | e-storage | –          | parallel with 1-6; controller runs `bun install` first                       |
| 8   | Docs close-out             | (main)    | 1-7 merged | README count once                                                            |

### Interface contracts

- `bun run db:check` = `drizzle-kit check` in every `@domain/*` package that has a `db:check` script (Task 1). A new Postgres domain adds `"db:check": "drizzle-kit check"` next to its `db:generate`. Run it after every merge that touches `domains/*/src/infrastructure/persistence/migrations`: it is the merge gate for stacked migrations.
- `scripts/libs-vocabulary.spec.ts` (Task 2): `EXEMPT_PREFIXES = ['libs/auth/']`, which B2-20 deletes when it removes `Permission`/`ROLE_PERMISSIONS`. The domain words are every `domains/*` folder name except `files`, plus `notification`, `payment(s)`, `stripe`, `checkout`, `files-service` and `@domain/files`. A new `domains/<x>` folder adds `<x>` by itself. A word matches between non-alphanumerics, so `_`, `-`, `.` and camelCase humps are boundaries (`paymentId`, `STRIPE_ERROR` and `notifications_by_user` all match). A line may name a domain only with a `vocabulary-allow` comment, to assert absence. The guard reads every `*.spec.ts`, `*.int-spec.ts` and `*.e2e-spec.ts` under `libs/`, plus every `.ts` file under a `test/` or `testing/` folder. That includes all of `libs/testing/src/**`, where S's SH-1 puts `startTestPostgres` and B3 its init SQL helpers. Renamed fixture exports in `libs/transport/test/fixtures/fixture.events.ts`: `fixtureOrderPlacedPayload` (fields `orderId`, `userId`, `amountTotal`, `currency`, `placedAt`), `type FixtureOrderPlacedPayload`, `FIXTURE_ORDER_PLACED_EVENT` (topic `fixture.order-placed.v1`).
- `vitest.config.ts` exports `UNIT_TEST_TIMEOUT_MS = 15_000`, `UNIT_HOOK_TIMEOUT_MS = 30_000`, `SETUP_FILES` and `unitProject`, `scriptsProject` (Task 3). `vitest.setup.ts` exports `configureNestTestLogging(env?)`. In every project, Nest's static logger is dropped and `TestingLogger.prototype.error` is a no-op unless `TEST_LOGS=1`. A spec that asserts on logging spies on `Logger.prototype` methods, or passes its own logger with `Test.createTestingModule(…).setLogger(…)`.
- `node scripts/check-env-example.mjs [--root <dir>] [--list]` (Task 4) scans the following:
  - `libs/config/src/namespaces/*.config.ts` first;
  - then every `*.config.ts` under a `src/` folder of `libs/*`, `domains/*` (contracts included) and `apps/*`;
  - every `${VAR}`, `${VAR:-x}` and `$VAR` (not `$$VAR`) on non-comment lines of root files matching `/^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/`.

  Rules: a compose variable must appear somewhere in `.env.example`, and every key in the compose-only section must be interpolated by a compose file or be one of `COMPOSE_PROFILES`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`. Output on success: `.env.example documents all <n> config variables (<p> from libs/config, <o> from domains, apps and other libs)`, then `.env.example documents all <c> docker compose variables (<comma-separated files>)`.

- `node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>] [--buf <path>] [--error-format <fmt>]` (Task 5) checks every `domains/*/contracts` that has `src/proto`. It skips a package with no `src/proto` at the ref and exits 1 on any breaking change. A new contracts package needs nothing. Policy: there is no override label. A change it rejects ships as a new package version `<ctx>.v2`, served next to v1. Changes to an existing `v1` stay additive: add fields and RPCs, mark retired ones `deprecated`, and never delete, renumber or retype a field. B2 extends `identity.v1` this way.
- `scripts/docker/check-topology.ts` exports (Task 6):
  ```ts
  export const TOPOLOGIES: readonly ['monolith', 'microservices'];
  export type Topology = 'monolith' | 'microservices';
  export function projectName(topology: Topology, env?: NodeJS.ProcessEnv): string;
  export function shiftedHostPorts(
    composeText: string,
    env?: NodeJS.ProcessEnv,
  ): Record<string, string>;
  export function appServices(config: ComposeConfig, topology: Topology): string[];
  export function smokeJourney(baseUrl: string, fetchImpl?: typeof fetch): Promise<SmokeResult>;
  ```
  A new app service must sit in a topology profile, serve `GET /health/ready` on container port 3000 and have an image HEALTHCHECK. A new infra service needs a compose `healthcheck` (so `--wait` covers it), and its host port knob must be named `<X>_HOST_PORT` with a `:-default`. The smoke journey is `POST /v1/auth/register` (body `{ email, password, displayName }`) → 201 with `accessToken`, then `GET /v1/auth/me` → 200 with the same `email`. B2-7 and B2-18 must keep this working or update `smokeJourney`.
- `libs/storage/test/emulators.ts` (test-only, Task 7) exports `startRustfs(): Promise<RunningEmulator>` and `startFakeGcs(): Promise<RunningEmulator>`, where `interface RunningEmulator { readonly internalEndpoint: string; readonly publicEndpoint: string; stop(): Promise<void> }`. These are reusable by B4 (files tenancy) int specs.

**Renumbering map** (2026-11-09 review; other plans that cite E task numbers use the old ones): old 1 → 3, old 2 → 4, old 3 → 1, old 4 → 5, old 5 → 6, old 6 → 7, old 7 → 2, old 8 → 8. So S's "E Task 2" (`check-env-example`) is now Task 4 and "E Task 3" (`db:check`) is Task 1. C's "E Task 7" (libs vocabulary) is now Task 2.

## Tasks

### Task 1: `bun run db:check` (drizzle-kit check) in CI (was Task 3)

Covers E-6. Today CI regenerates migrations and diffs them (`.github/workflows/ci.yml:75-80`), but nothing detects a forked snapshot chain. That fork is the expected failure when parallel lanes (B2, B3, G) each run `db:generate` in the same domain and a renumbered file is merged. `libs/database/README.md:169` asks for a manual `bunx drizzle-kit check`. I checked on 2026-11-09 that `drizzle-kit check` passes on billing's history and exits 1 with `… are pointing to a parent snapshot: … which is a collision` when two snapshots share one `prevId`. `drizzle-kit` resolves `--out` as `./<out>`, so the spec runs it from the parent folder with a relative path.

**Files:**

- Modify: `package.json` (root `scripts`), `domains/identity/package.json`, `domains/billing/package.json`, `.github/workflows/ci.yml:75-80`
- Create: `scripts/check-drizzle-history.spec.ts`
- Modify (docs): `libs/database/README.md:168-169`, `docs/DEVELOPMENT.md` ("Database migrations" section, around `:421-450`), `docs/RELEASING.md:149` (verify row) and `:157-158` (local gate block), `docs/DOCKER.md:433-436` (`## CI`, **verify** bullet)
- Test: `scripts/check-drizzle-history.spec.ts`

**Interfaces:**

- Consumes: `drizzle-kit` 0.31.11 (`node_modules/.bin/drizzle-kit check [--config | --dialect --out]`), each domain's `drizzle.config.ts`.
- Produces: root script `db:check` and per-domain `db:check: "drizzle-kit check"`. This is the merge gate for stacked migrations: run `bun run db:check` after every merge that touches `domains/*/src/infrastructure/persistence/migrations`.

**Wave:** start now (lane `e-ci`, first task). Must be merged into `feat/domains-tenancy` before B2 executes (the controller merges `e/ci-tooling` after Task 2). Its drizzle-kit cases take about 0.2 s each and the `bun run` case sets its own 60 s, so it needs none of Task 3's timeouts.

- [ ] **Step 1: Write the failing spec** `scripts/check-drizzle-history.spec.ts`:

```ts
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DRIZZLE_KIT = join(ROOT, 'node_modules', '.bin', 'drizzle-kit');
/** The Postgres domains: every domains/<x> with a drizzle.config.ts. */
const POSTGRES_DOMAINS = readdirSync(join(ROOT, 'domains'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(ROOT, 'domains', name, 'drizzle.config.ts')))
  .sort();
const historyOf = (domain: string): string =>
  join(ROOT, 'domains', domain, 'src', 'infrastructure', 'persistence', 'migrations');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface Journal {
  entries: JournalEntry[];
}
interface Snapshot {
  id: string;
  prevId: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copies a domain's history to `<tmp>/m`; returns `<tmp>`. */
function copyHistory(domain: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'drizzle-history-'));
  dirs.push(dir);
  cpSync(historyOf(domain), join(dir, 'm'), { recursive: true });
  return dir;
}

/** drizzle-kit prefixes --out with `./`: run it from the parent with a relative folder. */
function drizzleCheck(cwd: string): { status: number | null; output: string } {
  const result = spawnSync(DRIZZLE_KIT, ['check', '--dialect', 'postgresql', '--out', 'm'], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('bun run db:check', () => {
  it('covers the identity and billing histories', () => {
    expect(POSTGRES_DOMAINS).toEqual(expect.arrayContaining(['billing', 'identity']));
  });

  it('runs drizzle-kit check in every Postgres domain and passes on the committed histories', () => {
    const result = spawnSync('bun', ['run', 'db:check'], { cwd: ROOT, encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output.match(/Everything's fine/g)?.length).toBe(POSTGRES_DOMAINS.length);
  }, 60_000);

  it.each(POSTGRES_DOMAINS)('accepts a copy of the committed %s history', (domain) => {
    const result = drizzleCheck(copyHistory(domain));
    expect(result.status, result.output).toBe(0);
  });

  it('rejects a history forked by two lanes (two snapshots with the same parent)', () => {
    const dir = copyHistory('billing');
    const meta = join(dir, 'm', 'meta');
    const journal = readJson<Journal>(join(meta, '_journal.json'));
    const last = journal.entries.at(-1);
    if (last === undefined) throw new Error('billing has no migrations');
    const parent = readJson<Snapshot & Record<string, unknown>>(
      join(meta, `${String(last.idx).padStart(4, '0')}_snapshot.json`),
    );
    for (const [offset, lane] of ['a', 'b'].entries()) {
      const idx = last.idx + 1 + offset;
      const prefix = String(idx).padStart(4, '0');
      const id = `0000000${offset + 1}-0000-4000-8000-000000000000`;
      writeFileSync(
        join(meta, `${prefix}_snapshot.json`),
        JSON.stringify({ ...parent, id, prevId: parent.id }),
      );
      writeFileSync(join(dir, 'm', `${prefix}_lane_${lane}.sql`), 'SELECT 1;\n');
      journal.entries.push({
        ...last,
        idx,
        when: last.when + 1 + offset,
        tag: `${prefix}_lane_${lane}`,
      });
    }
    writeFileSync(join(meta, '_journal.json'), JSON.stringify(journal));

    const result = drizzleCheck(dir);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('collision');
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/check-drizzle-history.spec.ts`
      Expected: FAIL, 1 of 5 (checked in review). Only "runs drizzle-kit check in every Postgres domain …" fails, with bun's `error: Script not found "db:check"` (exit 1). The drizzle-kit cases already pass: they pin the tool's behaviour that the gate relies on.

- [ ] **Step 3: Add the scripts.**
  - `domains/identity/package.json`: after `"db:generate": "drizzle-kit generate",` add `"db:check": "drizzle-kit check",`.
  - `domains/billing/package.json`: after `"db:generate": "drizzle-kit generate",` add `"db:check": "drizzle-kit check",`.
  - Root `package.json`: after the line `"db:generate": "bun run --filter '@domain/*' db:generate",` add `"db:check": "bun run --filter '@domain/*' db:check",`.

- [ ] **Step 4: Run the spec.** `npx vitest run --project scripts scripts/check-drizzle-history.spec.ts`
      Expected: PASS (5 tests). Also run `bun run db:check`. Expected: two `Everything's fine` lines, exit 0.

- [ ] **Step 5: CI.** In `.github/workflows/ci.yml`, step `Generated artefacts drift (protos, migrations) + buf lint`:
  - Rename the step to `Generated artefacts drift (protos, migrations) + buf lint + drizzle-kit check`.
  - In its `run:` block, after the line `          bun run db:generate`, add `          bun run db:check`.
  - Above the step, the comment ends `which `git diff` alone misses.`. Append the line `      # db:check (drizzle-kit check) fails on a forked snapshot chain (two lanes, one parent).`

- [ ] **Step 6: Docs.**
  - `libs/database/README.md:168-169`: the sentence is wrapped over two lines of an indented list item. Replace

    ```text
    Before merging
      a hand-edited history, run `bunx drizzle-kit check --config domains/<x>/drizzle.config.ts`. The runner refuses
    ```

    with

    ```text
    CI runs
      `bun run db:check` (`drizzle-kit check` per domain), which fails on a forked snapshot chain; run it after every
      merge that touches a migrations folder. The runner refuses
    ```

    keeping the two-space indent of the list item, and re-wrap the rest of the paragraph at 116 columns as the file does.

  - `docs/DEVELOPMENT.md`, section "Database migrations": after the paragraph that describes `bun run db:generate`, add the paragraph

    ```text
    After merging branches that both generated migrations in one domain, run `bun run db:check`. It runs `drizzle-kit check` in every Postgres domain and fails when two snapshots share a parent; regenerate the later migration on top of the merged history. CI runs it too.
    ```

  - `docs/RELEASING.md`, **verify** row of the CI table: replace ``then `git diff --exit-code` plus`` with ``then `bun run db:check` (`drizzle-kit check`: no forked snapshot chain), then `git diff --exit-code` plus``. In the local-gate block, replace `bun run proto:gen && bun run db:generate && git status` with `bun run proto:gen && bun run db:generate && bun run db:check && git status`.
  - `docs/DOCKER.md`, section `## CI`, **verify** bullet: replace ``(`proto:gen` + `buf lint` + `db:generate`,`` with ``(`proto:gen` + `buf lint` + `db:generate` + `db:check`,``.

- [ ] **Step 7: Checks.** `npx biome check --write scripts/check-drizzle-history.spec.ts package.json domains/identity/package.json domains/billing/package.json && npx prettier --write .github/workflows/ci.yml libs/database/README.md docs/DEVELOPMENT.md docs/RELEASING.md docs/DOCKER.md && bun run check`
      Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
ci(ci,identity,billing): run drizzle-kit check on every postgres domain

bun run db:check runs drizzle-kit check in every domain with a drizzle.config.ts. It fails on a
forked snapshot chain, the failure parallel lanes produce when two branches generate migrations
in one domain. Closes E-6.
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add package.json domains/identity/package.json domains/billing/package.json .github/workflows/ci.yml \
  scripts/check-drizzle-history.spec.ts libs/database/README.md docs/DEVELOPMENT.md docs/RELEASING.md \
  docs/DOCKER.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 2: Libs specs and fixtures name no domain (was Task 7)

Covers B1FU-9. Spec §1 says "`libs/` names no domain", and the boundary check enforces it only for imports. At `9600510` the guard below finds 120 lines in 29 files outside `libs/auth/` (the review ran it; the inventory's "132 lines in 34 files" counted `libs/auth` and files B1's final fixes already cleaned). The biggest are:

- `libs/database/src/migrator/run-migrations.spec.ts` (18 lines)
- `libs/database/src/migrator/migration-sets.spec.ts` (13)
- `libs/transport/src/grpc/grpc-call.spec.ts` (10)
- `libs/transport/test/fixtures/fixture.events.ts` and its users `parse-event-envelope.pipe.spec.ts`, `kafka-producer.service.spec.ts`, `kafka-dead-letter.filter.spec.ts` (`FIXTURE_PAYMENT_SUCCEEDED_EVENT`, `paymentId`, `fixture.payment-succeeded.v1`)
- `libs/cassandra/src/cassandra.module.spec.ts`, `paging/execute-page.spec.ts` (`notifications_by_user`)
- `libs/graphql/src/pubsub/pubsub.module.spec.ts`, `errors/format-graphql-error.spec.ts` (`notificationCreated`)

A plain `rg -w` finds only 93 of them, because it treats `_` and camelCase humps as part of a word. The guard splits camelCase and treats `_`, `-` and `.` as boundaries. `orders` is NOT a finding: it is the repo's neutral example vocabulary (the boundary-check fixtures, `docs/RELEASING.md` `orders.v2`). `libs/auth/` is exempt for now. B2-18, B2-20 and B2-22 rewrite `libs/auth/src/rbac` and the guards, and B2-20 deletes the exemption.

**Files:**

- Create: `scripts/libs-vocabulary.spec.ts`
- Modify: every file the guard lists in Step 2: 29 files, all under `libs/` and outside `libs/auth/` (`libs/storage/` has none). At `9600510` they are the files of `rg -l -i 'identity|billing|notification|payment|stripe|checkout|@domain/files' libs -g '*.spec.ts' -g '*.int-spec.ts' -g '**/test/**' -g '**/testing/**' -g '!libs/auth/**'`
- Test: `scripts/libs-vocabulary.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `scripts/libs-vocabulary.spec.ts` with `EXEMPT_PREFIXES = ['libs/auth/']` and the line marker `vocabulary-allow`. Renamed fixture exports in `libs/transport/test/fixtures/fixture.events.ts`: `fixtureOrderPlacedPayload` (fields `orderId`, `userId`, `amountTotal`, `currency`, `placedAt`), `type FixtureOrderPlacedPayload` and `FIXTURE_ORDER_PLACED_EVENT` (topic `fixture.order-placed.v1`). They replace `fixturePaymentSucceededPayload` (`paymentId`, `paidAt`), `FixturePaymentSucceededPayload`, `FIXTURE_PAYMENT_SUCCEEDED_EVENT` and `fixture.payment-succeeded.v1`. B2, C and G lanes that touch `libs/**` specs must use the new names and the neutral vocabulary (see "Overlaps with the other lanes' plans").

**Wave:** after Task 1 (lane `e-ci`). Must be merged into `feat/domains-tenancy` before B2 executes: right after this commit the controller merges `e/ci-tooling` (Global Constraints, "Early merge"). B2-23/B2-24 then edit `libs/transport` specs on top of it.

- [ ] **Step 1: Write the failing guard** `scripts/libs-vocabulary.spec.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const LIBS = join(ROOT, 'libs');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
/** Spec files, and everything under a test/ or testing/ folder (fixtures, doubles). */
const TEST_FILE = /(?:^|\/)(?:test|testing)\/.+\.ts$|\.(?:spec|int-spec|e2e-spec)\.ts$/;

/** Rewritten by phase B2 (B2-18, B2-20, B2-22). B2-20 deletes this entry with the Permission enum. */
const EXEMPT_PREFIXES: readonly string[] = ['libs/auth/'];
/** A line may name a domain only to assert that libs do NOT contain it. */
const ALLOW_MARKER = 'vocabulary-allow';

/**
 * Words that name a business domain of this repo: every domains/<x> folder name (`files` is plain
 * English, so only its package spellings count) plus billing's vocabulary. Specs use the neutral
 * example vocabulary instead: orders, catalog, alerts, shipments.
 */
const DOMAIN_WORDS: readonly string[] = [
  ...readdirSync(join(ROOT, 'domains'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'files')
    .map((entry) => entry.name),
  'notification',
  'payment',
  'payments',
  'stripe',
  'checkout',
  'files-service',
  '@domain/files',
];
const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** A domain word between non-alphanumerics: `_`, `-`, `.` and camelCase humps are boundaries. */
const DOMAIN_WORD = new RegExp(
  `(?<![a-z0-9])(?:${DOMAIN_WORDS.map(escapeRegExp).join('|')})(?![a-z0-9])`,
  'i',
);
/** `paymentId` → `payment Id`, `FixturePaymentSucceeded` → `Fixture Payment Succeeded`. */
const splitCamelCase = (line: string): string => line.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const namesDomain = (line: string): boolean => DOMAIN_WORD.test(splitCamelCase(line));

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(path);
    else if (TEST_FILE.test(relative(ROOT, path).split(sep).join('/'))) yield path;
  }
}

describe('libs vocabulary: libs/ names no domain, specs and fixtures included', () => {
  it('derives the domain words from domains/*', () => {
    expect(DOMAIN_WORDS).toEqual(expect.arrayContaining(['billing', 'identity', 'notifications']));
  });

  it('flags domain words, also inside identifiers, and leaves the neutral vocabulary alone', () => {
    expect(namesDomain("SERVICE_NAME: 'identity-service'")).toBe(true);
    expect(namesDomain("'billing:checkout'")).toBe(true);
    expect(namesDomain("defineEventContract('fixture.payment-succeeded.v1', x)")).toBe(true);
    expect(namesDomain('FIXTURE_PAYMENT_SUCCEEDED_EVENT')).toBe(true);
    expect(namesDomain('const payload = { paymentId: generateId() };')).toBe(true);
    expect(namesDomain('fixturePaymentSucceededPayload')).toBe(true);
    expect(namesDomain('SELECT id FROM notifications_by_user')).toBe(true);
    expect(namesDomain("SERVICE_NAME: 'orders-service'")).toBe(false);
    expect(namesDomain('const shipmentId = orderPlaced.id;')).toBe(false);
    expect(namesDomain('copies the migration files')).toBe(false);
  });

  it('finds no domain word outside the exempt paths', () => {
    const files = [...testFiles(LIBS)];
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of files) {
      const path = relative(ROOT, file).split(sep).join('/');
      if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!line.includes(ALLOW_MARKER) && namesDomain(line)) {
            hits.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/libs-vocabulary.spec.ts`
      Expected: FAIL. The third test prints the `hits` array as a diff: 120 entries `"libs/<pkg>/…:<line>: <text>"` in 29 files at `9600510` (transport 40, database 35, common 14, cassandra 12, graphql 10, config 6, redis 3, counted by the review). Save the work list for Step 3: `npx vitest run --project scripts scripts/libs-vocabulary.spec.ts 2>&1 | rg -o 'libs/[^"]+?:[0-9]+:' | sort -u > "$TMPDIR/vocabulary-hits.txt"` (the diff lines start with `+`, so match the path, not the line start).

- [ ] **Step 3: Rewrite every hit** with this mapping. Use the first column's spelling exactly, and keep the case of the original (`Identity` → `Orders`).

| Domain word in libs specs                                                                          | Neutral replacement                                                                 |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `identity-service`, `billing-service`, `notifications-service`                                     | `orders-service`, `catalog-service`, `alerts-service`                               |
| `identity` (schema, migration set, gRPC package, context)                                          | `orders`                                                                            |
| `billing`                                                                                          | `catalog`                                                                           |
| `notifications` / `notification`                                                                   | `alerts` / `alert`                                                                  |
| `payments` / `payment`                                                                             | `shipments` / `shipment`                                                            |
| `stripe` (provider name)                                                                           | `acmepay`                                                                           |
| `checkout`                                                                                         | `dispatch`                                                                          |
| `billing.payment-succeeded.v1`                                                                     | `catalog.shipment-dispatched.v1`                                                    |
| `fixture.payment-succeeded.v1`, `fixturePaymentSucceededPayload`, `FixturePaymentSucceededPayload` | `fixture.order-placed.v1`, `fixtureOrderPlacedPayload`, `FixtureOrderPlacedPayload` |
| `FIXTURE_PAYMENT_SUCCEEDED_EVENT`; payload fields `paymentId`, `paidAt`                            | `FIXTURE_ORDER_PLACED_EVENT`; `orderId`, `placedAt`                                 |
| `notifications_by_user`, `001_create_notifications`, `notificationCreated`                         | `alerts_by_user`, `001_create_alerts`, `alertCreated`                               |
| `STRIPE_ERROR` (an error code)                                                                     | `ACMEPAY_ERROR`                                                                     |
| `@domain/files` in a test title                                                                    | reword without the package, e.g. `(a domain namespace owns them)`                   |

Rules:

- When the replacement already appears in the same file with another meaning (for example a spec that already uses `orders` next to `identity`), use the second choice: `identity` → `inventory`, `billing` → `pricing`, `notifications` → `messages`. Never use `ledger`, `tenants` or `memberships`: those are upcoming domain and table names.
- A line that names a domain on purpose, to assert that it stays out of `libs`, keeps the word and gets a trailing comment `// vocabulary-allow: asserts libs hold no <domain> code`. Example: `libs/config/src/namespaces/namespaces.spec.ts:25`, `expect(CONFIG_NAMESPACES).not.toHaveProperty('stripe');`. In the test title on the line above, change `(stripe belongs to @domain/billing)` to `(domains register their own)`.
- Comments count too. Rewrite them in the same vocabulary, for example `libs/graphql/src/plugins/complexity.plugin.spec.ts:105` "identity's `users`" → "a domain's `users`".
- Identifiers count too: the guard splits camelCase and treats `_` as a boundary, so rename the whole identifier and keep its case style (`STRIPE_ERROR` → `ACMEPAY_ERROR`, `notificationCreated` → `alertCreated`), and rename every use in the same commit. The most specific row of the mapping wins: the fixture rows (`paymentId` → `orderId`) over the generic `payment` row. `libs/common/src/constants/headers.constants.spec.ts:6` (`not.toHaveProperty('STRIPE_SIGNATURE')`) is an absence assertion: keep it and add the `vocabulary-allow` comment.
- Only spec text changes. If a hit is in non-test source under `libs/` (the guard reads only spec, `test/` and `testing/` files, so none should appear), stop and report it.
- In `libs/transport/test/fixtures/fixture.events.ts`, rename the payload schema, its type, the event constant, the topic and the fields `paymentId` → `orderId`, `paidAt` → `placedAt` as in the table. Update every use: `libs/transport/src/kafka/kafka-dead-letter.filter.spec.ts:122,128` (`fixture.order-placed.v1` and `fixture.order-placed.v1.dlq`), `parse-event-envelope.pipe.spec.ts:5,13,19,23,38,54` and `kafka-producer.service.spec.ts:8,227`. `rg -n -i 'payment.?succeeded|paymentId|paidAt' libs` must print nothing afterwards.

- [ ] **Step 4: Run the guard and the touched projects.**
  - `npx vitest run --project scripts scripts/libs-vocabulary.spec.ts`. Expected: PASS (3 tests). The first two already pass in Step 2.
  - `npx vitest run libs` (sandbox off: some lib specs bind loopback ports). Expected: PASS with the same test count as before Step 3. Renaming literals must not change behaviour. If an expectation compared a renamed literal with a value produced elsewhere, both sides must have changed.

- [ ] **Step 5: Checks.** `npx biome check --write scripts/libs-vocabulary.spec.ts $(git diff --name-only -- libs) && bun run check`
      Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
test(repo): use neutral vocabulary in libs specs and guard it

libs specs and fixtures now use orders/catalog/alerts/shipments. scripts/libs-vocabulary.spec.ts
fails on a domain word, also inside identifiers (libs/auth is exempt until B2-20). Closes B1FU-9.
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add scripts/libs-vocabulary.spec.ts libs
git commit -S -F "$TMPDIR/e-msg.txt"
```

`git add libs` stages only files this task modified. Check `git status --short libs` first: it must list only spec and fixture files.

### Task 3: Vitest hygiene (silent Nest logger, unit timeouts) (was Task 1)

Covers B1FU-10 and B1FU-11. Both edit `vitest.config.ts`, so they form one task.

**Files:**

- Create: `vitest.setup.ts`, `scripts/vitest-config.spec.ts`
- Modify: `vitest.config.ts:39-46` (`unitProject`), `:73-79` (`scriptsProject`), `:119-121` (`setupFiles`); `docs/TESTING.md` (the `<name>` row of the "Vitest projects" table at `:46`, and a new section before `## Integration tests (testcontainers)`)
- Test: `scripts/vitest-config.spec.ts`

**Interfaces:**

- Consumes: `Logger` from `@nestjs/common` 12.1.2: `Logger.overrideLogger(false)` drops the static instance, so `new Logger(ctx).log()` prints nothing, while spies on `Logger.prototype.*` still run. `TestingLogger` from `@nestjs/testing` 12.1.2 (`services/testing-logger.service.js`, reachable through the package's `"./*.js"` export, not re-exported by its index): `Test.createTestingModule().compile()` calls `Logger.overrideLogger(new TestingLogger())` (`testing-module.builder.js:127-129`), and that logger drops log/warn/debug/verbose but still prints `error` with its stack. Dropping only the static logger therefore leaves every testing-module spec printing errors.
- Produces:
  ```ts
  // vitest.setup.ts
  export type NestTestLogging = 'silent' | 'verbose';
  export function configureNestTestLogging(env?: NodeJS.ProcessEnv): NestTestLogging; // silent: also TestingLogger.prototype.error = no-op
  // vitest.config.ts
  export const UNIT_TEST_TIMEOUT_MS: 15_000;
  export const UNIT_HOOK_TIMEOUT_MS: 30_000;
  export const SETUP_FILES: string[]; // ['reflect-metadata', '<repo>/vitest.setup.ts']
  export const unitProject: (pkg: WorkspacePackage) => TestProjectInlineConfiguration;
  export const scriptsProject: TestProjectInlineConfiguration;
  ```

**Wave:** after Task 2 (lane `e-ci`).

- [ ] **Step 1: Write the failing spec** `scripts/vitest-config.spec.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SETUP_FILES,
  scriptsProject,
  UNIT_HOOK_TIMEOUT_MS,
  UNIT_TEST_TIMEOUT_MS,
  unitProject,
} from '../vitest.config.js';
import { configureNestTestLogging } from '../vitest.setup.js';

const ROOT = join(import.meta.dirname, '..');

describe('vitest.config.ts', () => {
  it('gives unit projects room for in-process Nest boots (B1FU-11)', () => {
    expect(UNIT_TEST_TIMEOUT_MS).toBe(15_000);
    expect(UNIT_HOOK_TIMEOUT_MS).toBe(30_000);
    const project = unitProject({ name: 'probe', root: join(ROOT, 'libs', 'common') });
    expect(project.test).toMatchObject({
      name: 'probe',
      testTimeout: UNIT_TEST_TIMEOUT_MS,
      hookTimeout: UNIT_HOOK_TIMEOUT_MS,
    });
  });

  it('gives the scripts project the same timeouts (its specs spawn buf, drizzle-kit, git)', () => {
    expect(scriptsProject.test).toMatchObject({
      name: 'scripts',
      testTimeout: UNIT_TEST_TIMEOUT_MS,
      hookTimeout: UNIT_HOOK_TIMEOUT_MS,
    });
  });

  it('loads reflect-metadata first, then the repo setup file by absolute path', () => {
    expect(SETUP_FILES).toEqual(['reflect-metadata', join(ROOT, 'vitest.setup.ts')]);
    expect(existsSync(SETUP_FILES[1] ?? '')).toBe(true);
  });
});

describe('vitest.setup.ts (B1FU-10)', () => {
  afterEach(() => {
    // Leave the worker as every other spec sees it: silent.
    configureNestTestLogging({});
  });

  it('silences the Nest logger by default', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(configureNestTestLogging({})).toBe('silent');
    new Logger('Probe').log('must not print');
    new Logger('Probe').error('must not print either', 'stack');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stays silent after Test.createTestingModule() installs its TestingLogger', async () => {
    configureNestTestLogging({});
    const moduleRef = await Test.createTestingModule({}).compile();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    new Logger('Probe').error('must not print', 'stack');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('keeps the logger untouched with TEST_LOGS=1', () => {
    const override = vi.spyOn(Logger, 'overrideLogger');
    expect(configureNestTestLogging({ TEST_LOGS: '1' })).toBe('verbose');
    expect(override).not.toHaveBeenCalled();
  });

  it('still lets specs spy on Logger.prototype', () => {
    configureNestTestLogging({});
    const warn = vi.spyOn(Logger.prototype, 'warn');
    new Logger('Probe').warn('observed, not printed');
    expect(warn).toHaveBeenCalledWith('observed, not printed');
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/vitest-config.spec.ts`
      Expected: FAIL. The import of `../vitest.setup.js` cannot be resolved, and `vitest.config.ts` has no export named `UNIT_TEST_TIMEOUT_MS`.

- [ ] **Step 3: Create `vitest.setup.ts`** at the repo root. `@nestjs/common` and `@nestjs/testing` resolve from the hoisted root `node_modules` (they are not root devDependencies; Biome's root `*.ts` override allows that):

```ts
/**
 * Setup file of every Vitest project, loaded after `reflect-metadata` (see SETUP_FILES in
 * vitest.config.ts). Specs that exercise failure paths make Nest log WARN/ERROR lines with stack
 * traces; silencing Nest keeps the test output readable. Specs that assert on logging spy on
 * `Logger.prototype` methods, which still run. Set TEST_LOGS=1 to print the logs.
 */
import { Logger } from '@nestjs/common';
// Not re-exported by the package index; its "./*.js" export maps this path.
import { TestingLogger } from '@nestjs/testing/services/testing-logger.service.js';

export type NestTestLogging = 'silent' | 'verbose';

export function configureNestTestLogging(env: NodeJS.ProcessEnv = process.env): NestTestLogging {
  if (env.TEST_LOGS === '1') return 'verbose';
  // `new Logger(ctx)` delegates to the static logger: without one, nothing prints.
  Logger.overrideLogger(false);
  // `Test.createTestingModule().compile()` installs a TestingLogger, which still prints errors.
  TestingLogger.prototype.error = () => undefined;
  return 'silent';
}

configureNestTestLogging();
```

- [ ] **Step 4: Edit `vitest.config.ts`.**
  - After `const INTEGRATION = process.env.INTEGRATION === '1';` add:
    ```ts
    /**
     * Unit (and scripts) specs compile Nest modules and run gRPC round trips in-process; under a
     * parallel full run Vitest's 5 s / 10 s defaults flake. e2e and int projects keep their own.
     */
    export const UNIT_TEST_TIMEOUT_MS = 15_000;
    export const UNIT_HOOK_TIMEOUT_MS = 30_000;

    /** reflect-metadata first (decorator metadata), then the repo setup (silent Nest logger). */
    export const SETUP_FILES = ['reflect-metadata', join(ROOT, 'vitest.setup.ts')];
    ```
  - Replace `const unitProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({` with `export const unitProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({`. In its `test` object, replace `include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],` with:
    ```ts
        include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
        testTimeout: UNIT_TEST_TIMEOUT_MS,
        hookTimeout: UNIT_HOOK_TIMEOUT_MS,
    ```
  - Replace the `scriptsProject` declaration:
    ```ts
    const scriptsProject: TestProjectInlineConfiguration = {
      extends: true,
      test: { name: 'scripts', root: join(ROOT, 'scripts'), include: ['**/*.spec.ts'] },
    };
    ```
    with:
    ```ts
    export const scriptsProject: TestProjectInlineConfiguration = {
      extends: true,
      test: {
        name: 'scripts',
        root: join(ROOT, 'scripts'),
        include: ['**/*.spec.ts'],
        testTimeout: UNIT_TEST_TIMEOUT_MS,
        hookTimeout: UNIT_HOOK_TIMEOUT_MS,
      },
    };
    ```
  - Replace `    setupFiles: ['reflect-metadata'],` with `    setupFiles: SETUP_FILES,`.

- [ ] **Step 5: Run the spec.** `npx vitest run --project scripts scripts/vitest-config.spec.ts`
      Expected: PASS (7 tests). Without the `TestingLogger` line of Step 3, "stays silent after Test.createTestingModule()" fails (checked in review).

- [ ] **Step 6: Measure the noise (sandbox off).** Run `npx vitest run --project '!*:e2e' --reporter=dot 2>&1 | rg -c '\[Nest\]'`.
      Expected: no output (`rg -c` prints nothing for zero matches). It was 38 at `9600510`. The review measured 0 with this setup file, and the same failing files as before under the sandbox (the loopback `listen` specs). A match means a spec builds its own `ConsoleLogger` instance or passes `logger: new ConsoleLogger()`. Leave such specs alone and list them in the commit body. Then run `bun run test`. Expected: PASS, with the same file and test counts as before the change, plus this task's 7 tests.

- [ ] **Step 7: Docs.** In `docs/TESTING.md`, "Vitest projects" table, row `` `<name>` ``: replace the last cell `Vitest defaults` with `15 s / 30 s`. Prettier re-pads the table. Then insert before `## Integration tests (testcontainers)`:

```markdown
## Test output and timeouts

`vitest.setup.ts` is loaded by every project after `reflect-metadata`. It drops Nest's static logger
and mutes the errors of the `TestingLogger` that `Test.createTestingModule().compile()` installs, so
specs that exercise failure paths print no `[Nest]` lines or stack traces. To see them while
debugging, set `TEST_LOGS=1` (for example `TEST_LOGS=1 npx vitest run --project billing`). Specs
that assert on logging spy on `Logger.prototype` methods, which still run, or pass their own logger
with `Test.createTestingModule(…).setLogger(…)`.

Unit and `scripts` projects allow 15 s per test and 30 s per hook (`UNIT_TEST_TIMEOUT_MS`,
`UNIT_HOOK_TIMEOUT_MS` in `vitest.config.ts`), because they compile Nest modules and run gRPC round
trips in-process. e2e projects keep 30 s / 60 s and integration projects 120 s / 180 s.
```

If `rg -n 'Vitest defaults|default timeouts|5 s / 10 s|5000' docs/TESTING.md` still finds a sentence that describes the old unit timeouts, update it to the new values.

- [ ] **Step 8: Checks.** `npx biome check --write vitest.config.ts vitest.setup.ts scripts/vitest-config.spec.ts && npx prettier --write docs/TESTING.md && bun run check`
      Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
test(tooling): silence the nest logger in specs and raise unit timeouts

vitest.setup.ts drops Nest's static logger and mutes TestingLogger errors unless TEST_LOGS=1
(38 [Nest] lines per unit run at 9600510, 0 after). Unit and scripts projects get 15 s / 30 s
timeouts. Closes B1FU-10 and B1FU-11.
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add vitest.setup.ts vitest.config.ts scripts/vitest-config.spec.ts docs/TESTING.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 4: check-env-example covers apps, every lib and the compose knobs (was Task 2)

Covers AUDIT-F35 and B1FU-8. Today the script reads only `libs/config/src/namespaces` and `domains/**/src/**/*.config.ts` (`scripts/check-env-example.mjs:3-5,48-81`). The app namespaces (`apps/gateway/src/gateway.config.ts`, `apps/monolith/src/monolith.config.ts`) are not scanned, and neither is any future `libs/<store>/src/*.config.ts`. Nothing checks the compose-only section (`.env.example:285` onwards) against `docker-compose.yml`. At `9600510` the compose side is clean: all 57 `${VAR}` names are documented, and the only compose-section key not interpolated is `COMPOSE_PROFILES`, which compose reads itself. So the stricter script passes unchanged.

**Files:**

- Modify: `scripts/check-env-example.mjs` (full rewrite below)
- Create: `scripts/check-env-example.spec.ts`
- Modify: `docs/CONFIGURATION.md:645` (the `check-env-example` row), `docs/DEVELOPMENT.md:286` (the "Document every variable" bullet)
- Test: `scripts/check-env-example.spec.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `node scripts/check-env-example.mjs [--root <dir>] [--list]`. Exit 0 prints two lines:
  `.env.example documents all <n> config variables (<p> from libs/config, <o> from domains, apps and other libs)`
  `.env.example documents all <c> docker compose variables (<files>)`. With no compose file in the root (fixtures), the second line is omitted.

**Wave:** after Task 3 (lane `e-ci`).

- [ ] **Step 1: Write the failing spec** `scripts/check-env-example.spec.ts`:

```ts
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose `${VAR}` interpolation is the test data.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'check-env-example.mjs');
const MARKER = '# docker compose ONLY (interpolation in docker-compose.yml; ignored by the apps)';

type Tree = Record<string, string>;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(tree: Tree): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-env-example-'));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const namespace = (keys: string[]): string =>
  `export const schema = z.object({\n${keys.map((k) => `  ${k}: zStr('x'),`).join('\n')}\n});\n`;

/** A tree that passes: one platform namespace, its variable documented, an empty compose section. */
const BASE: Tree = {
  'libs/config/src/namespaces/app.config.ts': namespace(['PORT']),
  '.env.example': `PORT=3000\n${MARKER}\n`,
};

describe('check-env-example', () => {
  it('passes when every namespace variable is documented', () => {
    const result = check(BASE);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('.env.example documents all 1 config variables');
  });

  it('reads app namespaces (apps/*/src/**/*.config.ts)', () => {
    const result = check({ ...BASE, 'apps/api/src/api.config.ts': namespace(['API_PAGE_SIZE']) });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'missing from .env.example: API_PAGE_SIZE (apps/api/src/api.config.ts)',
    );
  });

  it('reads namespaces of libs outside libs/config (a store adapter such as libs/ledger)', () => {
    const result = check({
      ...BASE,
      'libs/ledger/src/ledger.config.ts': namespace(['LEDGER_URL']),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'missing from .env.example: LEDGER_URL (libs/ledger/src/ledger.config.ts)',
    );
  });

  it('ignores *.config.ts outside src/ (drizzle.config.ts, vitest.config.ts)', () => {
    const result = check({
      ...BASE,
      'domains/orders/drizzle.config.ts': namespace(['IGNORED_ONE']),
      'apps/api/vitest.config.ts': namespace(['IGNORED_TWO']),
    });
    expect(result.status, result.output).toBe(0);
  });

  it('fails on a compose variable that .env.example does not document', () => {
    const result = check({
      ...BASE,
      'docker-compose.yml':
        'services:\n  ledger:\n    ports: ["127.0.0.1:${LEDGER_HOST_PORT:-3322}:3322"]\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'docker-compose.yml interpolates LEDGER_HOST_PORT, which .env.example does not document',
    );
  });

  it('fails on a compose-section variable that no compose file interpolates', () => {
    const result = check({
      ...BASE,
      '.env.example': `PORT=3000\n${MARKER}\n# OLD_HOST_PORT=1\n`,
      'docker-compose.yml': 'services: {}\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      '.env.example compose section lists OLD_HOST_PORT, which no compose file interpolates',
    );
  });

  it('accepts compose built-ins, $$ escapes, comment lines and app-section documentation', () => {
    const result = check({
      ...BASE,
      '.env.example': `PORT=3000\nSTRIPE_KEY=\n${MARKER}\n# COMPOSE_PROFILES=\n# TAG=local\n`,
      'libs/config/src/namespaces/app.config.ts': namespace(['PORT', 'STRIPE_KEY']),
      'docker-compose.yml': [
        'services:',
        '  api:',
        '    image: boilerplate/api:${TAG:-local}',
        '    environment:',
        '      STRIPE_KEY: ${STRIPE_KEY:-sk_test_local}',
        '    # set ${NOT_A_KNOB} in a comment: ignored',
        '    healthcheck:',
        '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]',
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('.env.example documents all 2 docker compose variables');
  });

  it('reads every root compose file (docker-compose.citus.yml too)', () => {
    const result = check({
      ...BASE,
      'docker-compose.yml': 'services: {}\n',
      'docker-compose.citus.yml': 'services:\n  pgbouncer:\n    image: x:${PGBOUNCER_TAG}\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain('docker-compose.citus.yml interpolates PGBOUNCER_TAG');
  });

  it('passes on this repository', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    // Other lanes may add root compose files: only require that docker-compose.yml is among them.
    expect(result.stdout).toMatch(/docker compose variables \([^)]*docker-compose\.yml/);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/check-env-example.spec.ts`
      Expected: FAIL, 7 of 9 (checked in review against the current script): "reads app namespaces", "reads namespaces of libs outside libs/config", both compose failure cases, "accepts compose built-ins …", "reads every root compose file" and "passes on this repository". "passes when every namespace variable is documented" and "ignores *.config.ts outside src/" already pass.

- [ ] **Step 3: Replace `scripts/check-env-example.mjs`** with:

```js
// Fails when the root .env.example drifts from what reads it.
//  1. Config: every env var a config namespace schema reads must be documented above the
//     compose-only section (as `KEY=` or `# KEY=`), and nothing unknown may be listed there.
//     Namespaces are libs/config/src/namespaces/*.config.ts (read first), then every *.config.ts
//     under a src/ folder of libs/*, domains/* (contracts packages included) and apps/*. Files
//     outside src/ (domains/<x>/drizzle.config.ts, vitest.config.ts) are not namespaces.
//  2. Compose: every variable a root compose file (docker-compose*.yml, compose*.yaml)
//     interpolates (`${VAR}`, `${VAR:-x}`, `$VAR`; `$$` is a literal `$`; comment lines are
//     skipped) must be documented somewhere in .env.example, and every variable of the
//     compose-only section must be interpolated by a compose file or be one compose reads itself.
// Reads the SOURCES (no build needed):
//   node scripts/check-env-example.mjs [--root <dir>] [--list]
// --list prints every config variable with the file that declares it (platform files first; the
// first file that declares a variable owns it). --root checks another tree (fixtures).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { root: { type: 'string' }, list: { type: 'boolean', default: false } },
});
const root = args.root ?? join(import.meta.dirname, '..');
const namespacesDir = join(root, 'libs', 'config', 'src', 'namespaces');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
// Variables read by Node or the OTel SDK themselves, documented next to the config ones.
const RUNTIME_VARS = new Set([
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'UV_THREADPOOL_SIZE',
  'NODE_OPTIONS',
]);
// Read by docker compose itself (not interpolated), documented in the compose-only section.
const COMPOSE_BUILTINS = new Set(['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE']);
const COMPOSE_SECTION = /^# docker compose ONLY/m;
const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/;
const COMPOSE_VAR = /(?<!\$)\$(?:\{([A-Z][A-Z0-9_]*)|([A-Z][A-Z0-9_]*))/g;
const DOCUMENTED = /^#?\s*([A-Z][A-Z0-9_]*)=/gm;

/** Body of every `z.object({ ... })` literal (brace-balanced: values contain `{ min: 1 }` etc.). */
function objectBodies(source) {
  const bodies = [];
  for (const match of source.matchAll(/z\s*\.object\(\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    bodies.push(source.slice(start, i - 1));
  }
  return bodies;
}

const byName = (a, b) => (a.name < b.name ? -1 : 1);

/** Every `*.config.ts` below a `src/` folder under `dir` (<pkg>/src, domains/<x>/contracts/src). */
function* configFiles(dir, inSrc = false) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* configFiles(path, inSrc || entry.name === 'src');
    else if (inSrc && entry.name.endsWith('.config.ts')) yield path;
  }
}

/** Top-level keys of the namespace schemas (env var names are UPPER_CASE) → declaring file. */
const configVars = new Map();
const readFiles = new Set();
function collect(file) {
  if (readFiles.has(file)) return;
  readFiles.add(file);
  for (const body of objectBodies(readFileSync(file, 'utf8'))) {
    for (const [, key] of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
      if (!configVars.has(key)) configVars.set(key, relative(root, file));
    }
  }
}
for (const file of readdirSync(namespacesDir)
  .filter((f) => f.endsWith('.config.ts'))
  .sort()) {
  collect(join(namespacesDir, file));
}
const platformCount = configVars.size;
if (platformCount === 0) {
  console.error(`no env vars found under ${namespacesDir}: did the schema layout change?`);
  process.exit(1);
}
for (const dir of ['libs', 'domains', 'apps']) {
  for (const file of configFiles(join(root, dir))) collect(file);
}
if (args.list) {
  for (const [key, file] of [...configVars].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.info(`${key}\t${file}`);
  }
}

const example = readFileSync(join(root, '.env.example'), 'utf8');
const [appSection = '', composeSection = ''] = example.split(COMPOSE_SECTION);
const documentedIn = (text) => new Set([...text.matchAll(DOCUMENTED)].map(([, key]) => key));
const documented = documentedIn(appSection);
const documentedAnywhere = documentedIn(example);
const errors = [];

for (const [key, file] of configVars) {
  if (!documented.has(key)) errors.push(`missing from .env.example: ${key} (${file})`);
}
for (const key of documented) {
  if (!configVars.has(key) && !RUNTIME_VARS.has(key)) {
    errors.push(`.env.example lists ${key}, which no config namespace (libs, domains, apps) reads`);
  }
}

/** Root compose files and the variables each interpolates (comment lines skipped). */
const composeFiles = readdirSync(root)
  .filter((name) => COMPOSE_FILE.test(name))
  .sort();
const composeVars = new Set();
for (const name of composeFiles) {
  const lines = readFileSync(join(root, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  for (const [, braced, bare] of lines.join('\n').matchAll(COMPOSE_VAR)) {
    const key = braced ?? bare;
    if (composeVars.has(key)) continue;
    composeVars.add(key);
    if (!documentedAnywhere.has(key)) {
      errors.push(`${name} interpolates ${key}, which .env.example does not document`);
    }
  }
}
if (composeFiles.length > 0) {
  for (const key of documentedIn(composeSection)) {
    if (!composeVars.has(key) && !COMPOSE_BUILTINS.has(key)) {
      errors.push(`.env.example compose section lists ${key}, which no compose file interpolates`);
    }
  }
}

for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.info(
  `.env.example documents all ${configVars.size} config variables (${platformCount} from libs/config, ${configVars.size - platformCount} from domains, apps and other libs)`,
);
if (composeFiles.length > 0) {
  console.info(
    `.env.example documents all ${composeVars.size} docker compose variables (${composeFiles.join(', ')})`,
  );
}
```

- [ ] **Step 4: Run the spec.** `npx vitest run --project scripts scripts/check-env-example.spec.ts`
      Expected: PASS (9 tests).

- [ ] **Step 5: Run it on the repo.** `node scripts/check-env-example.mjs`
      Expected, exit 0:
      `.env.example documents all 138 config variables (121 from libs/config, 17 from domains, apps and other libs)`
      `.env.example documents all 57 docker compose variables (docker-compose.yml)`
      The app namespaces add no variable: `KAFKA_GROUP_ID` is owned by the platform `kafka` namespace, which is read first. (The review ran this script on `9600510` and got exactly these two lines. If another lane has merged since, the counts are higher and the file list may name more compose files.)

- [ ] **Step 6: Docs.**
  - `docs/CONFIGURATION.md`: in the "Keeping .env.example in sync" table, the row that starts with ``| `node scripts/check-env-example.mjs` (`--list`: every variable and the file that declares it) |`` has a second cell beginning `Every variable a schema in`. Replace that second cell's text with: `Every variable a schema in libs/config/src/namespaces or any other *.config.ts under a src/ folder of libs/*, domains/* and apps/* reads is documented above the compose-only section, and nothing unknown is listed there. Every ${VAR} a root compose file interpolates is documented, and every compose-section variable is interpolated (or is COMPOSE_PROFILES, COMPOSE_PROJECT_NAME or COMPOSE_FILE).` Wrap the paths and variable names in backticks as the table does.
  - `docs/DEVELOPMENT.md:286`: in the bullet that begins ``- Document every variable in the root `.env.example`.``, replace the sentence that begins `` `node scripts/check-env-example.mjs` reads `` with: `` `node scripts/check-env-example.mjs` reads every `*.config.ts` under a `src/` folder of `libs/*`, `domains/*` and `apps/*`, and every `${VAR}` of the root compose files. ``
  - `rg -n 'check-env-example' docs README.md` and fix any other sentence that still says only `libs/config` and `domains` are read (`docs/DEVELOPMENT.md:56`, `:530` and `docs/SECURITY.md:297` are the candidates).

- [ ] **Step 7: Checks.** `npx biome check --write scripts/check-env-example.mjs scripts/check-env-example.spec.ts && npx prettier --write docs/CONFIGURATION.md docs/DEVELOPMENT.md docs/SECURITY.md && bun run check`
      Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
build(tooling): check app, lib and compose variables against .env.example

Scan every *.config.ts under src/ of libs, domains and apps, and cross-check the ${VAR} names of
the root compose files with .env.example both ways. Closes AUDIT-F35 and B1FU-8.
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add scripts/check-env-example.mjs scripts/check-env-example.spec.ts docs/CONFIGURATION.md \
  docs/DEVELOPMENT.md docs/SECURITY.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 5: `buf breaking` gate for pull requests (was Task 4)

Covers E-5, merging AUDIT-F21 and F31. Each `domains/<x>/contracts/README.md` documents a manual `buf breaking` against `.git#branch=master`, and `docs/RELEASING.md:137,167` says CI does not run it. I verified the approach on 2026-11-09. Extract the base ref's `domains/<x>/contracts/src/proto` with `git archive`, then run buf from the package folder:
`buf breaking --config ../../../libs/contracts/buf.yaml --against <tmp>/domains/<x>/contracts --against-config <repo>/libs/contracts/buf.yaml`
It exits 0 when nothing changed. After deleting `customer_email = 2` it exits 100 with `Previously present field "2" with name "customer_email" on message "CreateCheckoutSessionRequest" was deleted.` This avoids buf's own git input, which needs a branch name and enough clone depth.

**Files:**

- Create: `scripts/check-proto-breaking.mjs`, `scripts/check-proto-breaking.spec.ts`
- Modify: root `package.json` (`scripts.proto:breaking`), `.github/workflows/ci.yml` (`verify` job)
- Modify (docs): `domains/billing/contracts/README.md:34-41`, `domains/identity/contracts/README.md` (the same block), `domains/notifications/contracts/README.md` (the same block), `docs/RELEASING.md:137`, `:149`, `:167`, `docs/DOCKER.md:436` (`## CI`, **verify** bullet)
- Test: `scripts/check-proto-breaking.spec.ts`

**Interfaces:**

- Consumes: `node_modules/.bin/buf` (1.73.0), `libs/contracts/buf.yaml` (`breaking.use: [FILE]`), `git archive`, `tar`.
- Produces: `node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>] [--buf <path>] [--error-format <text|github-actions|json>]`. Exit 0 means no breaking change in any package. Exit 1 means a breaking change or an error. Exit 2 means a usage error. One output line per package: `ok   domains/<x>/contracts: …`, `skip domains/<x>/contracts: …` or `FAIL domains/<x>/contracts: …`.

**Wave:** after Task 4 (lane `e-ci`).

- [ ] **Step 1: Write the failing spec** `scripts/check-proto-breaking.spec.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(import.meta.dirname, 'check-proto-breaking.mjs');
const ORDERS_PROTO = 'domains/orders/contracts/src/proto/orders/v1/orders.proto';

const proto = (orderFields: string): string => `syntax = "proto3";

package orders.v1;

service OrdersService {
  rpc GetOrder(GetOrderRequest) returns (Order);
}

message GetOrderRequest {
  string id = 1;
}

message Order {
${orderFields}
}
`;
const BASE_FIELDS = '  string id = 1;\n  string status = 2;';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** A git repo whose first commit (tag `base`) holds the shared buf policy and one contracts package. */
function repoWithBase(): string {
  const root = mkdtempSync(join(tmpdir(), 'proto-breaking-'));
  roots.push(root);
  mkdirSync(join(root, 'libs', 'contracts'), { recursive: true });
  copyFileSync(
    join(REPO, 'libs', 'contracts', 'buf.yaml'),
    join(root, 'libs', 'contracts', 'buf.yaml'),
  );
  write(root, ORDERS_PROTO, proto(BASE_FIELDS));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  return root;
}

function check(root: string, against = 'base'): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--against', against], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('check-proto-breaking', () => {
  it('passes when no proto changed', () => {
    const result = check(repoWithBase());
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('ok   domains/orders/contracts');
  });

  it('passes an additive change (new field)', () => {
    const root = repoWithBase();
    write(root, ORDERS_PROTO, proto(`${BASE_FIELDS}\n  string tenant_id = 3;`));
    const result = check(root);
    expect(result.status, result.output).toBe(0);
  });

  it('fails a deleted field and names it', () => {
    const root = repoWithBase();
    write(root, ORDERS_PROTO, proto('  string id = 1;'));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Previously present field "2" with name "status"');
    expect(result.output).toContain('FAIL domains/orders/contracts');
  });

  it('skips a contracts package that does not exist at the base ref', () => {
    const root = repoWithBase();
    write(
      root,
      'domains/catalog/contracts/src/proto/catalog/v1/catalog.proto',
      proto(BASE_FIELDS).replaceAll('orders', 'catalog'),
    );
    const result = check(root);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('skip domains/catalog/contracts');
  });

  it('fails clearly on an unknown ref', () => {
    const result = check(repoWithBase(), 'no-such-ref');
    expect(result.status).toBe(1);
    expect(result.output).toContain('unknown git ref no-such-ref');
  });

  it('exits 2 without --against', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/check-proto-breaking.spec.ts`
      Expected: FAIL. Every test fails because `scripts/check-proto-breaking.mjs` does not exist: node exits 1 with `Cannot find module`, and the expected strings are missing.

- [ ] **Step 3: Create `scripts/check-proto-breaking.mjs`:**

```js
// `buf breaking` for every gRPC contracts package (domains/<x>/contracts with a src/proto root)
// against a git ref, normally the pull request's base. A deleted field, renamed RPC or changed
// type fails; additions pass (policy: libs/contracts/buf.yaml, `breaking.use: [FILE]`, applied to
// both sides). A package whose src/proto does not exist at the ref is new and is skipped. The
// base protos are extracted with `git archive` (no buf git input: that needs branch names and
// enough clone depth).
//   node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>] [--buf <path>]
//                                         [--error-format text|github-actions|json]
// Exit: 0 no breaking change, 1 breaking change or error, 2 usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    against: { type: 'string' },
    root: { type: 'string' },
    buf: { type: 'string' },
    'error-format': { type: 'string', default: 'text' },
  },
});
if (args.against === undefined) {
  console.error('usage: node scripts/check-proto-breaking.mjs --against <git ref> [--root <dir>]');
  process.exit(2);
}
const against = args.against;
const root = args.root ?? join(import.meta.dirname, '..');
const buf = args.buf ?? join(import.meta.dirname, '..', 'node_modules', '.bin', 'buf');
const config = join(root, 'libs', 'contracts', 'buf.yaml');

const git = (gitArgs, options = {}) =>
  spawnSync('git', gitArgs, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });

if (git(['rev-parse', '--verify', '--quiet', `${against}^{commit}`]).status !== 0) {
  console.error(`unknown git ref ${against} (fetch it first, e.g. git fetch origin master)`);
  process.exit(1);
}

const domainsDir = join(root, 'domains');
const packages = existsSync(domainsDir)
  ? readdirSync(domainsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `domains/${entry.name}/contracts`)
      .filter((pkg) => existsSync(join(root, pkg, 'src', 'proto')))
      .sort()
  : [];
if (packages.length === 0) {
  console.error(`no contracts package with a src/proto folder under ${domainsDir}`);
  process.exit(1);
}

const baseDir = mkdtempSync(join(tmpdir(), 'proto-breaking-'));
let failed = 0;
try {
  for (const pkg of packages) {
    const protoRoot = `${pkg}/src/proto`;
    if (git(['cat-file', '-e', `${against}:${protoRoot}`]).status !== 0) {
      console.info(`skip ${pkg}: no src/proto at ${against} (new package)`);
      continue;
    }
    const archive = git(['archive', '--format=tar', against, protoRoot]);
    if (archive.status !== 0)
      throw new Error(`git archive ${against} ${protoRoot}: ${archive.stderr}`);
    const untar = spawnSync('tar', ['-x', '-C', baseDir], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar -x: ${untar.stderr}`);

    const result = spawnSync(
      buf,
      [
        'breaking',
        '--config',
        config,
        '--against',
        join(baseDir, pkg),
        '--against-config',
        config,
        '--error-format',
        args['error-format'],
      ],
      { cwd: join(root, pkg), encoding: 'utf8' },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error !== undefined) throw result.error;
    if (result.status === 0) {
      console.info(`ok   ${pkg}: no breaking change against ${against}`);
    } else {
      failed += 1;
      console.error(`FAIL ${pkg}: breaking change against ${against} (buf exit ${result.status})`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed += 1;
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(
    'A breaking proto change needs a new package version (<ctx>.v2) served next to v1: docs/RELEASING.md',
  );
  process.exit(1);
}
```

- [ ] **Step 4: Run the spec.** `npx vitest run --project scripts scripts/check-proto-breaking.spec.ts`
      Expected: PASS (6 tests; the review ran them against this exact script). Then `git fetch origin master` (sandbox off) and `node scripts/check-proto-breaking.mjs --against origin/master`. Expected: three `ok   domains/<x>/contracts` lines (billing, identity, notifications), exit 0. `origin/master` was `9600510` on 2026-11-09, which has all three proto roots.

- [ ] **Step 5: Root script.** In root `package.json`, after `"proto:lint": …,` add `"proto:breaking": "node scripts/check-proto-breaking.mjs --against origin/master",`.

- [ ] **Step 6: CI.** In `.github/workflows/ci.yml`, job `verify`, insert after the `Commit messages (commitlint)` step:

```yaml
# A deleted field, renamed RPC or changed type in a contracts package breaks running
# consumers: ship it as <ctx>.v2 instead (docs/RELEASING.md). New packages are skipped.
- name: Proto breaking changes (buf, PRs only)
  if: github.event_name == 'pull_request'
  run: >-
    node scripts/check-proto-breaking.mjs
    --against ${{ github.event.pull_request.base.sha }}
    --error-format github-actions
```

`verify` checks out with `fetch-depth: 0`, so the base commit is present.

- [ ] **Step 7: Docs.**
  - Each `domains/<x>/contracts/README.md` (billing, identity, notifications) contains:
    - the line `Check a proto change for breaking changes from this folder before releasing it:`,
    - a fenced `buf breaking --config ../../../libs/contracts/buf.yaml \` + `--against '../../../.git#branch=master,subdir=domains/<x>/contracts/src/proto'` block,
    - and the paragraph starting `The first comparison after the move to this package`.

    Replace all three with:

    ````markdown
    Breaking changes are checked against the base branch on every pull request (CI runs
    `node scripts/check-proto-breaking.mjs --against <base sha>` for every contracts package). Run it
    locally from the repo root before you push:

    ```bash
    bun run proto:breaking   # buf breaking against origin/master (git fetch origin master first)
    ```
    ````

  - `docs/RELEASING.md:137`, in the **Contract changes** paragraph: replace

    ```text
    Each `domains/<x>/contracts/README.md` documents `buf breaking` against that package's proto root for checking protos. The CI workflow does **not** run it yet. Run it by hand before releasing a proto change.
    ```

    with

    ```text
    CI runs `buf breaking` for every contracts package against the pull request's base (`scripts/check-proto-breaking.mjs`; packages that are new on the branch are skipped). Run `bun run proto:breaking` locally before pushing a proto change. There is no override label: a change the gate rejects ships as a new package version (`<ctx>.v2`, above), never as an edit of v1. Changes to an existing v1 package stay additive: add fields and RPCs, mark the ones you retire `deprecated`, and never delete, renumber or retype a field (phase B2 extends `identity.v1` this way).
    ```

  - `docs/RELEASING.md:149`, **verify** row: after the text ``5. **commitlint** over the PR range (`--from base.sha --to head.sha`, PRs only)`` insert `` 6. **proto breaking changes**: `node scripts/check-proto-breaking.mjs --against <base sha>` (PRs only)`` and renumber the following `6. **config drift**` to `7. **config drift**`.
  - `docs/RELEASING.md:167`: delete the bullet ``- No `buf breaking` gate.``
  - `docs/DOCKER.md`, section `## CI`, **verify** bullet: replace `commitlint over the PR's commits (pull requests only)` with ``commitlint over the PR's commits and `buf breaking` against the PR base (pull requests only)``.

- [ ] **Step 8: Checks.** `npx biome check --write scripts/check-proto-breaking.mjs scripts/check-proto-breaking.spec.ts package.json && npx prettier --write .github/workflows/ci.yml docs/RELEASING.md docs/DOCKER.md domains/billing/contracts/README.md domains/identity/contracts/README.md domains/notifications/contracts/README.md && bun run check`
      Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
ci(ci,tooling): gate pull requests on buf breaking for every contracts package

Compare each domains/<x>/contracts proto root with the PR base (git archive, then buf breaking
with --against-config); new packages are skipped. No override label: a breaking change ships as
<ctx>.v2. Closes E-5 (AUDIT-F21, F31).
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add scripts/check-proto-breaking.mjs scripts/check-proto-breaking.spec.ts package.json \
  .github/workflows/ci.yml docs/RELEASING.md docs/DOCKER.md domains/billing/contracts/README.md \
  domains/identity/contracts/README.md domains/notifications/contracts/README.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 6: Topology smoke test (both compose topologies, in CI) (was Task 5)

Covers E-4 (AUDIT-F13). Today CI builds the five images and boots only the infra (`.github/workflows/ci.yml:137-185`, `scripts/docker/check-infra.sh`). No job starts the apps, so a broken image entrypoint, missing env, a migration failure at boot or broken gRPC wiring between gateway and services reaches `master` unnoticed.

The script below boots one topology in an isolated compose project and waits for compose healthchecks. The app images have `HEALTHCHECK … /health/live`, at `Dockerfile:126-127,152-153`. It then probes every app's `/health/ready` from inside the compose network, using the redis image's busybox `wget` as `check-infra.sh` does. Last, it runs one REST journey through the edge API, which in microservices crosses gateway → identity-service gRPC → Postgres. App services and host ports are derived from the compose file, so the later Citus, PgBouncer and immudb lanes need no change here.

Memory: the compose limits add up to about 4.8 GiB (monolith: 4176 MiB of infra plus 768) and 5.9 GiB (microservices: 4176 plus 1856). These are ceilings, not usage (DOCKER.md "Resource budget" measures about 1.6 GB idle for the infra). GitHub's `ubuntu-24.04` runner has 16 GiB on public repositories and 7 GiB on private ones, so the microservices job fits with little headroom on a private repository. Each topology runs in its own matrix job. Step 7 documents this (review ruling: the job is accepted as designed).

**Files:**

- Create: `scripts/docker/check-topology.ts`, `scripts/docker/check-topology.spec.ts`
- Modify: root `package.json` (`scripts.docker:smoke`), `.github/workflows/ci.yml` (`image` job, new `topology` job, header comment)
- Modify (docs): `docs/DOCKER.md` (section `## CI`, `:429-443`: a **topology** bullet and a `### Topology smoke test` subsection at its end, before `## Gotchas`; S0 edits other sections of this file), `docs/RELEASING.md:150-152` (CI table), `README.md:339` (`scripts/` tree line)
- Test: `scripts/docker/check-topology.spec.ts` (pure functions, no Docker); the real run is Step 6

**Interfaces:**

- Consumes: `POST /v1/auth/register` (`RegisterDto { email, password (min length IDENTITY_LIMITS.PASSWORD_MIN_LENGTH), displayName }`) → 201 `AuthTokensResponse { accessToken, refreshToken, expiresIn, tokenType, user }`. Also `GET /v1/auth/me` (bearer) → 200 `UserResponse { id, email, … }` (`domains/identity/src/presentation/http/auth.controller.ts:58,140`), and `GET /health/ready` on container port 3000 (`libs/observability/src/health/health.controller.ts:77`).
- Produces (exports of `scripts/docker/check-topology.ts`):
  ```ts
  export const TOPOLOGIES: readonly ['monolith', 'microservices'];
  export type Topology = (typeof TOPOLOGIES)[number];
  export const PROTECTED_PROJECTS: readonly string[];
  export const APP_HTTP_PORT: 3000;
  export const PROBE_IMAGE: 'redis:8.10.2-alpine3.23';
  export const SMOKE_PASSWORD: string;
  export interface ComposeConfig {
    services: Record<string, { profiles?: string[] }>;
  }
  export interface SmokeResult {
    readonly email: string;
    readonly userId: string;
  }
  export function isTopology(value: string | undefined): value is Topology;
  export function projectName(topology: Topology, env?: NodeJS.ProcessEnv): string;
  export function shiftedHostPorts(
    composeText: string,
    env?: NodeJS.ProcessEnv,
  ): Record<string, string>;
  export function appServices(config: ComposeConfig, topology: Topology): string[];
  export function smokeJourney(baseUrl: string, fetchImpl?: typeof fetch): Promise<SmokeResult>;
  ```
  CLI: `node scripts/docker/check-topology.ts up <monolith|microservices>` (env: `NO_BUILD=1`, `TAG`, `KEEP=1`, `PROJECT`, `WAIT_TIMEOUT` seconds, `READY_TIMEOUT_MS`) and `node scripts/docker/check-topology.ts smoke --base-url <url>`.

**Wave:** after Task 5 (lane `e-ci`).

- [ ] **Step 1: Write the failing spec** `scripts/docker/check-topology.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appServices,
  type ComposeConfig,
  projectName,
  SMOKE_PASSWORD,
  shiftedHostPorts,
  smokeJourney,
  TOPOLOGIES,
} from './check-topology.js';

const COMPOSE = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A fetch double serving the two journey endpoints; `override` replaces one response. */
function fakeApi(override: Partial<Record<'register' | 'me', Response>> = {}) {
  const calls: Recorded[] = [];
  let email = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization: headers.get('authorization'),
      body,
    });
    if (url.pathname === '/v1/auth/register') {
      email = (body as { email: string }).email;
      return (
        override.register ??
        Response.json({ accessToken: 'token-1', user: { id: 'u-1', email } }, { status: 201 })
      );
    }
    if (url.pathname === '/v1/auth/me') {
      return override.me ?? Response.json({ id: 'u-1', email }, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('projectName', () => {
  it('defaults to an isolated bp-topology-<topology> project', () => {
    expect(TOPOLOGIES.map((t) => projectName(t, {}))).toEqual([
      'bp-topology-monolith',
      'bp-topology-microservices',
    ]);
  });

  it('honours PROJECT but refuses the developer project "boilerplate"', () => {
    expect(projectName('monolith', { PROJECT: 'e-smoke' })).toBe('e-smoke');
    expect(() => projectName('monolith', { PROJECT: 'boilerplate' })).toThrow(/refusing/);
  });
});

describe('shiftedHostPorts', () => {
  it('moves every *_HOST_PORT knob of docker-compose.yml off its default', () => {
    const ports = shiftedHostPorts(COMPOSE, {});
    expect(ports).toMatchObject({
      API_HOST_PORT: '23000',
      POSTGRES_HOST_PORT: '25432',
      REDIS_HOST_PORT: '26379',
      IDENTITY_GRPC_HOST_PORT: '30051',
    });
    const defaults = new Map(
      [...COMPOSE.matchAll(/\$\{([A-Z0-9_]+_HOST_PORT):-(\d+)\}/g)].map(([, name, port]) => [
        name,
        port,
      ]),
    );
    expect(Object.keys(ports).sort()).toEqual([...defaults.keys()].sort());
    for (const [name, port] of Object.entries(ports)) {
      expect(port).not.toBe(defaults.get(name));
      expect(Number(port)).toBeGreaterThan(1024);
      expect(Number(port)).toBeLessThanOrEqual(65_535);
    }
    expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
  });

  it('keeps a port the caller already set', () => {
    expect(shiftedHostPorts(COMPOSE, { POSTGRES_HOST_PORT: '15432' })).not.toHaveProperty(
      'POSTGRES_HOST_PORT',
    );
  });
});

describe('appServices', () => {
  const config: ComposeConfig = {
    services: {
      postgres: {},
      redis: { profiles: [] },
      jaeger: { profiles: ['observability'] },
      monolith: { profiles: ['monolith'] },
      gateway: { profiles: ['microservices'] },
      'billing-service': { profiles: ['microservices'] },
      'identity-service': { profiles: ['microservices'] },
      'notifications-service': { profiles: ['microservices'] },
    },
  };

  it('returns only the services of the topology profile, sorted', () => {
    expect(appServices(config, 'monolith')).toEqual(['monolith']);
    expect(appServices(config, 'microservices')).toEqual([
      'billing-service',
      'gateway',
      'identity-service',
      'notifications-service',
    ]);
  });
});

describe('smokeJourney', () => {
  it('registers a fresh user, then reads it back with the access token', async () => {
    const api = fakeApi();
    const result = await smokeJourney('http://127.0.0.1:23000', api.fetchImpl);
    expect(result.email).toMatch(/^smoke-[0-9a-f-]{36}@example\.com$/);
    expect(result.userId).toBe('u-1');
    expect(api.calls).toEqual([
      {
        method: 'POST',
        path: '/v1/auth/register',
        authorization: null,
        body: { email: result.email, password: SMOKE_PASSWORD, displayName: 'Topology Smoke' },
      },
      { method: 'GET', path: '/v1/auth/me', authorization: 'Bearer token-1', body: undefined },
    ]);
  });

  it('fails with the status and body when register does not answer 201', async () => {
    const api = fakeApi({ register: new Response('{"code":"BOOM"}', { status: 500 }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      'POST /v1/auth/register: HTTP 500 (expected 201): {"code":"BOOM"}',
    );
  });

  it('fails when register returns no access token', async () => {
    const api = fakeApi({ register: Response.json({ user: {} }, { status: 201 }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      /no accessToken/,
    );
  });

  it('fails when /v1/auth/me returns another user', async () => {
    const api = fakeApi({ me: Response.json({ id: 'u-2', email: 'someone@example.com' }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      /expected "smoke-/,
    );
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project scripts scripts/docker/check-topology.spec.ts`
      Expected: FAIL (`Failed to resolve import "./check-topology.js"`).

- [ ] **Step 3: Create `scripts/docker/check-topology.ts`** (erasable TypeScript only: Node 24 runs it with type stripping, and `tsc`/ESLint check it through the root `tsconfig.json`):

```ts
// Topology smoke test (E-4). Boots one compose topology (monolith | microservices) with the app
// images in an ISOLATED compose project on shifted host ports, waits until every container is
// healthy and every app answers GET /health/ready, runs one REST journey through the edge API
// (register, then GET /v1/auth/me with the returned token) and removes the project.
//
//   node scripts/docker/check-topology.ts up <monolith|microservices>     # builds the images
//   NO_BUILD=1 TAG=ci node scripts/docker/check-topology.ts up monolith    # CI: images loaded
//   node scripts/docker/check-topology.ts smoke --base-url http://127.0.0.1:3000   # journey only
//   KEEP=1 keeps the project; PROJECT=<name> replaces bp-topology-<topology> (never boilerplate).
//
// App services: every service whose compose `profiles` include the topology. Host ports: every
// `${X_HOST_PORT:-n}` knob not set in the environment moves to n + 20000 (n - 20000 when that
// exceeds 65535), so the developer's own stack on the default ports is never touched.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TOPOLOGIES = ['monolith', 'microservices'] as const;
export type Topology = (typeof TOPOLOGIES)[number];

/** The developer's own compose project (`name:` in docker-compose.yml): never used. */
export const PROTECTED_PROJECTS: readonly string[] = ['boilerplate'];
/** In-network HTTP port of every app image (Dockerfile `ENV PORT=3000`). */
export const APP_HTTP_PORT = 3000;
/** Probes readiness from inside the compose network (busybox wget; already pulled by infra). */
export const PROBE_IMAGE = 'redis:8.10.2-alpine3.23';
export const SMOKE_PASSWORD = 'a very long passphrase';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.yml');
const HOST_PORT_KNOB = /\$\{([A-Z][A-Z0-9_]*_HOST_PORT):-(\d+)\}/g;

export interface ComposeConfig {
  services: Record<string, { profiles?: string[] }>;
}

export interface SmokeResult {
  readonly email: string;
  readonly userId: string;
}

export function isTopology(value: string | undefined): value is Topology {
  return value !== undefined && (TOPOLOGIES as readonly string[]).includes(value);
}

export function projectName(topology: Topology, env: NodeJS.ProcessEnv = process.env): string {
  const name = env.PROJECT ?? `bp-topology-${topology}`;
  if (PROTECTED_PROJECTS.includes(name)) {
    throw new Error(`refusing to run the topology smoke test in compose project "${name}"`);
  }
  return name;
}

export function shiftedHostPorts(
  composeText: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ports: Record<string, string> = {};
  for (const [, name, port] of composeText.matchAll(HOST_PORT_KNOB)) {
    if (name === undefined || port === undefined || env[name] !== undefined) continue;
    const n = Number(port);
    ports[name] = String(n + 20_000 <= 65_535 ? n + 20_000 : n - 20_000);
  }
  return ports;
}

export function appServices(config: ComposeConfig, topology: Topology): string[] {
  return Object.entries(config.services)
    .filter(([, service]) => service.profiles?.includes(topology) === true)
    .map(([name]) => name)
    .sort();
}

async function readJson(
  response: Response,
  label: string,
  expected: number,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${label}: HTTP ${response.status} (expected ${expected}): ${text.slice(0, 500)}`,
    );
  }
  const body: unknown = JSON.parse(text);
  if (typeof body !== 'object' || body === null) {
    throw new Error(`${label}: not a JSON object: ${text.slice(0, 500)}`);
  }
  return body as Record<string, unknown>;
}

/** POST /v1/auth/register (201, accessToken) then GET /v1/auth/me (200, same email). */
export async function smokeJourney(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeResult> {
  const email = `smoke-${randomUUID()}@example.com`;
  const registered = await readJson(
    await fetchImpl(new URL('/v1/auth/register', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: SMOKE_PASSWORD, displayName: 'Topology Smoke' }),
    }),
    'POST /v1/auth/register',
    201,
  );
  const token = registered.accessToken;
  if (typeof token !== 'string' || token === '') {
    throw new Error(
      `POST /v1/auth/register returned no accessToken: ${JSON.stringify(registered)}`,
    );
  }
  const user = await readJson(
    await fetchImpl(new URL('/v1/auth/me', baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    }),
    'GET /v1/auth/me',
    200,
  );
  if (user.email !== email) {
    throw new Error(
      `GET /v1/auth/me returned ${JSON.stringify(user.email)}, expected ${JSON.stringify(email)}`,
    );
  }
  return { email, userId: typeof user.id === 'string' ? user.id : '' };
}

function run(argv: readonly string[], env: NodeJS.ProcessEnv, capture = false): string {
  const result = spawnSync('docker', argv, {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0)
    throw new Error(`docker ${argv.join(' ')} exited with ${String(result.status)}`);
  return result.stdout ?? '';
}

async function waitReady(
  project: string,
  services: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const network = run(
    [
      'network',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      'label=com.docker.compose.network=backend',
    ],
    env,
    true,
  )
    .trim()
    .split('\n')[0];
  if (network === undefined || network === '')
    throw new Error(`no backend network for project ${project}`);
  for (const service of services) {
    const url = `http://${service}:${APP_HTTP_PORT}/health/ready`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = spawnSync(
        'docker',
        ['run', '--rm', '--network', network, PROBE_IMAGE, 'wget', '-q', '-T', '5', '-O', '-', url],
        { env, encoding: 'utf8' },
      );
      if (probe.status === 0) {
        console.info(`  ${service}: ready ${probe.stdout.trim()}`);
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${service} not ready after ${timeoutMs} ms: ${probe.stdout}${probe.stderr}`,
        );
      }
      await sleep(2_000);
    }
  }
}

async function up(topology: Topology): Promise<void> {
  const project = projectName(topology);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shiftedHostPorts(readFileSync(COMPOSE_FILE, 'utf8')),
    COMPOSE_PROFILES: topology,
  };
  const compose = (...argv: string[]): string[] => [
    'compose',
    '-f',
    COMPOSE_FILE,
    '-p',
    project,
    ...argv,
  ];
  const config = JSON.parse(run(compose('config', '--format', 'json'), env, true)) as ComposeConfig;
  const services = appServices(config, topology);
  if (services.length === 0) throw new Error(`no compose service has the profile ${topology}`);
  const apiPort = env.API_HOST_PORT ?? '3000';
  console.info(
    `[check-topology] ${topology}: project ${project}, apps ${services.join(', ')}, API 127.0.0.1:${apiPort}`,
  );
  const started = Date.now();
  try {
    run(
      compose(
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        env.WAIT_TIMEOUT ?? '600',
        env.NO_BUILD === '1' ? '--no-build' : '--build',
      ),
      env,
    );
    await waitReady(project, services, env, Number(env.READY_TIMEOUT_MS ?? '180000'));
    const result = await smokeJourney(`http://127.0.0.1:${apiPort}`);
    console.info(
      `[check-topology] OK: ${topology} registered ${result.email} and read it back in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } catch (error) {
    spawnSync('docker', compose('ps', '-a'), { env, stdio: 'inherit' });
    spawnSync('docker', compose('logs', '--no-color', '--tail', '80'), { env, stdio: 'inherit' });
    throw error;
  } finally {
    if (env.KEEP === '1') {
      console.info(
        `[check-topology] KEEP=1: leaving ${project} running (docker compose -p ${project} down -v)`,
      );
    } else {
      // projectName() refused PROTECTED_PROJECTS above, so this never removes the developer's volumes.
      spawnSync('docker', compose('down', '-v', '--remove-orphans', '--timeout', '20'), {
        env,
        stdio: 'inherit',
      });
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'base-url': { type: 'string' } },
  });
  const [command, topology] = positionals;
  const baseUrl = values['base-url'];
  if (command === 'smoke' && baseUrl !== undefined) {
    const result = await smokeJourney(baseUrl);
    console.info(`[check-topology] journey OK against ${baseUrl} (${result.email})`);
    return;
  }
  if (command === 'up' && isTopology(topology)) {
    await up(topology);
    return;
  }
  console.error(
    'usage: node scripts/docker/check-topology.ts up <monolith|microservices> | smoke --base-url <url>',
  );
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `[check-topology] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the spec.** `npx vitest run --project scripts scripts/docker/check-topology.spec.ts`
      Expected: PASS (9 tests). Also run `node scripts/docker/check-topology.ts`. Expected: the usage line, exit 2. This proves Node 24.4 runs the file with type stripping. (The review ran both, plus `PROJECT=boilerplate … up monolith` → the refusal, exit 1.)

- [ ] **Step 5: Root script and CI.**

  Root `package.json`: after `"docker:down": …,` add `"docker:smoke": "node scripts/docker/check-topology.ts up",` (usage `bun run docker:smoke monolith`).

  `.github/workflows/ci.yml`, job `image`: after the `Inspect image` step, append these two steps (shown at the steps' indentation in the file):

  ```yaml
  # The topology job boots these exact images (no rebuild).
  - name: Save ${{ matrix.app }} for the topology smoke test
    run: docker save boilerplate/${{ matrix.app }}:ci | gzip -1 > "${RUNNER_TEMP}/image-${{ matrix.app }}.tar.gz"

  - uses: actions/upload-artifact@v7
    with:
      name: image-${{ matrix.app }}
      path: ${{ runner.temp }}/image-${{ matrix.app }}.tar.gz
      retention-days: 1
      compression-level: 0
  ```

  `.github/workflows/ci.yml`: add this job after `image` and before `compose`, at the same level as the other jobs under `jobs:`:

  ```yaml
  topology:
    name: Topology smoke ${{ matrix.topology }}
    needs: image
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        topology: [monolith, microservices]
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc

      - uses: actions/download-artifact@v8
        with:
          pattern: image-*
          path: ${{ runner.temp }}/images
          merge-multiple: true

      - name: Load the app images (boilerplate/<app>:ci)
        run: for f in "${RUNNER_TEMP}"/images/image-*.tar.gz; do gunzip -c "$f" | docker load; done

      # Isolated project bp-topology-<topology>, host ports +20000; register + /v1/auth/me; down -v.
      - name: Boot ${{ matrix.topology }}, wait for /health/ready, REST journey, tear down
        env:
          TAG: ci
          NO_BUILD: '1'
        run: node scripts/docker/check-topology.ts up ${{ matrix.topology }}
  ```

  `.github/workflows/ci.yml` header comment, lines 1-3: replace the last two comment lines

  ```text
  # integration tests against real Postgres/Redis, one production image per app (built, not pushed)
  # and a boot check of the docker compose infra stack.
  ```

  with

  ```text
  # integration tests against real Postgres/Redis, one production image per app (built, not pushed),
  # a boot check of the docker compose infra stack, and a smoke test that boots both app topologies
  # from those images.
  ```

- [ ] **Step 6: Real run (sandbox off, Docker).** From the worktree root:
  - `bun run docker:smoke monolith`. Expected: images build, `[check-topology] monolith: project bp-topology-monolith, apps monolith, API 127.0.0.1:23000`, `monolith: ready {"status":"ok",…}`, `[check-topology] OK: monolith registered smoke-…@example.com and read it back in …s`, then the project is removed (`docker compose ls -a | rg bp-topology` prints nothing).
  - `bun run docker:smoke microservices`. Expected: four `ready` lines (billing-service, gateway, identity-service, notifications-service), then `OK: microservices …`.
  - `PROJECT=boilerplate node scripts/docker/check-topology.ts up monolith`. Expected: `[check-topology] FAIL: refusing to run the topology smoke test in compose project "boilerplate"`, exit 1, no docker command run.
  - If a run fails because the Mac's Docker VM has too little memory, raise the Docker Desktop memory to 8 GiB and say so in the commit body. Do not lower the compose limits.

- [ ] **Step 7: Docs.**
  - `docs/DOCKER.md`, section `## CI`: after the bullet that starts `- **image** (matrix of the 5 apps)`, add the bullet

    ```markdown
    - **topology** (matrix `monolith`, `microservices`; needs `image`): loads the images the `image` job saved as
      artifacts and runs `node scripts/docker/check-topology.ts up <topology>` (see below).
    ```

    Then, at the end of the section (after the `- **compose**: …` bullet, before `## Gotchas`), add:

    ```markdown
    ### Topology smoke test

    `scripts/docker/check-topology.ts` (`bun run docker:smoke <monolith|microservices>`) boots one
    topology with the app images in an isolated project (`bp-topology-<topology>`). It moves every
    `*_HOST_PORT` knob 20000 up (so the API is on `127.0.0.1:23000`) unless you set it, so your own
    stack keeps running. It waits for every healthcheck, then for `GET /health/ready` of every app from
    inside the compose network. Then it registers a user through the API and reads it back with
    `GET /v1/auth/me`, and removes the project. `KEEP=1` keeps it running, `NO_BUILD=1 TAG=<tag>`
    reuses built images, and `node scripts/docker/check-topology.ts smoke --base-url <url>` runs only
    the REST journey against a running API. CI runs it for both topologies from the images the `image`
    job built. The script never uses the `boilerplate` project.

    Memory: the compose limits of one topology add up to about 4.8 GiB (monolith) and 5.9 GiB
    (microservices), so the microservices job needs a runner with about 6 GiB free. GitHub's
    `ubuntu-24.04` runner has 16 GiB on public repositories and 7 GiB on private ones: on a private
    repository use a larger runner if the job is killed for memory. Locally, give Docker Desktop at
    least 8 GiB.
    ```

  - `docs/RELEASING.md` CI table: after the **image** row add this row (Prettier re-pads the table):

    ```text
    | **topology** (matrix) | Loads the `image` job's images and runs `node scripts/docker/check-topology.ts up <monolith\|microservices>`: isolated project, every app healthy and `/health/ready`, `POST /v1/auth/register` + `GET /v1/auth/me` through the API, then `down -v`. |
    ```

    At the end of the **image** row's second cell, append the sentence `Each image is also saved as an artifact (one-day retention) for the topology job.`

  - `README.md:339`: change `docker/ (image assembly, infra checks)` to `docker/ (image assembly, infra checks, topology smoke test)`.

- [ ] **Step 8: Checks.** `npx biome check --write scripts/docker/check-topology.ts scripts/docker/check-topology.spec.ts package.json && npx prettier --write .github/workflows/ci.yml docs/DOCKER.md docs/RELEASING.md README.md && bun run check`
      Expected: PASS, including `tsc` and ESLint on the new `.ts` files.

- [ ] **Step 9: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
ci(ci,docker,tooling): smoke-test both compose topologies from the built images

Boot monolith and microservices in isolated projects on shifted ports, wait for /health/ready of
every app, then register a user and read it back through the API. Closes E-4 (AUDIT-F13).
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add scripts/docker/check-topology.ts scripts/docker/check-topology.spec.ts package.json \
  .github/workflows/ci.yml docs/DOCKER.md docs/RELEASING.md README.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 7: Storage emulator int specs (RustFS and fake-gcs) (was Task 6)

Covers E-3 (AUDIT-F12). `libs/storage` has only unit specs over mocked SDK clients (`src/drivers/{s3,gcs}-storage.driver.spec.ts`). No spec runs a real upload, HEAD, DELETE or presigned round trip, and the S3 checksum and signing settings (`createS3Client`: `requestChecksumCalculation: 'WHEN_REQUIRED'`, signed `content-type`/`content-length`) are untested against a server. The emulators are the compose ones: `rustfs/rustfs:1.0.0` and `fsouza/fake-gcs-server:1.56.1` (`docker-compose.yml:391-452`). They are started with testcontainers `GenericContainer` (`testcontainers` 12.2.0 is already in the root catalog). fake-gcs serves signed-URL PUT/GET on `-public-host`, and a value without a port matches any port of that host name (`fakestorage/server.go:458-464` at v1.56.1). The JSON API answers on every host.

**Files:**

- Modify: `libs/storage/package.json` (`devDependencies`), `bun.lock` (controller)
- Create: `libs/storage/test/emulators.ts`, `libs/storage/test/emulator-images.spec.ts`, `libs/storage/test/storage-drivers.int-spec.ts`
- Modify (docs): `docs/TESTING.md:240-245` (integration table and command block), `libs/storage/README.md` (Testing paragraph)
- Test: `libs/storage/test/emulator-images.spec.ts` (unit, always runs), `libs/storage/test/storage-drivers.int-spec.ts` (`storage:int`)

**Interfaces:**

- Consumes: `storageConfig.parse(env)` (`libs/config/src/namespaces/storage.config.ts`), `S3StorageDriver(cfg)`, `createS3Client(cfg.s3)`, `GcsStorageDriver(cfg, storage)`, `createGcsClient(cfg.gcs)`, `S3_UPLOAD_PART_SIZE`, `StorageService` (`libs/storage/src/index.ts`).
- Produces (test-only, `libs/storage/test/emulators.ts`):
  ```ts
  export const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.0';
  export const FAKE_GCS_IMAGE = 'fsouza/fake-gcs-server:1.56.1';
  export const EMULATOR_ACCESS_KEY = 'rustfsadmin';
  export const EMULATOR_SECRET_KEY = 'rustfsadmin';
  export const EMULATOR_BUCKET = 'uploads';
  export const EMULATOR_GCS_PROJECT = 'local-project';
  export const PUBLIC_HOST = 'localhost';
  export const INTERNAL_HOST = '127.0.0.1';
  export interface RunningEmulator {
    readonly internalEndpoint: string;
    readonly publicEndpoint: string;
    stop(): Promise<void>;
  }
  export function startRustfs(): Promise<RunningEmulator>;
  export function startFakeGcs(): Promise<RunningEmulator>;
  ```

**Wave:** start now (lane `e-storage`, parallel with lane `e-ci`). Before Step 1 the implementer adds the dependency (Step 0) and the controller runs `bun install` in the worktree.

- [ ] **Step 0: Dependency.** In `libs/storage/package.json`, replace

  ```json
    "devDependencies": {
      "@types/lodash-es": "catalog:"
    }
  ```

  with

  ```json
    "devDependencies": {
      "@types/lodash-es": "catalog:",
      "testcontainers": "catalog:"
    }
  ```

  Ask the controller to run `bun install` (it updates `bun.lock`; no new version is fetched).

- [ ] **Step 1: Write the failing unit spec** `libs/storage/test/emulator-images.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_GCS_IMAGE, RUSTFS_IMAGE } from './emulators.js';

const COMPOSE = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docker-compose.yml'),
  'utf8',
);

describe('storage emulator images', () => {
  it.each([RUSTFS_IMAGE, FAKE_GCS_IMAGE])('%s is the tag docker-compose.yml runs', (image) => {
    const escaped = image.replaceAll('.', '\\.').replaceAll('/', '\\/');
    expect(COMPOSE).toMatch(new RegExp(`^\\s+image: ${escaped}(?:\\s|$)`, 'm'));
  });
});
```

- [ ] **Step 2: Write the failing int spec** `libs/storage/test/storage-drivers.int-spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { storageConfig } from '@platform/config';
import {
  createGcsClient,
  createS3Client,
  GcsStorageDriver,
  S3_UPLOAD_PART_SIZE,
  S3StorageDriver,
  type StorageService,
} from '../src/index.js';
import {
  EMULATOR_ACCESS_KEY,
  EMULATOR_BUCKET,
  EMULATOR_GCS_PROJECT,
  EMULATOR_SECRET_KEY,
  startFakeGcs,
  startRustfs,
} from './emulators.js';

const INTEGRATION = process.env['INTEGRATION'] === '1';

interface DriverUnderTest {
  readonly storage: StorageService;
  /** Host baked into presigned URLs; differs from the endpoint the driver talks to. */
  readonly publicEndpoint: string;
  close(): Promise<void>;
}

const newKey = (name: string): string => `it/${randomUUID()}/${name}`;

/**
 * The behaviour every driver must show against a real (emulated) backend. `extra` registers
 * driver-specific cases inside the same describe (same container).
 */
function driverContract(
  name: string,
  boot: () => Promise<DriverUnderTest>,
  extra?: (current: () => DriverUnderTest) => void,
): void {
  describe.skipIf(!INTEGRATION)(`${name} against its emulator`, () => {
    let driver: DriverUnderTest | undefined;
    const current = (): DriverUnderTest => {
      if (driver === undefined) throw new Error('driver not booted');
      return driver;
    };

    beforeAll(async () => {
      driver = await boot();
    });
    afterAll(async () => {
      await driver?.close();
    });

    it('uploads a buffer; HEAD reports size, content type and metadata', async () => {
      const { storage } = current();
      const key = newKey('hello.txt');
      const stored = await storage.upload({
        key,
        body: Buffer.from('hello'),
        contentType: 'text/plain',
        metadata: { origin: 'int-spec' },
      });
      expect(stored).toMatchObject({ key, size: 5, contentType: 'text/plain' });
      const head = await storage.head(key);
      expect(head).toMatchObject({ key, size: 5, metadata: { origin: 'int-spec' } });
      expect(head?.contentType).toMatch(/^text\/plain/);
      expect(head?.lastModified).toBeInstanceOf(Date);
    });

    it('streams a body larger than one S3 multipart part', async () => {
      const { storage } = current();
      const key = newKey('big.bin');
      const size = S3_UPLOAD_PART_SIZE + 1024;
      const body = Readable.from([Buffer.alloc(S3_UPLOAD_PART_SIZE, 1), Buffer.alloc(1024, 2)]);
      const stored = await storage.upload({ key, body, contentType: 'application/octet-stream' });
      expect(stored.key).toBe(key);
      expect((await storage.head(key))?.size).toBe(size);
    });

    it('returns null for a missing key; DELETE is idempotent', async () => {
      const { storage } = current();
      expect(await storage.head(newKey('missing.txt'))).toBeNull();
      await expect(storage.delete(newKey('missing.txt'))).resolves.toBeUndefined();
      const key = newKey('gone.txt');
      await storage.upload({ key, body: Buffer.from('x'), contentType: 'text/plain' });
      await storage.delete(key);
      expect(await storage.head(key)).toBeNull();
    });

    it.each(['report.csv', 'über file (1).csv'])(
      'round-trips %s through presigned PUT and GET on the public endpoint',
      async (name) => {
        const { storage, publicEndpoint } = current();
        const key = newKey(name);
        const content = 'a,b\n1,2\n';
        const upload = await storage.createPresignedUpload(key, {
          contentType: 'text/csv',
          expiresInSec: 60,
        });
        expect(upload.url.startsWith(`${publicEndpoint}/`)).toBe(true);
        const put = await fetch(upload.url, {
          method: 'PUT',
          headers: upload.headers,
          body: content,
        });
        expect(put.status, await put.text()).toBeLessThan(300);
        expect(await storage.head(key)).toMatchObject({ key, size: content.length });

        const download = await storage.createPresignedDownload(key, { expiresInSec: 60 });
        expect(download.url.startsWith(`${publicEndpoint}/`)).toBe(true);
        const get = await fetch(download.url);
        expect(get.status).toBe(200);
        expect(await get.text()).toBe(content);
      },
    );

    extra?.(current);
  });
}

driverContract(
  'S3StorageDriver (RustFS)',
  async () => {
    const emulator = await startRustfs();
    const cfg = storageConfig.parse({
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: emulator.internalEndpoint,
      S3_PUBLIC_ENDPOINT: emulator.publicEndpoint,
      S3_ACCESS_KEY_ID: EMULATOR_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: EMULATOR_SECRET_KEY,
      S3_BUCKET: EMULATOR_BUCKET,
    });
    const admin = createS3Client(cfg.s3);
    await admin.send(new CreateBucketCommand({ Bucket: EMULATOR_BUCKET }));
    admin.destroy();
    const storage = new S3StorageDriver(cfg);
    return {
      storage,
      publicEndpoint: emulator.publicEndpoint,
      close: async () => {
        storage.onModuleDestroy();
        await emulator.stop();
      },
    };
  },
  (current) => {
    it('rejects a presigned PUT whose body is larger than the signed content length', async () => {
      const { storage } = current();
      const key = newKey('pinned.txt');
      const upload = await storage.createPresignedUpload(key, {
        contentType: 'text/plain',
        contentLength: 4,
      });
      const tooBig = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: 'hello!',
      });
      expect(tooBig.ok).toBe(false);
      expect(await storage.head(key)).toBeNull();
      const exact = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: 'four',
      });
      expect(exact.ok, await exact.text()).toBe(true);
    });

    it('forces an attachment filename on a presigned download', async () => {
      const { storage } = current();
      const key = newKey('report.csv');
      await storage.upload({ key, body: Buffer.from('a,b\n'), contentType: 'text/csv' });
      const download = await storage.createPresignedDownload(key, { filename: 'Q3 report.csv' });
      const get = await fetch(download.url);
      expect(get.status).toBe(200);
      expect(get.headers.get('content-disposition')).toMatch(/^attachment;.*Q3/);
    });
  },
);

driverContract('GcsStorageDriver (fake-gcs-server)', async () => {
  const emulator = await startFakeGcs();
  const cfg = storageConfig.parse({
    STORAGE_DRIVER: 'gcs',
    GCS_API_ENDPOINT: emulator.internalEndpoint,
    GCS_PUBLIC_ENDPOINT: emulator.publicEndpoint,
    GCS_PROJECT_ID: EMULATOR_GCS_PROJECT,
    GCS_BUCKET: EMULATOR_BUCKET,
  });
  const client = createGcsClient(cfg.gcs);
  await client.createBucket(EMULATOR_BUCKET);
  return {
    storage: new GcsStorageDriver(cfg, client),
    publicEndpoint: emulator.publicEndpoint,
    close: () => emulator.stop(),
  };
});
```

- [ ] **Step 3: Run them.**
  - `npx vitest run --project storage test/emulator-images.spec.ts`. Expected: FAIL (`Failed to resolve import "./emulators.js"`).
  - Sandbox off, Docker running: `INTEGRATION=1 npx vitest run --project storage:int`. Expected: FAIL (same import error).

- [ ] **Step 4: Create `libs/storage/test/emulators.ts`:**

```ts
import { GenericContainer, Wait } from 'testcontainers';

/** Same tags as the `rustfs` and `gcs` services of docker-compose.yml (emulator-images.spec.ts). */
export const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.0';
export const FAKE_GCS_IMAGE = 'fsouza/fake-gcs-server:1.56.1';
export const EMULATOR_ACCESS_KEY = 'rustfsadmin';
export const EMULATOR_SECRET_KEY = 'rustfsadmin';
export const EMULATOR_BUCKET = 'uploads';
export const EMULATOR_GCS_PROJECT = 'local-project';

/**
 * Two names for the same published port, like a browser (public) and the API (in-cluster): the
 * presigned URL is signed for one and the driver talks to the other. fake-gcs serves signed URLs
 * on `-public-host`; given without a port, it matches every port of that host name. Needs a local
 * Docker daemon (as in CI).
 */
export const PUBLIC_HOST = 'localhost';
export const INTERNAL_HOST = '127.0.0.1';

export interface RunningEmulator {
  /** Endpoint the driver talks to (uploads, HEAD, DELETE, bucket admin). */
  readonly internalEndpoint: string;
  /** Endpoint baked into presigned URLs: same port, other host name. */
  readonly publicEndpoint: string;
  stop(): Promise<void>;
}

async function start(container: GenericContainer, port: number): Promise<RunningEmulator> {
  const started = await container.start();
  const mapped = started.getMappedPort(port);
  return {
    internalEndpoint: `http://${INTERNAL_HOST}:${mapped}`,
    publicEndpoint: `http://${PUBLIC_HOST}:${mapped}`,
    stop: async () => {
      await started.stop();
    },
  };
}

/** RustFS (S3), configured like the compose `rustfs` service. */
export function startRustfs(): Promise<RunningEmulator> {
  return start(
    new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({
        RUSTFS_VOLUMES: '/data',
        RUSTFS_ADDRESS: '0.0.0.0:9000',
        RUSTFS_ACCESS_KEY: EMULATOR_ACCESS_KEY,
        RUSTFS_SECRET_KEY: EMULATOR_SECRET_KEY,
        RUSTFS_OBS_LOGGER_LEVEL: 'warn',
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200)),
    9000,
  );
}

/** fake-gcs-server (GCS), in-memory backend; flags appended to its `-data /data` entrypoint. */
export function startFakeGcs(): Promise<RunningEmulator> {
  return start(
    new GenericContainer(FAKE_GCS_IMAGE)
      .withCommand([
        '-scheme',
        'http',
        '-port',
        '4443',
        '-public-host',
        PUBLIC_HOST,
        '-backend',
        'memory',
        '-log-level',
        'warn',
      ])
      .withExposedPorts(4443)
      .withWaitStrategy(Wait.forHttp('/_internal/healthcheck', 4443).forStatusCode(200)),
    4443,
  );
}
```

- [ ] **Step 5: Run them.**
  - `npx vitest run --project storage`. Expected: PASS. The emulator-images spec passes 2 tests, and the int spec is not collected by the unit project.
  - Sandbox off: `INTEGRATION=1 npx vitest run --project storage:int`. Expected: PASS, 12 tests: 5 shared × 2 drivers (the `it.each` over two key names counts as two) plus 2 S3-only. The review ran this exact spec and helper against both images on 2026-11-09 (Docker Desktop on macOS): 12 passed in about 6 s, including the size-pinned PUT rejection, the attachment filename and the GCS custom metadata.
  - If one assertion fails because of an emulator limit rather than a driver bug, do not weaken the shared contract. Move that single assertion into the driver's `extra` block, wrap it in `it.fails(…)` with a comment that names the emulator version and the behaviour, and add a "Known gaps" bullet in `docs/TESTING.md`. Two cases could hit this: fake-gcs ignoring custom metadata on HEAD, or RustFS ignoring `response-content-disposition`. A failure in the shared contract on both emulators is a driver bug: stop and report it.

- [ ] **Step 6: Docs.**
  - `docs/TESTING.md`, integration table: add this row after the billing row (Prettier re-pads the table). S0's Task 1 edits the "Needs" cells of the same table. If it has merged first, add the row to its version of the table:

    ```text
    | [`libs/storage/test/storage-drivers.int-spec.ts`](../libs/storage/test/storage-drivers.int-spec.ts) | `storage:int` | Docker (testcontainers `rustfs/rustfs:1.0.0`, `fsouza/fake-gcs-server:1.56.1`) | both drivers against their emulators: buffer and multipart stream upload, HEAD, idempotent DELETE, presigned PUT/GET signed for a public host that differs from the API's endpoint (keys with spaces and non-ASCII), S3 content-length pinning and download filename |
    ```

  - In the command block under the table add the line `INTEGRATION=1 bunx vitest run --project storage:int   # S3 + GCS emulators`.
  - `libs/storage/README.md`: add at the end of the file (or merge into an existing testing section if `rg -n '^## Test' libs/storage/README.md` finds one):

    ```markdown
    ## Testing

    Unit specs mock the SDK clients. `test/storage-drivers.int-spec.ts` runs both drivers against RustFS
    and fake-gcs-server testcontainers (`INTEGRATION=1 npx vitest run --project storage:int`).
    `test/emulators.ts` (`startRustfs()`, `startFakeGcs()`) is reusable by other int specs.
    ```

- [ ] **Step 7: Checks.** `npx biome check --write libs/storage/test libs/storage/package.json && npx prettier --write docs/TESTING.md libs/storage/README.md && bun run check`
      Expected: PASS. Boundary check: `libs/storage` still imports only `@platform/*` and third-party code. `testcontainers` is declared in its `devDependencies`, and `test/**` is test code.

- [ ] **Step 8: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
test(storage): run both drivers against rustfs and fake-gcs testcontainers

Upload (buffer and multipart stream), HEAD, idempotent DELETE and presigned PUT/GET signed for a
public host, including keys with spaces and non-ASCII; S3 content-length pinning and attachment
filenames. Closes E-3 (AUDIT-F12).
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add libs/storage/package.json bun.lock libs/storage/test/emulators.ts \
  libs/storage/test/emulator-images.spec.ts libs/storage/test/storage-drivers.int-spec.ts \
  docs/TESTING.md libs/storage/README.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

### Task 8: Wave close-out (upstream re-check, docs, README count)

Covers FU-9 and FU-10 (re-checked, no work) and the phase docs. FU-9 and FU-10 were checked on 2026-11-09:

- **FU-9 (tracing gaps): still blocked.**
  - `@opentelemetry/instrumentation-nestjs-core` latest 0.72.0 (2026-11-05): "Supported Versions: `@nestjs/core` versions `>=4.0.0 <12`". The repo runs `@nestjs/core` 12.1.2.
  - `@opentelemetry/instrumentation-graphql` latest 0.73.0 (2026-11-05): `graphql` versions `>=14.0.0 <17`. The repo runs graphql 17.
  - No OpenTelemetry instrumentation for postgres.js exists in the contrib set (npm search, 2026-11-09).
- **FU-10 (Jaeger 2.20 pin): still blocked.**
  - Grafana's Jaeger datasource has moved services, operations and trace-by-id to Jaeger's `/api/v3` (grafana/grafana#109728). It still calls the internal `/api/traces` search (grafana/grafana#112336, open) and `/api/dependencies` (grafana/grafana#112348, open, waiting on jaegertracing/jaeger#7595).
  - Jaeger 2.21+ removed those endpoints (`docker-compose.yml:710-712`). Latest releases: Grafana 13.3.0, Jaeger 2.23.0.

**Files:**

- Modify: `docs/OBSERVABILITY.md:437-439` ("Known follow-ups"), `README.md:63` (test count)
- Test: none (docs only). The gates are the full test run and `bun run check`.

**Interfaces:** none.

**Wave:** after Tasks 1-7 are merged into `feat/domains-tenancy` (runs on that branch or a short `e/close-out` branch).

- [ ] **Step 1: Re-check upstream** (quick, in case something was released since this plan was written; network allowed hosts `registry.npmjs.org`, `api.github.com`):

```bash
for p in @opentelemetry/instrumentation-nestjs-core @opentelemetry/instrumentation-graphql; do
  curl -s "https://registry.npmjs.org/$p" | jaq -r '."dist-tags".latest as $l | "\(.name) \($l)", (.readme // "" | split("\n") | map(select(test("versions `"))) | .[0])'
done
for n in 112336 112348; do curl -s "https://api.github.com/repos/grafana/grafana/issues/$n" | jaq -r '"grafana#\(.number) \(.state)"'; done
curl -s https://api.github.com/repos/jaegertracing/jaeger/issues/7595 | jaq -r '"jaeger#\(.number) \(.state)"'
```

Expected: nestjs-core still `<12`, graphql still `<17`, both Grafana issues and jaeger#7595 `open`. If any of them changed, do not implement it in this task. Write the finding into the commit body and tell the controller, who decides whether to add a G task (OTel instrumentation, or bumping Jaeger plus the Grafana datasource check).

- [ ] **Step 2: `docs/OBSERVABILITY.md`.** In "Known follow-ups", replace the two bullets

  ```markdown
  - **Tracing gaps** for NestJS 12, graphql 17 and postgres.js: rely on `@Span()` / `@Traceable()`
    until upstream instrumentations support them.
  - **Jaeger** stays on 2.20 until Grafana's Jaeger datasource supports the 2.21+ API.
  ```

  with:

  ```markdown
  - **Tracing gaps** for NestJS 12, graphql 17 and postgres.js: rely on `@Span()` / `@Traceable()`
    until upstream instrumentations support them. Re-checked 2026-11-09:
    `@opentelemetry/instrumentation-nestjs-core` 0.72.0 supports `@nestjs/core <12`,
    `@opentelemetry/instrumentation-graphql` 0.73.0 supports `graphql <17`, and there is no
    postgres.js instrumentation.
  - **Jaeger** stays on 2.20 until Grafana's Jaeger datasource stops calling the endpoints 2.21
    removed. Re-checked 2026-11-09 (Grafana 13.3.0, Jaeger 2.23.0): trace search
    ([grafana/grafana#112336](https://github.com/grafana/grafana/issues/112336)) and dependencies
    ([grafana/grafana#112348](https://github.com/grafana/grafana/issues/112348), waiting on
    [jaegertracing/jaeger#7595](https://github.com/jaegertracing/jaeger/issues/7595)) still use them.
  ```

- [ ] **Step 3: Full run and README count (sandbox off).** `bun run test 2>&1 | tail -6`. Expected: PASS. Read `Test Files  N passed` and `Tests  M passed`. In `README.md:63`, replace the numbers in `254 test files / 1891 tests at the time of writing` with N and M. A parallel lane may have updated that sentence, so match on `test files /` rather than on the old numbers. Then run the integration projects against a throwaway Redis on a shifted port (never the developer's 6379), and remove it by name:

  ```bash
  docker run -d --rm --name e-closeout-redis -p 127.0.0.1:26379:6379 redis:8.10.2-alpine3.23
  REDIS_URL=redis://127.0.0.1:26379 INTEGRATION=1 bun run test:int
  docker rm -f e-closeout-redis
  ```

  Expected: PASS, including `storage:int` (12 tests).

- [ ] **Step 4: Checks.** `npx prettier --write docs/OBSERVABILITY.md README.md && bun run check && node scripts/check-env-example.mjs && bun run db:check`
      Expected: PASS.

  G deletes the neighbouring "Separate metrics listener" and "No app-level … metrics" bullets of the same list. If that merge conflicts here, keep G's deletions and this task's two bullets.

- [ ] **Step 5: Commit.**

```bash
cat > "$TMPDIR/e-msg.txt" <<'EOF'
docs(docs,repo): record the upstream tracing blockers and refresh the test count

FU-9 and FU-10 re-checked 2026-11-09: still blocked upstream (nestjs-core <12, graphql <17,
grafana#112336 and #112348, jaeger#7595). Closes the E wave-1 checkpoint.
EOF
bunx commitlint < "$TMPDIR/e-msg.txt"   # no ✖, no ⚠
git add docs/OBSERVABILITY.md README.md
git commit -S -F "$TMPDIR/e-msg.txt"
```

## Self-review

| Inventory item       | Task | Evidence the task closes it                                                  |
| -------------------- | ---- | ---------------------------------------------------------------------------- |
| E-6 (AUDIT-F21)      | 1    | `bun run db:check` in the drift step                                         |
| B1FU-9               | 2    | `scripts/libs-vocabulary.spec.ts` passes (identifiers included)              |
| B1FU-10              | 3    | `vitest.setup.ts` (static logger and `TestingLogger`); 0 `[Nest]` lines      |
| B1FU-11              | 3    | `UNIT_TEST_TIMEOUT_MS` / `UNIT_HOOK_TIMEOUT_MS` on unit and scripts projects |
| AUDIT-F35, B1FU-8    | 4    | apps and every lib scanned; compose `${VAR}` cross-check both ways           |
| E-5 (AUDIT-F21, F31) | 5    | `scripts/check-proto-breaking.mjs`, PR-only `verify` step, no override label |
| E-4 (AUDIT-F13)      | 6    | `topology` CI job, `scripts/docker/check-topology.ts`                        |
| E-3 (AUDIT-F12)      | 7    | `storage:int` runs both drivers against RustFS and fake-gcs                  |
| FU-9, FU-10          | 8    | re-checked, still blocked, recorded in `docs/OBSERVABILITY.md`               |
| Out of scope         | –    | E-1, E-2 (after B4, spec §2 row E), E-7, E-8 (later plans)                   |

Names are consistent across tasks:

- `db:check`, `proto:breaking` and `docker:smoke` are the only new root scripts.
- `check-topology.ts` exports match the Interface contracts.
- `UNIT_*_TIMEOUT_MS` are used by Task 3 only. Tasks 1 and 2 run before it and need no raised timeout: their slow case sets its own 60 s. The `scripts` specs of Tasks 4-6 run under the 15 s default.
- Commit scopes are all in the commitlint list: `tooling`, `ci`, `identity`, `billing`, `docker`, `storage`, `repo`, `docs`.

## Plan review (2026-11-09)

Adversarial review `review:e` against the repo at `d0b9e2f` (code at `9600510`), spec §13 and §16, the inventory and the C, G, L and S plans as written that day. Every code block was extracted from this plan into a scratch copy of the repo and run there: the `scripts` specs in a copy of the root Vitest config, `tsc` with the repo's `tsconfig.base.json`, the repo's ESLint config, Biome with the repo's `biome.json`, and `commitlint` on every header and body. Task 7 also ran against the real emulator images with Docker.

**Changed**

1. **Order (ruling).** `db:check` (old 3) and the libs vocabulary guard (old 7) are now Tasks 1 and 2 of `e-ci`. Neither depends on the old Task 1: drizzle-kit takes about 0.2 s per run and the `bun run` case sets 60 s, and the guard only reads files. The controller merges `e/ci-tooling` after Task 2, before B2 executes (Global Constraints, "Early merge"). Renumbered: old 1 → 3, 2 → 4, 3 → 1, 4 → 5, 5 → 6, 6 → 7, 7 → 2, 8 → 8. Headings carry "(was Task n)". Every Wave line, table, Review Focus item and cross-reference follows the new numbers.
2. **Task 3 (vitest hygiene), a real bug.** `Logger.overrideLogger(false)` alone does not silence testing-module specs. `Test.createTestingModule().compile()` reinstalls a `TestingLogger` (`@nestjs/testing/testing-module.builder.js:127-129`) whose `error` still prints with its stack. `vitest.setup.ts` now also sets `TestingLogger.prototype.error` to a no-op (imported through the package's `"./*.js"` export). A new test fails without that line and passes with it. Measured with the fixed setup: 0 `[Nest]` lines in a unit run (38 before), and the same sandbox-only failures as before. The spec has 7 tests.
3. **Task 3 docs.** The TESTING.md "Vitest projects" cell literally reads `Vitest defaults`, which the old `rg` pattern never matched. The step now names that cell.
4. **Task 4 (check-env-example), a test that could never pass.** "fails on a compose-section variable that no compose file interpolates" had no compose file in its tree, and the script checks that section only when a compose file exists. Added `docker-compose.yml: 'services: {}'`. "passes on this repository" now accepts more root compose files (a regex instead of `(docker-compose.yml)`). Added a file-level `biome-ignore-all` for `noTemplateCurlyInString`: the repo is warning-free today, and the 5 `${VAR}` literals would add warnings. Step 2's expected failures are corrected to 7 of 9.
5. **Task 2 (vocabulary guard), a weak guard.** The old guard used `\w` boundaries, so it missed `FIXTURE_PAYMENT_SUCCEEDED_EVENT`, `paymentId`, `notifications_by_user`, `notificationCreated` and `STRIPE_ERROR`: 26 of 120 lines. It now splits camelCase and treats `_`, `-` and `.` as boundaries, and its unit test covers those cases. Other changes:
   - Counts corrected to 120 lines in 29 files (the plan said "about 125" and listed `libs/contracts` files that have no hits any more).
   - The mapping covers the fixture constant and its fields, the Cassandra table, the GraphQL event name, the error code and `@domain/files`.
   - The Step 2 work-list command matched nothing, because Vitest's diff lines start with `+`. It now extracts the paths.
   - `escape` is renamed `escapeRegExp`: Biome's `noShadowRestrictedNames` is an error, and `bun run check` would fail.
6. **Commit messages.** Every `-m` body was one line of 150-200 characters. The repo's commitlint warns above 100, and the task rules require at most 100. Each Commit step now writes a wrapped message to `$TMPDIR/e-msg.txt`, lints it whole and commits with `-F`. All 8 messages pass with no warning.
7. **Rulings on docs.** Task 5's RELEASING.md text now states that there is no override label, that a breaking change ships as `<ctx>.v2`, and that v1 changes stay additive (B2's `identity.v1`). Task 6 documents the runner memory: about 5.9 GiB of limits for microservices, against 7 GiB on private runners.
8. **Docs collisions with S0.** Task 6's DOCKER.md section used to go after the `check-infra.sh` paragraph, which is exactly where S Task 2 adds "Postgres runs Citus". It now goes at the end of `## CI`, with a **topology** bullet. Tasks 1 and 5 add `db:check` and `buf breaking` to that section's **verify** bullet, which the plan never updated.
9. **Smaller fixes.**
   - The `libs/database/README.md` sentence is wrapped over two lines, so the old quote could not match. The quote is now exact.
   - Task 7 Step 0 has the exact multi-line JSON edit.
   - Task 8 Step 3 gives a concrete throwaway Redis (`e-closeout-redis` on 26379, removed by name).
   - The boundary-check line now allows 27 packages once L-1 has merged.
   - Global Constraints say how root files resolve `@nestjs/*`.
   - Shared files gained a cross-lane overlap table: C, G, L, S, file by file.
   - The topology memory figures are recomputed from `docker-compose.yml` (4176 MiB of infra, +768 monolith, +1856 microservices).

**Verified unchanged**

- Task 1: the spec passes after Step 3. The fork case reports "collision", and `bun run --filter` output gives one "Everything's fine" per domain.
- Task 5: the script passes 6/6 spec cases, and on the repo it gives three `ok` lines against `master` and `origin/master` (both `9600510`).
- Task 6: 9/9 spec cases pass. The CLI usage path exits 2 and the `boilerplate` refusal exits 1 under Node 24.4 type stripping. `docker compose config --format json` gives `profiles: null` for infra services, which `appServices` handles.
- `actions/upload-artifact@v7` (v7.0.2, with `compression-level` and `retention-days`) and `actions/download-artifact@v8` (v8.0.2, with `pattern` and `merge-multiple`) exist.
- Task 7: 12/12 against `rustfs/rustfs:1.0.0` (whose `VOLUME /data` gets an anonymous volume) and `fsouza/fake-gcs-server:1.56.1`. The testcontainers 12.2.0 APIs used here exist. fake-gcs's `publicHostMatcher` ignores the port when `-public-host` has none.
- Task 8: the upstream re-check commands run as written: nestjs-core 0.72.0 `<12`, graphql 0.73.0 `<17`, and the three issues are open.

**Unresolved (coordination, not blockers for this plan)**

- C and G plan new `libs/**` spec code with domain words. C: `rate-limit-policy.spec.ts` (`identity.credentials`). G: `grpc-metrics.spec.ts`, `grpc-breaker-metrics.spec.ts`, `kafka-metrics.spec.ts`, and the `connect-microservices.spec.ts` rewrite (`notifications-service`). Once Task 2 has merged, those lanes fail `bun run test` until they use the neutral vocabulary. Their reviewers must apply Task 2 Step 3's mapping.
- Other plans cite old E task numbers: C cites "E Task 7"; S cites "E Task 2" and "E Task 3". See the renumbering map under "Interface contracts".
- S Task 3 and Task 2 both edit `libs/database/src/migrator/run-migrations.spec.ts`. Both precede B2, and the second to merge re-applies its edits.
