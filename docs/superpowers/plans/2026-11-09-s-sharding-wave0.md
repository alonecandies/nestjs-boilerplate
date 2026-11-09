# S Sharding Wave 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Executive summary

Four tasks (SH-1..SH-4 of the sharding design, section 9), one lane `s0` (branch `s/citus-wave0`), run in order.
All four must be merged into `feat/domains-tenancy` before B2 executes (design section 8, "BEFORE B2").

| Task | Id   | Deliverable                                                                                                      |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | SH-1 | `@platform/testing/postgres`: `startTestPostgres()` on `citusdata/citus:14.2.0`; the three inline helpers move   |
| 2    | SH-2 | Compose `postgres` on Citus single node (+ `00-citus.sql`), `check-infra.sh` asserts Citus, CI pre-pulls         |
| 3    | SH-3 | Platform `0001_citus_helpers.sql` (five helpers + `app.tenant_colocation`) and the runner's Citus session `SET`s |
| 4    | SH-4 | "Citus-ready schema rules" in `docs/DEVELOPMENT.md` and the plan-writer addendum in `conventions.md`             |

Findings the design does not state (verified 2026-11-09/10 in the repo, upstream and in `prog-probe-*` containers):

- The compose mount `./docker/postgres/init:/docker-entrypoint-initdb.d:ro` (`docker-compose.yml:191`) hides the
  image's `001-create-citus-extension.sql`: SH-2 adds `00-citus.sql` and a `check-infra.sh` assertion (design
  section 6 corrected accordingly). Testcontainers mounts nothing, so the image script runs there.
- Citus puts views (`citus_tables`, `citus_schemas`) in `public`: the two "no table in public" specs filter
  `table_type = 'BASE TABLE'`. Both app-shaped specs list `app.tenant_colocation` after SH-3.
- Databases created on the coordinator (`database.int-spec.ts`, `citus.int-spec.ts`'s `plain`) have no `citus`
  extension, so the helpers' plain-Postgres no-op path is tested in the same container.
- The runner needs `citus.enable_local_execution = on` (a fresh `0000_init` + `distribute` set fails with
  `type "<schema>.<enum>" does not exist` when sessions default to remote execution) and
  `citus.multi_shard_modify_mode = 'sequential'` (distribute, then a reference-table FK, once shard DDL goes over
  connections, as on a cluster).

Review (2026-11-10): probes b-d re-run on Citus 14.2.0 (appendix), and every test step of Tasks 1 and 3 was run on
a scratch copy of the repo with the plan's code: Task 1 unit 8/8 (red first), `testing:int` 5/5 in 34 s; Task 3
unit red (3 failures) then 86/86 in the `database` project; `database:int` 25/25 (9 Citus + 16), `identity:int`
15/15, `billing:int` 6/6; without the runner's local-execution `SET` the first `runMigrations()` int test fails
with `type "catalog.order_status" does not exist`. Biome, ESLint and root `tsc` are clean on the new code.

Apple Silicon: `citusdata/citus:14.2*` is amd64-only; compose pins `platform: linux/amd64`, Testcontainers calls
`.withPlatform('linux/amd64')` (Rosetta emulation, ~14 s per container start). Pull the image once first.

Contracts for other lanes: `@platform/testing/postgres` (no `workers` option until SH-11), the five SQL helpers
and the anchor table, platform index `0001` taken (B3-4 and B1FU-3 start at `0002`), the runner's Citus session
settings. No new env variable, no new compose `${VAR}`, no `app.module.ts` change.

## Goal, architecture and stack

**Goal:** Make Citus 14.2 the Postgres of every dev, CI and test environment, ship idempotent distribution helpers
that are no-ops on plain Postgres, and publish the Citus-ready schema rules, so that B2's tables are born shardable.

**Architecture:** Test infrastructure in `libs/testing` (test-only subpath), hand-written SQL in the platform
migration set (`libs/database`), one guarded `SET` in the migration runner, compose and CI config, docs. Single
node everywhere in this wave: the coordinator holds every shard and needs no setup (design [P-11]).

**Tech Stack:** Node 24.4.0, Bun 1.4.3, Vitest 5.0.3, testcontainers / `@testcontainers/postgresql` 12.2.0,
postgres.js 3.4.9, drizzle-orm 0.45.4, Citus 14.2.0 on PostgreSQL 18.4 (`citusdata/citus:14.2.0`, amd64), Docker
Compose v2.24+.

**Spec:** `docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md` (sections 2.1, 4, 6, 8, 9;
appendix P-10, P-11, P-13, P-14, P-16); `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md`
(§4, §13, roadmap row S); `docs/superpowers/plans/program-work/conventions.md`.

## Global Constraints

- **Node.** Prefix every command with
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;`. Under Node 20 the
  pre-commit hook fails.
- **Sandbox.** Run these outside the sandbox: Docker (testcontainers, compose), the full Vitest run and GPG
  signing.
- **Worktree.** Lane `s0` works in one git worktree under the session scratchpad (never inside the repo), on branch
  `s/citus-wave0` cut from `feat/domains-tenancy`. The controller runs `bun install --frozen-lockfile` when it
  creates the worktree. The implementer runs plain `bun install` once, in the worktree, in Task 1 Step 7 (controller
  ruling 2026-11-09; sandbox off, it needs the network), and `bun.lock` goes into Task 1's commit. No other task
  runs `bun install`.
  The lane merges into `feat/domains-tenancy` with `git merge --no-ff -S`, subject
  `chore(repo): merge s/citus-wave0 — Citus single node, helpers and schema rules`.
- **Commits.** One GPG-signed commit per task: `git commit -S`, never `--no-verify`. **No attribution lines**: no
  `Co-Authored-By` or any other trailer (user decision 2026-11-09; it overrides conventions.md §1.2 and §4.2).
  Header `<type>(<scope>[,<scope>]): <subject>`, at most 100 characters, subject lower-case first, no trailing
  period. Types: `build chore ci docs feat fix perf refactor revert style test`. Scopes used here: `testing`,
  `database`, `identity`, `billing`, `docker`, `ci`, `docs`, `repo`. Not scopes: `citus`, `sharding`, `s0`,
  `scripts`. Pre-check every header: `printf '%s\n' "<header>" | bunx commitlint`. Never push, merge to master or
  open a PR without asking.
- **Search.** `rg` and `fd`; `jaq` for JSON. A hook blocks `grep`, `find` and `jq`.
- **Edits.** Line numbers are hints; match every edit on the quoted text. After editing TypeScript or JSON run
  `npx biome check --write <files>`; after Markdown or YAML run `npx prettier --write <files>`. Before every commit
  run `bun run check`; it must end with
  `Layer boundaries OK (26 packages: apps -> domains -> contracts -> libs).` (this plan adds no package).
- **Tests.** Unit: `npx vitest run --project <pkg> <path>`. Integration (Docker, sandbox off):
  `INTEGRATION=1 npx vitest run --project <pkg>:int` (`testing:int`, `database:int`, `identity:int`,
  `billing:int`; `database:int` runs its two files in parallel, two containers). Run int projects one at a time on a
  laptop: four or more emulated Citus containers at once can exceed the 180 s hook timeout.
- **Layering.** `libs/` names no domain, in code, SQL and comments: say `<schema>.<table>`, never a domain table.
  Specs and fixtures use the neutral vocabulary (`orders`, `catalog`, `regions`, `shipments`, `alerts`,
  `devices`), E plan Task 2's mapping (identity → orders, billing → catalog, notifications → alerts, payments →
  shipments, stripe → acmepay, checkout → dispatch). E's `scripts/libs-vocabulary.spec.ts` reads every `.ts` file
  under `libs/testing/src/**` (production helpers included) and every `libs/**` spec, fixture and `test/` file:
  every code block of this plan that lands in `libs/` passes it (review check 2026-11-10). `@platform/testing`
  (and so `@platform/testing/postgres`) may be imported only from test code (`scripts/check-boundaries.mjs:48-50`,
  `TEST_ONLY` already matches the subpath).
- **Env.** No new runtime variable and no new compose `${VAR}`: `.env.example` is untouched. Values such as
  `citus.shard_count=8` are literals in `docker-compose.yml`, so E's extended `check-env-example` has nothing new to
  check. `INTEGRATION_DATABASE_URL` keeps working as the opt-out from Testcontainers.
- **Docker.** Never touch the developer's containers (Postgres 5432, Redis 6379, MySQL) or the `boilerplate`
  compose project or its `pg-data` volume. Compose runs use project `s0-infra-check` with host ports shifted by
  30000 (Task 2 Step 6). Every `down -v` is done by `check-infra.sh`'s own project-scoped cleanup.
- **Images.** `citusdata/citus:14.2.0` exactly (PostgreSQL 18.4, Citus 14.2.0, Debian, amd64 only). Never
  `latest`, never the `-alpine` tag (also amd64-only, and not what the design probed).
- **Apple Silicon.** Docker Desktop must have "Use Rosetta for x86_64/amd64 emulation" on (default in current
  versions). Pull once before the first int run: `docker pull --platform linux/amd64 citusdata/citus:14.2.0`.

## Review Focus

The five failure modes most likely to bite users that no existing test exercises, and the test that now covers
each:

1. **Generated role passwords with URL-reserved characters** (`@`, `:`, `/`, `%`, spaces, non-ASCII) in
   `urlFor(role, password)`: B3's roles get such passwords, and a half-encoded URL logs in as the wrong user or
   fails auth. Task 1: unit round-trip of `p@ss:w/rd%41 é#?` and an int login as `probe_reader` with
   `p@ss:w/rd%41 é`.
2. **`localExecution: false` that silently stays local.** RLS specs (B3-6) rely on it to catch settings that do
   not propagate to shards [P-11b]; if the flag were ignored they would pass falsely. Task 1: the int spec logs
   Citus commands and expects `issuing …` (remote) with the flag off and `executing the command locally` with it
   on.
3. **A Citus binary without the `citus` extension** (the compose init-dir mount hides the image's script; an
   existing `pg-data` volume never re-runs init). The helpers would no-op and sharding would silently never
   happen. Task 2: `00-citus.sql`, and `check-infra.sh` fails on a missing `citus` extension or a
   `shared_preload_libraries` that does not start with `citus`; Task 1: `startTestPostgres` fails fast when the
   container lacks the extension.
4. **Helper misuse**: a misspelt table name, a re-run of a distribution migration (squash, hand-distributed table),
   or a call that would change a table's kind. Task 3: a misspelt name fails even on plain Postgres (regclass
   cast), a second run of every helper leaves `pg_dist_partition` unchanged, and each kind change raises.
5. **One drizzle transaction that creates an enum, distributes tables and then adds a reference-table FK** (the
   shape of a fresh database's `0000_init` + `distribute` files). Task 3: the runner applies the fixture set while
   role `app`'s sessions default to `citus.enable_local_execution = off` (it would fail with
   `type "catalog.order_status" does not exist` without the runner's `SET`), and under remote execution the same
   statements fail in parallel mode with Citus' parallel-operation error and pass in sequential mode (the control
   that proves the sequential `SET` matters on a cluster [P-10]).

## Lane and files

**Lane `s0`** (branch `s/citus-wave0`; Tasks 1 → 2 → 3 → 4, one after another: Task 3's int spec needs Task 1's
helper, and Tasks 1 and 3 edit the same three int specs) owns:

- `libs/testing/src/postgres/index.ts`, `libs/testing/src/postgres/start-test-postgres.ts`,
  `libs/testing/src/postgres/start-test-postgres.spec.ts`, `libs/testing/src/postgres/start-test-postgres.int-spec.ts`
  (all new), `libs/testing/package.json`, `libs/testing/README.md`
- `libs/database/test/database.int-spec.ts`, `libs/database/test/citus.int-spec.ts` (new),
  `libs/database/test/fixtures/fixture-sets.ts`, `libs/database/test/fixtures/citus/migrations/**` (new)
- `libs/database/src/platform/migrations/0001_citus_helpers.sql` (new),
  `libs/database/src/platform/migrations/meta/_journal.json`, `libs/database/src/platform/platform.migrations.ts`,
  `libs/database/src/platform/platform.migrations.spec.ts`, `libs/database/src/migrator/run-migrations.ts`,
  `libs/database/src/migrator/run-migrations.spec.ts`, `libs/database/package.json`, `libs/database/README.md`
- `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts`,
  `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts`
- `docker/postgres/init/00-citus.sql` (new), `docker/postgres/init/01-extensions.sql`

**Shared files** (other lanes edit them too; exact change per task). E Tasks 1-2 are already merged into
`feat/domains-tenancy` (`13030b0`, 2026-11-10): the worktree is cut from there, so their edits are the baseline and
every quoted anchor below was re-checked against it. Rule for every row: the lane that merges second keeps both
changes, re-runs Prettier on Markdown/YAML and `bun run check`.

| File                                                                         | S task | S change                                                                                                                                                                                               | Other lanes                                                                                                                                             | Merge order                                                                            |
| ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `bun.lock`                                                                   | 1      | `bun install` after the four `package.json` edits (Step 7); no new version                                                                                                                             | E-7 (`libs/storage`), C, L-1/L-8a/L-9, G (none)                                                                                                         | any; the second merge re-runs `bun install` and commits the lock                       |
| `domains/identity/package.json`, `domains/billing/package.json`              | 1      | delete `"@testcontainers/postgresql": "catalog:",` from `devDependencies` (`:64`, `:57`)                                                                                                               | E-1 (merged) added `db:check` in `scripts`; L adds billing deps after G-11                                                                              | any (different blocks)                                                                 |
| `libs/database/package.json`                                                 | 1      | `devDependencies`: `@testcontainers/postgresql` → `@platform/testing`                                                                                                                                  | G Task 10 (`test/pool-usage.int-spec.ts` has an S and a non-S variant)                                                                                  | S first preferred; G picks its variant by `fd -t f index.ts libs/testing/src/postgres` |
| `libs/database/test/database.int-spec.ts`                                    | 1, 3   | helper swap (Task 1), CLI counts 4 → 5 and platform rows 1 → 2 (Task 3)                                                                                                                                | E-2 (merged, no hit in this file)                                                                                                                       | –                                                                                      |
| `libs/database/src/migrator/run-migrations.spec.ts`                          | 3      | two tests after `'applies the sets in array order on ONE session, …'` (neutral `orders` sets)                                                                                                          | E-2 (merged) renamed its literals (`inventory`, …)                                                                                                      | – (S applies on top; anchor unchanged)                                                 |
| `libs/database/README.md`                                                    | 1, 3   | `:138-139` sentence (Task 1); "Platform migration set" paragraph and "Tests" bullet (Task 3)                                                                                                           | E-1 (merged) `:168-169`; G pool rows                                                                                                                    | any; G second keeps S's paragraph                                                      |
| `docker-compose.yml`                                                         | 2      | `postgres` service only: comment, `image`, `platform`, three `-c` pairs in `command`                                                                                                                   | L-6 `x-env-immudb`, `immudb`/`immudb-init`, volume, `infra-ready.depends_on`; G-6 `x-env-base` `METRICS_PORT` (`:35`). C: no compose change in its plan | any (different blocks)                                                                 |
| `scripts/docker/check-infra.sh`                                              | 2      | the `postgres:` block (`:73-81`)                                                                                                                                                                       | L-6 init-list (`:42`) and port-loop (`:108-111`) entries                                                                                                | any                                                                                    |
| `.github/workflows/ci.yml`                                                   | 2      | job `integration`: comment (`:104-105`) and one step before `Integration tests …` (`:135`)                                                                                                             | E-1 (merged) drift step; E-5 `verify` step; E-6 `image` job + `topology` job; L-1 drift paths                                                           | any (different blocks)                                                                 |
| `docs/TESTING.md`                                                            | 1, 3   | mermaid node `:16`, pyramid row `:26`, toolbox row after `createMock`, "Needs" cells `:242-244`, `testing:int` and `citus.int-spec.ts` rows, the "Postgres is Citus" paragraph after the command block | E-3 `<name>` row + new section before `## Integration tests`; E-7 storage row; C, G toolbox/e2e lists; L-15 toolbox and int rows                        | any; the second re-applies its cells, Prettier re-pads the tables                      |
| `docs/DOCKER.md`                                                             | 2      | stack-map `postgres` row `:35`; `check-infra.sh` sentence `:223`; "Postgres runs Citus" subsection before `## Images (Dockerfile)`; Gotchas 15-16                                                      | L-6 stack-map rows after `cassandra-init` + bootstrap note; E-1 (merged)/E-5/E-6 `## CI` only; G metrics port                                           | any; renumber Gotchas if another lane appended first                                   |
| `docs/DEVELOPMENT.md`                                                        | 4      | `### Citus-ready schema rules` before `## Cassandra CQL migrations` (`:466`)                                                                                                                           | E-1 (merged) "Database migrations" paragraph; E-4 `:286`; G "add a new domain module" guide                                                             | any                                                                                    |
| `docs/superpowers/plans/program-work/conventions.md`                         | 4      | `### 4.11` before the `---` above `## 5. Parallelism` (`:662-664`)                                                                                                                                     | none in the current plans                                                                                                                               | –                                                                                      |
| `libs/database/src/platform/migrations/` (+ journal)                         | 3      | takes index `0001`, `when` `1794182400000`                                                                                                                                                             | B3-4, B1FU-3 (later plans)                                                                                                                              | S first; later platform SQL is `0002+`                                                 |
| `domains/*/…/users.repository.int-spec.ts`, `billing.migrations.int-spec.ts` | 1, 3   | helper swap, `BASE TABLE` filter, `app.tenant_colocation` in the table lists                                                                                                                           | B2 (identity/billing tables)                                                                                                                            | **S before B2**: B2 then adds its tables to lists that already hold the anchor         |

Not changed: root `package.json` (catalog and scripts), `.env.example`, `apps/*` (no `app.module.ts`, no
`database.migrations.ts`), `vitest.config.ts`, `scripts/check-env-example.mjs`, `scripts/docker/validate-compose.sh`,
`README.md:63` (the test count moves at the phase checkpoint).

### Execution order

| #   | Task | Needs                   | Notes                                                                                     |
| --- | ---- | ----------------------- | ----------------------------------------------------------------------------------------- |
| 1   | SH-1 | –                       | implementer runs `bun install` in Step 7 (sandbox off); `bun.lock` in the commit          |
| 2   | SH-2 | 1                       | Docker real run (`check-infra.sh`) in an isolated project                                 |
| 3   | SH-3 | 1 (Citus int container) | takes platform migration `0001`; edits the same int specs as Task 1                       |
| 4   | SH-4 | 3 (helper names)        | docs only                                                                                 |
| –   | B2   | 1-4 merged              | B2-1..B2-6 use the section 2.3 shapes; SH-5/SH-6 follow B2's table tasks (see last table) |

### Interface contracts

- `@platform/testing/postgres` (test-only). Export map entry in `libs/testing/package.json`:
  ```json
  "./postgres": {
    "@repo/source": "./src/postgres/index.ts",
    "types": "./src/postgres/index.ts",
    "default": "./dist/postgres/index.js"
  }
  ```
  ```ts
  export const TEST_POSTGRES_IMAGE = 'citusdata/citus:14.2.0';
  export const TEST_POSTGRES_SHARD_COUNT = 4;
  export interface TestPostgresOptions {
    localExecution?: boolean; // default true; false = citus.enable_local_execution=off (RLS specs)
    initSql?: readonly string[]; // run in order as the superuser before resolving; multi-statement entries allowed
    allowExternalUrl?: boolean; // default true: INTEGRATION_DATABASE_URL replaces the container
  }
  export interface TestPostgres {
    readonly url: string; // superuser URL of database `app` (user/password `app`)
    urlFor(role: string, password: string): string; // same server and database, percent-encoded login
    stop(): Promise<void>; // idempotent; no-op for INTEGRATION_DATABASE_URL
  }
  export function startTestPostgres(options?: TestPostgresOptions): Promise<TestPostgres>;
  export function testPostgresCommand(
    options?: Pick<TestPostgresOptions, 'localExecution'>,
  ): string[];
  export function urlWithLogin(url: string, role: string, password: string): string;
  ```
  With `INTEGRATION_DATABASE_URL`, `localExecution` and the shard count are not applied (the server is not ours);
  `initSql` still runs. The design's `workers?: 0 | 1` option is **not** in wave 0: SH-11 adds it (additive).
- Platform set (`libs/database/src/platform/migrations`), file `0001_citus_helpers.sql`, journal `when`
  `1794182400000`. **Index `0001` is taken**: B3-4, B1FU-3 and any later platform SQL start at `0002` with a larger
  `when`.
  ```sql
  app.citus_enabled() RETURNS boolean                 -- STABLE; true iff extension citus is installed here
  app.tenant_colocation (tenant_id uuid PRIMARY KEY)  -- empty colocation anchor, never queried
  app.citus_table_kind(t regclass) RETURNS text       -- 'reference' | 'hash:<column>' | 'local' | 'other' | NULL (no citus)
  app.distribute_by_tenant(t regclass) RETURNS void   -- hash on tenant_id, colocated with app.tenant_colocation
  app.distribute_by_user(t regclass) RETURNS void     -- hash on user_id, colocated with the first user-distributed table
  app.make_reference(t regclass) RETURNS void         -- create_reference_table
  ```
  All four procedures return immediately without the extension, return immediately when the table already has the
  requested kind, and raise `… already a Citus table of another kind (<kind>)` / `… already distributed (<kind>)`
  on a kind change. A missing table fails at the `regclass` cast, on plain Postgres too.
- `runMigrations(url, options)`: unchanged signature. After taking the advisory lock, when
  `select exists (select 1 from pg_extension where extname = 'citus')` is true, it runs
  `set citus.enable_local_execution to on`, then `set citus.multi_shard_modify_mode to 'sequential'` on its private
  `max: 1` session and logs
  `Citus detected: migration session uses local execution and sequential shard modification`. Local execution keeps
  a fresh database's `0000_init` + `distribute` files working on a `localExecution: false` server (B3-6 RLS
  specs); sequential mode is what a multi-node cluster needs (plan review, probe d). The migration URL must point
  at the coordinator directly, never at a pooler (enforced later by SH-9).
- Compose `postgres` service: `image: citusdata/citus:14.2.0`, `platform: linux/amd64`,
  `shared_preload_libraries=citus,pg_stat_statements`, `citus.shard_count=8`, `citus.max_shared_pool_size=180`; the
  init folder runs `00-citus.sql` (`CREATE EXTENSION IF NOT EXISTS citus;`) before `01-extensions.sql`. B3-2's role
  SQL goes in the same folder as `02-…`. Service name, port knob `POSTGRES_HOST_PORT`, volume and healthcheck are
  unchanged (E's `check-topology.ts` contract holds).

## Tasks

### Task 1: SH-1 `@platform/testing/postgres`: `startTestPostgres` on the Citus image

Today each Postgres int spec inlines the same Testcontainers block on `postgres:18.6-alpine3.24`
(`libs/database/test/database.int-spec.ts:38,121-133`,
`domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts:35,123-133`,
`domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts:29,75-85`). This task replaces the
three with one test-only helper on `citusdata/citus:14.2.0` (P-13: Testcontainers 12.2.0 starts it, honours
`-c citus.shard_count=4 -c citus.enable_local_execution=off`). The design's `workers` option waits for SH-11.

**Files:**

- Create: `libs/testing/src/postgres/start-test-postgres.ts`, `libs/testing/src/postgres/index.ts`
- Test: `libs/testing/src/postgres/start-test-postgres.spec.ts` (unit), `libs/testing/src/postgres/start-test-postgres.int-spec.ts` (int)
- Modify: `libs/testing/package.json`, `libs/testing/README.md`, `libs/database/package.json:38-42`,
  `domains/identity/package.json:64`, `domains/billing/package.json:57`
- Modify (specs): `libs/database/test/database.int-spec.ts:9,33-38,98-102,121-133`,
  `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts:14,26-35,105-140,170-176`,
  `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts:14,21-29,62-90,121-126`
- Modify (docs): `docs/TESTING.md:16,26,86-105,240-253`, `libs/database/README.md:138`

**Interfaces:**

- Consumes: `PostgreSqlContainer` from `@testcontainers/postgresql` 12.2.0 (`withDatabase`, `withUsername`,
  `withPassword`, `withCommand`, `withPlatform`, `start`, `getConnectionUri()`), `postgres` 3.4.9
  (`unsafe(text).simple()`).
- Produces: the `@platform/testing/postgres` contract in "Interface contracts" above (exact signatures).

**Wave:** start now (lane `s0`, first task).

- [ ] **Step 1: Write the failing unit spec.** Create `libs/testing/src/postgres/start-test-postgres.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startTestPostgres,
  TEST_POSTGRES_IMAGE,
  testPostgresCommand,
  urlWithLogin,
} from './start-test-postgres.js';

const fake = vi.hoisted(() => ({ executed: [] as string[], urls: [] as string[] }));

vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: vi.fn(function PostgreSqlContainer(image: string) {
    throw new Error(`unit specs never start a container (${image})`);
  }),
}));

vi.mock('postgres', () => ({
  default: vi.fn((url: string) => {
    fake.urls.push(url);
    return {
      unsafe: (text: string) => ({
        simple: async () => {
          fake.executed.push(text);
          return [];
        },
      }),
      end: async () => undefined,
    };
  }),
}));

const EXTERNAL = 'postgres://owner:secret@db.internal:6543/scratch';

describe('@platform/testing/postgres', () => {
  beforeEach(() => {
    fake.executed.length = 0;
    fake.urls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins the Citus 14.2 image the sharding design probed', () => {
    expect(TEST_POSTGRES_IMAGE).toBe('citusdata/citus:14.2.0');
  });

  it.each([
    [undefined, 'on'],
    [true, 'on'],
    [false, 'off'],
  ])('starts postgres with 4 shards; localExecution %s → %s', (localExecution, expected) => {
    expect(testPostgresCommand({ localExecution })).toEqual([
      'postgres',
      '-c',
      'citus.shard_count=4',
      '-c',
      `citus.enable_local_execution=${expected}`,
    ]);
  });

  it('urlWithLogin swaps only the login and percent-encodes it, so postgres.js decodes it back', () => {
    const password = 'p@ss:w/rd%41 é#?';
    const parsed = new URL(urlWithLogin(EXTERNAL, 'app_runtime', password));
    expect(decodeURIComponent(parsed.username)).toBe('app_runtime');
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).toBe(
      'postgres://db.internal:6543/scratch',
    );
  });

  it('uses INTEGRATION_DATABASE_URL without a container and runs initSql there, in order', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    const pg = await startTestPostgres({
      localExecution: false,
      initSql: ['create role a', 'create role b; create role c'],
    });
    expect(pg.url).toBe(EXTERNAL);
    expect(fake.urls).toEqual([EXTERNAL]);
    expect(fake.executed).toEqual(['create role a', 'create role b; create role c']);
    expect(decodeURIComponent(new URL(pg.urlFor('app_system', 's3cret')).username)).toBe(
      'app_system',
    );
    await expect(pg.stop()).resolves.toBeUndefined();
    await expect(pg.stop()).resolves.toBeUndefined();
  });

  it('does not connect at all for INTEGRATION_DATABASE_URL without initSql', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres()).resolves.toMatchObject({ url: EXTERNAL });
    expect(fake.urls).toEqual([]);
  });

  it('starts a container when allowExternalUrl is false, or when the variable is empty', async () => {
    vi.stubEnv('INTEGRATION_DATABASE_URL', EXTERNAL);
    await expect(startTestPostgres({ allowExternalUrl: false })).rejects.toThrow(
      'unit specs never start a container (citusdata/citus:14.2.0)',
    );
    vi.stubEnv('INTEGRATION_DATABASE_URL', '');
    await expect(startTestPostgres()).rejects.toThrow('unit specs never start a container');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**
      `npx vitest run --project testing src/postgres/start-test-postgres.spec.ts`
      Expected: FAIL, `Test Files 1 failed`, `Tests no tests`, with
      `Error: Cannot find module '/src/postgres/start-test-postgres.js' imported from …/start-test-postgres.spec.ts`
      (the module does not exist yet; Vitest 5.0.3 output, review run 2026-11-10).

- [ ] **Step 3: Implement.** Create `libs/testing/src/postgres/start-test-postgres.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

/**
 * PostgreSQL 18.4 + Citus 14.2.0, the image the sharding design probed. amd64 only: on Apple Silicon
 * Docker Desktop runs it under emulation (pull it once: `docker pull --platform linux/amd64 <image>`).
 */
export const TEST_POSTGRES_IMAGE = 'citusdata/citus:14.2.0';
/** Shards per distributed table in specs. Citus' default is 32; fewer shards are faster to create. */
export const TEST_POSTGRES_SHARD_COUNT = 4;

export interface TestPostgresOptions {
  /**
   * `false` sets `citus.enable_local_execution=off`: even on one node, shard queries then go through
   * remote connections, so a setting that does not propagate to workers fails as it would on a
   * cluster (RLS specs). Default `true`, Citus' default. Not applied with `INTEGRATION_DATABASE_URL`.
   */
  localExecution?: boolean;
  /**
   * SQL run in order, as the container superuser, before `startTestPostgres` resolves (for example
   * B3's shared role script). An entry may hold several statements (simple protocol).
   */
  initSql?: readonly string[];
  /** Use `INTEGRATION_DATABASE_URL`, when set and not empty, instead of a container. Default `true`. */
  allowExternalUrl?: boolean;
}

export interface TestPostgres {
  /** Superuser URL of database `app` (user and password `app` in a container). */
  readonly url: string;
  /** `url` with another login, percent-encoded, for the roles that `initSql` creates. */
  urlFor(role: string, password: string): string;
  /** Stops the container; a no-op for `INTEGRATION_DATABASE_URL`. Safe to call twice. */
  stop(): Promise<void>;
}

/** The server command: Citus' shard count for specs and the local-execution switch. */
export function testPostgresCommand(
  options: Pick<TestPostgresOptions, 'localExecution'> = {},
): string[] {
  const localExecution = options.localExecution === false ? 'off' : 'on';
  return [
    'postgres',
    '-c',
    `citus.shard_count=${TEST_POSTGRES_SHARD_COUNT}`,
    '-c',
    `citus.enable_local_execution=${localExecution}`,
  ];
}

/**
 * `url` with `role` / `password` as its login. The URL setters leave `%` alone, so each part is
 * `encodeURIComponent`-ed first; postgres.js decodes both (`decodeURIComponent`) when it connects.
 */
export function urlWithLogin(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** Checks the container really has Citus, then runs `initSql`; connects only when there is work. */
async function prepareDatabase(
  url: string,
  initSql: readonly string[],
  requireCitus: boolean,
): Promise<void> {
  if (!requireCitus && initSql.length === 0) return;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    if (requireCitus) {
      const [row] = await sql<{ version: string | null }[]>`
        select (select extversion from pg_extension where extname = 'citus') as version`;
      if (!row?.version) {
        throw new Error(
          `${TEST_POSTGRES_IMAGE} started without the citus extension in database app`,
        );
      }
    }
    for (const statement of initSql) await sql.unsafe(statement).simple();
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A Postgres for one int spec: a fresh single-node Citus container (database, user and password
 * `app`), or the database at `INTEGRATION_DATABASE_URL` when that is set. The container's
 * healthcheck probes TCP, which the init-time server does not listen on, so it is ready only after
 * the image's init script created the extension (design P-14 note).
 */
export async function startTestPostgres(options: TestPostgresOptions = {}): Promise<TestPostgres> {
  const external =
    options.allowExternalUrl === false ? undefined : process.env['INTEGRATION_DATABASE_URL'];
  let container: StartedPostgreSqlContainer | undefined;
  let url: string;
  if (external !== undefined && external !== '') {
    url = external;
  } else {
    container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
      .withPlatform('linux/amd64')
      .withDatabase('app')
      .withUsername('app')
      .withPassword('app')
      .withCommand(testPostgresCommand(options))
      .start();
    url = container.getConnectionUri();
  }
  try {
    await prepareDatabase(url, options.initSql ?? [], container !== undefined);
  } catch (error) {
    await container?.stop();
    throw error;
  }
  let stopped = false;
  return {
    url,
    urlFor: (role, password) => urlWithLogin(url, role, password),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await container?.stop();
    },
  };
}
```

Create `libs/testing/src/postgres/index.ts`:

```ts
/**
 * @platform/testing/postgres: a Postgres (Citus 14.2, single node) per integration spec. A separate
 * subpath so that specs which only need `createMock` never load testcontainers. Test code only.
 */
export * from './start-test-postgres.js';
```

Replace `libs/testing/package.json` with:

```json
{
  "name": "@platform/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Test helpers: Fastify e2e app factory, Proxy-based Vitest auto mocks, Citus test containers.",
  "exports": {
    ".": {
      "@repo/source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./postgres": {
      "@repo/source": "./src/postgres/index.ts",
      "types": "./src/postgres/index.ts",
      "default": "./dist/postgres/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "swc src -d dist --config-file ../../.swcrc --cli-config-file ../../swc.cli.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --config ../../vitest.config.ts --project testing",
    "clean": "rimraf dist coverage"
  },
  "dependencies": {
    "@nestjs/common": "catalog:",
    "@nestjs/core": "catalog:",
    "@nestjs/platform-fastify": "catalog:",
    "@nestjs/testing": "catalog:",
    "@testcontainers/postgresql": "catalog:",
    "postgres": "catalog:",
    "reflect-metadata": "catalog:",
    "rxjs": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 4: Run the unit spec, expect PASS.**
      `npx vitest run --project testing src/postgres/start-test-postgres.spec.ts`
      Expected: PASS, 8 tests (1 + 3 `it.each` + 4).

- [ ] **Step 5: Write the int spec.** Create `libs/testing/src/postgres/start-test-postgres.int-spec.ts`:

```ts
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './start-test-postgres.js';

/*
 * The Citus test container itself. Opt-in (needs Docker; amd64 image, emulated on Apple Silicon):
 *   INTEGRATION=1 bunx vitest run --project testing:int
 */

const TENANT = '0190f3a0-0000-7000-8000-000000000001';
const READER_PASSWORD = 'p@ss:w/rd%41 é';

/** The notices of one router query on a distributed table, with Citus' command log on. */
async function routerQueryNotices(sql: Sql, notices: string[]): Promise<string[]> {
  await sql`create table if not exists probe_accounts (tenant_id uuid primary key)`;
  await sql`
    select create_distributed_table('probe_accounts', 'tenant_id')
    where not exists (
      select 1 from pg_dist_partition where logicalrelid = 'probe_accounts'::regclass)`;
  notices.length = 0;
  await sql`set citus.log_remote_commands = on`;
  await sql`select count(*) from probe_accounts where tenant_id = ${TENANT}`;
  await sql`reset citus.log_remote_commands`;
  return [...notices];
}

const connect = (url: string, notices: string[]): Sql =>
  postgres(url, {
    max: 1,
    onnotice: (notice) => {
      notices.push(notice['message'] ?? '');
    },
  });

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'startTestPostgres on citusdata/citus:14.2.0',
  () => {
    describe('defaults', () => {
      let pg: TestPostgres | undefined;
      let sql: Sql;
      const notices: string[] = [];

      beforeAll(async () => {
        pg = await startTestPostgres({
          allowExternalUrl: false,
          initSql: [
            `create role probe_reader login password '${READER_PASSWORD}'`,
            'create table init_marker (id int); insert into init_marker values (1)',
          ],
        });
        sql = connect(pg.url, notices);
      });

      afterAll(async () => {
        await sql?.end({ timeout: 5 });
        await pg?.stop();
        await pg?.stop(); // idempotent
      });

      it('runs Citus 14.2 on PostgreSQL 18 with 4 shards and local execution on', async () => {
        const [row] = await sql<{ citus: string; pg: number; shards: string; local: string }[]>`
        select citus_version() as citus, current_setting('server_version_num')::int as pg,
          current_setting('citus.shard_count') as shards,
          current_setting('citus.enable_local_execution') as local`;
        expect(row?.citus).toMatch(/^Citus 14\.2\./);
        expect(row?.pg).toBeGreaterThanOrEqual(180_000);
        expect(row).toMatchObject({ shards: '4', local: 'on' });
      });

      it('executes a router query on the local shard', async () => {
        const logged = await routerQueryNotices(sql, notices);
        expect(logged.some((message) => message.startsWith('executing the command locally'))).toBe(
          true,
        );
        expect(logged.some((message) => message.startsWith('issuing '))).toBe(false);
      });

      it('ran every initSql entry as the superuser, multi-statement entries included', async () => {
        const [row] = await sql<
          { count: number }[]
        >`select count(*)::int as count from init_marker`;
        expect(row?.count).toBe(1);
      });

      it('urlFor logs in as another role with URL-reserved characters in the password', async () => {
        const reader = postgres(pg!.urlFor('probe_reader', READER_PASSWORD), { max: 1 });
        try {
          const [row] = await reader<{ name: string }[]>`select current_user as name`;
          expect(row?.name).toBe('probe_reader');
        } finally {
          await reader.end({ timeout: 5 });
        }
      });
    });

    describe('localExecution: false', () => {
      let pg: TestPostgres | undefined;
      let sql: Sql;
      const notices: string[] = [];

      beforeAll(async () => {
        pg = await startTestPostgres({ allowExternalUrl: false, localExecution: false });
        sql = connect(pg.url, notices);
      });

      afterAll(async () => {
        await sql?.end({ timeout: 5 });
        await pg?.stop();
      });

      it('sends shard queries over connections even on one node', async () => {
        const [row] = await sql<{ local: string }[]>`
        select current_setting('citus.enable_local_execution') as local`;
        expect(row?.local).toBe('off');
        const logged = await routerQueryNotices(sql, notices);
        expect(logged.some((message) => message.startsWith('issuing '))).toBe(true);
        expect(logged.some((message) => message.startsWith('executing the command locally'))).toBe(
          false,
        );
      });
    });
  },
);
```

- [ ] **Step 6: Run the int spec (sandbox off, Docker), expect PASS.**
      `docker pull --platform linux/amd64 citusdata/citus:14.2.0 && INTEGRATION=1 npx vitest run --project testing:int`
      Expected: PASS, 5 tests (about 35 s on an emulated Mac), two containers started and removed
      (`docker ps -a --filter ancestor=citusdata/citus:14.2.0` is empty afterwards). If the `localExecution: false` test fails with an authentication error, the
      coordinator's loopback connection was refused: the official image's `pg_hba.conf` trusts `127.0.0.1/32` and
      `::1/128` (initdb defaults); check `docker exec <container> cat /var/lib/postgresql/18/docker/pg_hba.conf` and
      report instead of weakening the test.

- [ ] **Step 7: Move the three inline helpers onto `startTestPostgres`.**
  - `libs/database/package.json`: in `devDependencies` replace `"@testcontainers/postgresql": "catalog:",` with
    `"@platform/testing": "workspace:*",`.
  - `domains/identity/package.json` and `domains/billing/package.json`: delete the line
    `"@testcontainers/postgresql": "catalog:",` (both already list `"@platform/testing": "workspace:*"`).
  - Run `bun install` in the worktree now, sandbox off (the workspace graph changed; no new version, so the lock
    changes only in its `workspaces` section). Expected: exit 0 and `git diff --stat bun.lock` shows a few lines.
    The resulting `bun.lock` goes into this task's commit. (Steps 4 and 6 already pass before it: the root
    `node_modules` is hoisted, `bunfig.toml` `linker = "hoisted"`, so both packages resolve.)
  - `libs/database/test/database.int-spec.ts`:
    - replace `import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';`
      with `import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';`
    - replace the comment and constant
      ```text
      /*
       * Real Postgres 18 (uuidv7() is PG18-native) via testcontainers. Opt-in:
       *   INTEGRATION=1 bunx vitest run --project database:int
       */

      const IMAGE = 'postgres:18.6-alpine3.24';
      ```
      with
      ```text
      /*
       * Real Postgres 18 (uuidv7() is PG18-native) with Citus 14.2, via @platform/testing/postgres. The
       * databases this spec creates have no citus extension, so they behave as plain Postgres. Opt-in:
       *   INTEGRATION=1 bunx vitest run --project database:int
       */
      ```
    - replace `  let container: StartedPostgreSqlContainer;` with `  let pg: TestPostgres;`
    - replace `    const url = new URL(container.getConnectionUri());` with `    const url = new URL(pg.url);`
    - replace
      ```text
          container = await new PostgreSqlContainer(IMAGE)
            .withDatabase('app')
            .withUsername('app')
            .withPassword('app')
            .start();
          admin = postgres(container.getConnectionUri(), { max: 1, onnotice: noop });
      ```
      with
      ```text
          // Never INTEGRATION_DATABASE_URL: this spec creates databases (race, sets, …) on the server.
          pg = await startTestPostgres({ allowExternalUrl: false });
          admin = postgres(pg.url, { max: 1, onnotice: noop });
      ```
    - replace `    await container?.stop();` with `    await pg?.stop();`
  - `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts` and
    `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts` (identical blocks in both):
    - replace the `@testcontainers/postgresql` import line with
      `import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';`
    - after the line ` * Set INTEGRATION_DATABASE_URL to use an existing throwaway database instead of testcontainers.`
      insert ` * The container is Citus 14.2 on PostgreSQL 18, single node (@platform/testing/postgres).`
    - delete `const IMAGE = 'postgres:18.6-alpine3.24';` and the blank line after it
    - replace `  let container: StartedPostgreSqlContainer | undefined;` with `  let pg: TestPostgres | undefined;`
    - replace
      ```text
          let url = process.env['INTEGRATION_DATABASE_URL'];
          if (url === undefined) {
            container = await new PostgreSqlContainer(IMAGE)
              .withDatabase('app')
              .withUsername('app')
              .withPassword('app')
              .start();
            url = container.getConnectionUri();
          }
          vi.stubEnv('DATABASE_URL', url);
      ```
      with
      ```text
          pg = await startTestPostgres();
          vi.stubEnv('DATABASE_URL', pg.url);
      ```
    - replace `    await container?.stop();` with `    await pg?.stop();`
    - in the "puts no table … in public" test, replace
      ```text
            select table_name as name from information_schema.tables where table_schema = 'public'`);
      ```
      with
      ```text
            select table_name as name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE'`);
      ```
      and after the comment line `    // (search_path "$user", public), where the first test's lists catch it.` insert
      `    // Citus adds its views (citus_tables, citus_shards, …) to public: views are not tables.`
  - `npx biome check --write libs/testing libs/database/test/database.int-spec.ts domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts libs/database/package.json domains/identity/package.json domains/billing/package.json`
    (it re-sorts the imports).

- [ ] **Step 8: Run the moved int specs (sandbox off), one project at a time, expect PASS.**
  - `INTEGRATION=1 npx vitest run --project database:int` → Expected: PASS, 16 tests, as before (every
    `runMigrations`/CLI/boot test now runs on databases created inside the Citus container).
  - `INTEGRATION=1 npx vitest run --project identity:int` → Expected: PASS, 15 tests.
  - `INTEGRATION=1 npx vitest run --project billing:int` → Expected: PASS, 6 tests.
  - If `create database …` in `database.int-spec.ts` fails on the coordinator, report the exact Citus error
    (Citus 14 creates databases locally while `citus.enable_create_database_propagation` is off); do not switch
    that spec back to the alpine image.

- [ ] **Step 9: Docs.**
  - `docs/TESTING.md`:
    - `:16` mermaid node: `real Postgres 18 / Redis` → `real Postgres 18 + Citus / Redis`.
    - `:26` pyramid row "Integration", column "What is real": `Postgres 18 (testcontainers) or Redis` →
      `Postgres 18 + Citus 14.2 (testcontainers, single node) or Redis`.
    - Toolbox table (`:86-105`): add after the `createMock<T>(overrides?)` row the row
      ```text
      | `startTestPostgres(options?)` | `@platform/testing/postgres` | A fresh single-node Citus 14.2 container per int spec (`url`, `urlFor(role, password)`, `stop()`); `localExecution: false` forces remote shard execution; `initSql` runs as superuser; honours `INTEGRATION_DATABASE_URL` |
      ```
    - Integration table (`:240-245`), "Needs" cells. In the `database:int` row replace
      ```text
      Docker (testcontainers `postgres:18.6-alpine3.24`)
      ```
      with
      ```text
      Docker (`@platform/testing/postgres`: `citusdata/citus:14.2.0`)
      ```
      and in the `identity:int` and `billing:int` rows replace (rest of the cell unchanged)
      ```text
      Docker (testcontainers), **or**
      ```
      with
      ```text
      Docker (`@platform/testing/postgres`: Citus), **or**
      ```
      Add after the `database:int` row:
      ```text
      | [`libs/testing/src/postgres/start-test-postgres.int-spec.ts`](../libs/testing/src/postgres/start-test-postgres.int-spec.ts) | `testing:int` | Docker (`@platform/testing/postgres`) | the Citus test container: version, shard count, local vs remote execution (`localExecution`), `initSql`, `urlFor` logins with URL-reserved characters |
      ```
    - After the command block that ends with `INTEGRATION=1 bunx vitest run --project database:int   # just one`
      (and its closing fence), insert:
      ```markdown
      Postgres in every int spec is **Citus 14.2 on PostgreSQL 18.4, single node** (`citusdata/citus:14.2.0`, the
      image compose runs). The image is amd64-only: on Apple Silicon, Docker Desktop runs it under emulation
      (Rosetta), and a container starts in about 15 s. Pull it once before the first run
      (`docker pull --platform linux/amd64 citusdata/citus:14.2.0`), and run one `*:int` project at a time if a
      `beforeAll` hits the 180 s hook timeout. `startTestPostgres({ localExecution: false })` makes even one node
      send shard queries over connections, so a setting that would not reach a worker fails in the spec too.
      ```
  - `libs/testing/README.md`:
    - first paragraph: replace
      ```text
      package** (so any package can use it without dependency cycles) and pulls in `vitest` — import it only
      from `*.spec.ts`, `*.e2e-spec.ts` and `test/**`.
      ```
      with
      ```text
      package** (so any package can use it without dependency cycles) and pulls in `vitest` (and, through the
      `./postgres` subpath only, testcontainers and postgres.js) — import it only from `*.spec.ts`,
      `*.int-spec.ts`, `*.e2e-spec.ts` and `test/**`.
      ```
    - right before `## Usage`, insert
      ```markdown
      ### @platform/testing/postgres

      | Export                | Signature                                                                               | Purpose                                                                                         |
      | --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
      | `startTestPostgres`   | `(options?: TestPostgresOptions) => Promise<TestPostgres>`                              | a fresh single-node Citus container per int spec, or the database at `INTEGRATION_DATABASE_URL` |
      | `TestPostgresOptions` | `{ localExecution?: boolean; initSql?: readonly string[]; allowExternalUrl?: boolean }` | `localExecution: false` forces remote shard execution; `initSql` runs as superuser              |
      | `TestPostgres`        | `{ readonly url: string; urlFor(role, password): string; stop(): Promise<void> }`       | superuser URL of database `app`; percent-encoded logins for other roles                         |
      | `TEST_POSTGRES_IMAGE` | `'citusdata/citus:14.2.0'`                                                              | the image compose runs too                                                                      |
      ```
    - in `## Environment variables`, replace `None.` with
      ```text
      `INTEGRATION_DATABASE_URL`: read by `startTestPostgres` only (unless `allowExternalUrl: false`); when set and
      not empty, that database is used instead of a container.
      ```
    - append to `## Gotchas`
      ```text
      - `citusdata/citus:14.2.0` is amd64-only: Docker Desktop emulates it on Apple Silicon, so pull it once
        before the first int run (`docker pull --platform linux/amd64 citusdata/citus:14.2.0`).
      ```
  - `libs/database/README.md` (`:138-139`, one sentence wrapped over two lines): replace
    ```text
    uses `postgres:18.6-alpine3.24` through
      testcontainers.
    ```
    with
    ```text
    uses `startTestPostgres()` from
      `@platform/testing/postgres` (Citus 14.2 on PostgreSQL 18.4; the databases it creates have no `citus`
      extension, so they are plain Postgres).
    ```
  - `npx prettier --write docs/TESTING.md libs/testing/README.md libs/database/README.md`

- [ ] **Step 10: Wider checks.**
      `npx vitest run --project testing --project database --project identity --project billing && bun run --filter @platform/testing build && bun run check`
      Expected: all unit projects PASS; `libs/testing/dist/postgres/index.js` exists; `bun run check` ends with
      `Layer boundaries OK (26 packages: apps -> domains -> contracts -> libs).`

- [ ] **Step 11: Commit.**

```bash
printf '%s\n' "test(testing,database,identity,billing): add startTestPostgres and run int specs on Citus" | bunx commitlint
git add libs/testing/package.json libs/testing/README.md libs/testing/src/postgres \
  libs/database/package.json libs/database/README.md libs/database/test/database.int-spec.ts \
  domains/identity/package.json domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts \
  domains/billing/package.json domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts \
  docs/TESTING.md bun.lock
git commit -S -m "test(testing,database,identity,billing): add startTestPostgres and run int specs on Citus" \
  -m "SH-1. @platform/testing/postgres starts a single-node citusdata/citus:14.2.0 container (4 shards,
localExecution switch, initSql, urlFor) or uses INTEGRATION_DATABASE_URL. The three inline
postgres:18.6-alpine helpers move onto it; the public-table checks ignore Citus' views."
```

### Task 2: SH-2 Compose and CI on Citus single node

The compose `postgres` service swaps `postgres:18.6-alpine3.24` for `citusdata/citus:14.2.0` and keeps its name,
port knob, volume and healthcheck. Two traps, both verified upstream: the image's `postgresql.conf.sample` sets
`shared_preload_libraries='citus'`, which our `-c shared_preload_libraries=pg_stat_statements` would override; and
our init-dir mount hides the image's `001-create-citus-extension.sql`. Single node needs no other setup [P-11].

**Files:**

- Create: `docker/postgres/init/00-citus.sql`
- Modify: `docker-compose.yml:144-205` (service `postgres`), `docker/postgres/init/01-extensions.sql:5`,
  `scripts/docker/check-infra.sh:73-81`, `.github/workflows/ci.yml:102-136` (job `integration`, lines at `13030b0`)
- Modify (docs): `docs/DOCKER.md:35` (stack map), end of "Bootstrap jobs & migrations" (`:196-226`), "Gotchas"
  (`:444-469`)
- Test: `scripts/docker/validate-compose.sh` and `scripts/docker/check-infra.sh` (real run)

**Interfaces:**

- Consumes: nothing from Task 1 at runtime (compose is independent of the specs).
- Produces: the compose `postgres` contract in "Interface contracts" (image, `platform`, preload string, Citus
  `-c` flags, `00-citus.sql`). E's `check-topology.ts` needs no change: same service, healthcheck and
  `POSTGRES_HOST_PORT` knob.

**Wave:** after Task 1 (lane `s0`).

- [ ] **Step 1: Write the failing check.** In `scripts/docker/check-infra.sh`, replace the block

```bash
log "postgres: extensions + native uuidv7()"
exts="$(compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc \
  "select string_agg(extname, ',' order by extname) from pg_extension")"
for ext in pg_stat_statements pg_trgm; do
  [[ ",${exts}," == *",${ext},"* ]] || fail "extension ${ext} missing (have: ${exts})"
done
version="$(compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc \
  "select current_setting('server_version') || ' uuidv7=' || uuidv7()")"
echo "  extensions: ${exts}; ${version}"
```

with

```bash
log "postgres: Citus single node, extensions + native uuidv7()"
psql_app() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc "$1"
}
preload="$(psql_app "show shared_preload_libraries")"
[[ "${preload}" == citus,* ]] || fail "shared_preload_libraries must start with citus (have: ${preload})"
exts="$(psql_app "select string_agg(extname, ',' order by extname) from pg_extension")"
for ext in citus pg_stat_statements pg_trgm; do
  [[ ",${exts}," == *",${ext},"* ]] || fail "extension ${ext} missing (have: ${exts})"
done
version="$(psql_app "select current_setting('server_version') || ' uuidv7=' || uuidv7() \
  || ' shard_count=' || current_setting('citus.shard_count') || ' ' || citus_version()")"
echo "  preload: ${preload}; extensions: ${exts}; ${version}"
```

- [ ] **Step 2: Run it against the unchanged compose file, expect FAIL** (sandbox off, isolated project, ports +30000):

```bash
PROJECT=s0-infra-check POSTGRES_HOST_PORT=35432 REDIS_HOST_PORT=36379 CASSANDRA_HOST_PORT=39042 \
  KAFKA_HOST_PORT=39094 MAILPIT_SMTP_HOST_PORT=31025 MAILPIT_UI_HOST_PORT=38025 S3_HOST_PORT=39000 \
  S3_CONSOLE_HOST_PORT=39001 GCS_HOST_PORT=34443 scripts/docker/check-infra.sh
```

Expected: `[check-infra] FAIL: shared_preload_libraries must start with citus (have: pg_stat_statements)`, then the
script's trap tears the `s0-infra-check` project down (`docker compose ls -a | rg s0-infra-check` prints nothing).
This red run boots the whole infra stack (Cassandra, Kafka, …) before the Postgres assertion: 3-5 minutes on an
emulated Mac, so do not abort it as hung.

- [ ] **Step 3: Implement.**
  - Create `docker/postgres/init/00-citus.sql`:
    ```sql
    -- Runs ONCE, on an empty data directory only (docker-entrypoint-initdb.d semantics), before
    -- 01-extensions.sql (the entrypoint runs the files in name order).
    -- citusdata/citus ships its own /docker-entrypoint-initdb.d/001-create-citus-extension.sql, but
    -- docker-compose.yml mounts this folder over that directory, so the extension is created here.
    -- Single node needs no other setup: the first create_distributed_table registers this server as
    -- the node that holds every shard (sharding design, P-11).
    CREATE EXTENSION IF NOT EXISTS citus;
    ```
  - `docker/postgres/init/01-extensions.sql`: replace
    `-- Query statistics (needs shared_preload_libraries=pg_stat_statements, set in docker-compose.yml).` with
    `-- Query statistics (needs pg_stat_statements in shared_preload_libraries, after citus; docker-compose.yml).`
  - `docker-compose.yml`, service `postgres`: replace
    ```text
      postgres:
        image: postgres:18.6-alpine3.24
        restart: unless-stopped
    ```
    with
    ```text
      postgres:
        # Citus 14.2 on PostgreSQL 18.4 (Debian), single node: this coordinator holds every shard.
        # amd64-only image: Apple Silicon runs it under emulation; `platform` makes that explicit.
        # docker/postgres/init/00-citus.sql creates the extension (this mount hides the image's script).
        image: citusdata/citus:14.2.0
        platform: linux/amd64
        restart: unless-stopped
    ```
    and in its `command`, replace
    ```text
          - -c
          - shared_preload_libraries=pg_stat_statements
    ```
    with
    ```text
          - -c
          - shared_preload_libraries=citus,pg_stat_statements # citus must come first
          - -c
          - citus.shard_count=8 # shards per distributed table; fixed when a colocation group is created
          - -c
          - citus.max_shared_pool_size=180 # max_connections - 20: bursts to shards queue, not fail
    ```
    Nothing else changes: `POSTGRES_*` env, `POSTGRES_HOST_PORT`, volume `pg-data:/var/lib/postgresql` (PG 18
    images keep `PGDATA` under `18/docker` on Debian too), the TCP `pg_isready` healthcheck (it overrides the
    image's `HEALTHCHECK`) and the 512 MB limit.
  - `.github/workflows/ci.yml`, job `integration`: replace the comment
    ```text
        # Postgres comes from testcontainers (Docker is available on the runner); the Redis specs use
        # REDIS_URL, served by this service container.
    ```
    with
    ```text
        # Postgres comes from testcontainers (@platform/testing/postgres: citusdata/citus:14.2.0, single
        # node, amd64 like the runner); the Redis specs use REDIS_URL, served by this service container.
    ```
    and insert before the step `- name: Integration tests (INTEGRATION=1, testcontainers + service containers)`:
    ```text
          # Every Postgres int project starts its own container in parallel: pull the image once first,
          # so no beforeAll spends its 180 s hook timeout on the download.
          - name: Pull the Citus image of the Postgres int specs
            run: docker pull citusdata/citus:14.2.0
    ```
  - `npx prettier --write docker-compose.yml .github/workflows/ci.yml`

- [ ] **Step 4: Validate the compose file, expect PASS.** `scripts/docker/validate-compose.sh`
      Expected: every profile combination renders, exactly one `api` alias, exit 0 (profiles are unchanged).

- [ ] **Step 5: Run the infra check again (sandbox off), expect PASS.** Same command as Step 2.
      Expected, among the usual lines:
      `preload: citus,pg_stat_statements; extensions: citus,pg_stat_statements,pg_trgm,plpgsql; 18.4 … uuidv7=… shard_count=8 Citus 14.2.0 on x86_64-pc-linux-gnu, …`
      and `[check-infra] OK: infra stack verified in …s`, then the project is removed. On Apple Silicon the first
      boot is slower (emulated initdb); the default `WAIT_TIMEOUT=420` covers it. If `postgres` is OOM-killed
      under the 512 MB limit, report the `docker compose stats` line instead of raising the limit silently.

- [ ] **Step 6: Docs.**
  - `docs/DOCKER.md` stack map (`:35`): the `postgres` row becomes
    ```text
    | `postgres` | `citusdata/citus:14.2.0` (PostgreSQL 18.4, amd64) | 5432 | — | identity + billing (Drizzle), Citus single node, db/user/pw `app` |
    ```
  - `docs/DOCKER.md`, at the end of "Bootstrap jobs & migrations" (right before `## Images (Dockerfile)`), add:
    ```markdown
    ### Postgres runs Citus

    `postgres` is `citusdata/citus:14.2.0`: PostgreSQL 18.4 with the Citus 14.2 extension, as **one node** that
    holds every shard (no workers, no setup). `docker/postgres/init/00-citus.sql` creates the extension on a fresh
    volume, `shared_preload_libraries` starts with `citus`, and `citus.shard_count=8` sets the shards per
    distributed table. Tables stay ordinary until a domain's `distribute` migration calls the platform helpers
    (see [DEVELOPMENT.md](DEVELOPMENT.md#citus-ready-schema-rules)). `scripts/docker/check-infra.sh` fails when
    the extension or the preload is missing.

    **Existing volumes.** The init folder runs only on an empty data directory, so a `pg-data` volume created by
    the old `postgres:18.6-alpine3.24` image has no `citus` extension, and the switch from Alpine (musl) to
    Debian (glibc) changes the collation library under existing text indexes. Recreate the volume (this deletes
    the local database; migrations rebuild the schema at the next app boot):

    `docker compose stop postgres && docker compose rm -f postgres && docker volume rm boilerplate_pg-data && docker compose up -d --wait`

    (`boilerplate` is the compose project name, `docker-compose.yml:21`; with another `COMPOSE_PROJECT_NAME` the
    volume is `<project>_pg-data`.)
    ```
  - `docs/DOCKER.md` "Gotchas" is a numbered list (items 1-14 at `13030b0`); append two items with the next
    numbers (15 and 16, or later if another lane appended first):
    ```markdown
    15. **Citus is amd64-only.** Every `citusdata/citus:14.2*` tag is built for amd64; on Apple Silicon Docker
        Desktop runs `postgres` (and the int-spec containers) under emulation, with Rosetta when it is enabled.
        Expect slower first boots; nothing else differs. CI runners are amd64.
    16. **The init-folder mount hides image init scripts.** `./docker/postgres/init` replaces the image's
        `/docker-entrypoint-initdb.d`, so anything the image would run there must be in our folder (that is why
        `00-citus.sql` exists).
    ```
  - `docs/DOCKER.md`, the `check-infra.sh` paragraph at the end of "Bootstrap jobs & migrations" (`:222-223`):
    replace
    ```text
    keyspace + DC, extensions + `uuidv7()`
    ```
    with
    ```text
    keyspace + DC, Citus + extensions + `uuidv7()`
    ```
    (the sentence is otherwise unchanged; CI runs this script in its `infra` job, `ci.yml:187`).
  - `npx prettier --write docs/DOCKER.md`

- [ ] **Step 7: Wider checks.** `bun run check`
      Expected: ends with `Layer boundaries OK (26 packages: apps -> domains -> contracts -> libs).` (Prettier
      checks the YAML and Markdown.) If E Task 2 has already merged, also run `node scripts/check-env-example.mjs`:
      Expected exit 0 (no new `${VAR}`).

- [ ] **Step 8: Commit.**

```bash
printf '%s\n' "build(docker,ci): run compose and CI Postgres on Citus 14.2 single node" | bunx commitlint
git add docker/postgres/init/00-citus.sql docker/postgres/init/01-extensions.sql docker-compose.yml \
  scripts/docker/check-infra.sh .github/workflows/ci.yml docs/DOCKER.md
git commit -S -m "build(docker,ci): run compose and CI Postgres on Citus 14.2 single node" \
  -m "SH-2. postgres uses citusdata/citus:14.2.0 (linux/amd64) with citus first in
shared_preload_libraries; 00-citus.sql creates the extension because the init mount hides the
image's script. check-infra.sh asserts the preload and the extension; CI pulls the image first."
```

### Task 3: SH-3 Platform Citus helpers and the runner's sequential mode

Design section 4.1-4.3. The helpers live in the platform set (`libs/database`), so they must name no domain. They
are plpgsql where they mention Citus objects: plpgsql resolves names only when a line runs, so the same file
creates on plain Postgres. `create_distributed_table` is not idempotent [P-14], hence the `pg_dist_partition`
checks. `colocate_with => 'default'` silently joined an unrelated group [P-14], hence the explicit anchor. The
runner's `SET` makes drizzle's one-transaction-per-set model work when a file distributes tables and then adds a
reference FK [P-10]; the helpers worked inside one sequential transaction in [P-16].

**Files:**

- Create: `libs/database/src/platform/migrations/0001_citus_helpers.sql`,
  `libs/database/test/citus.int-spec.ts`, `libs/database/test/fixtures/citus/migrations/0000_create_catalog.sql`,
  `libs/database/test/fixtures/citus/migrations/meta/_journal.json`
- Modify: `libs/database/src/platform/migrations/meta/_journal.json`,
  `libs/database/src/platform/platform.migrations.ts:5-11` (doc comment),
  `libs/database/src/migrator/run-migrations.ts:151-227`, `libs/database/test/fixtures/fixture-sets.ts`,
  `libs/database/test/database.int-spec.ts:206-209` (the CLI test counts the platform set's files)
- Test: `libs/database/src/platform/platform.migrations.spec.ts`, `libs/database/src/migrator/run-migrations.spec.ts`,
  `libs/database/test/citus.int-spec.ts`; table lists in
  `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts:153-158` and
  `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts:101-106`
- Modify (docs): `libs/database/README.md` ("Migrations" table note, "Platform migration set", "Tests"),
  `docs/TESTING.md` (one int-spec row)

**Interfaces:**

- Consumes: `startTestPostgres`, `TestPostgres` (Task 1); `runMigrations`, `platformMigrations`,
  `DatabaseMigrationSet`, `MIGRATIONS_TABLE` (`libs/database`, unchanged signatures).
- Produces: the SQL helper contract and the runner behaviour in "Interface contracts" above:
  `app.citus_enabled() → boolean`, `app.tenant_colocation (tenant_id uuid PRIMARY KEY)`,
  `app.citus_table_kind(regclass) → text`, `app.distribute_by_tenant(regclass) → void`,
  `app.distribute_by_user(regclass) → void`, `app.make_reference(regclass) → void`; platform journal entry
  `{ idx: 1, tag: '0001_citus_helpers', when: 1794182400000 }`; test fixture
  `catalogMigrations: DatabaseMigrationSet` (`libs/database/test/fixtures/fixture-sets.ts`).

**Wave:** after Task 2 (lane `s0`); needs Task 1's container.

- [ ] **Step 1: Write the failing unit specs.**
  - `libs/database/src/platform/platform.migrations.spec.ts`: add after the `0000_init` test:
    ```ts
    it('0001_citus_helpers creates the Citus helpers and the tenant anchor, each a no-op without Citus', () => {
      const sql = readFileSync(join(platformMigrations.folder, '0001_citus_helpers.sql'), 'utf8');
      for (const signature of [
        'app.citus_enabled() RETURNS boolean',
        'app.citus_table_kind(t regclass) RETURNS text',
        'app.distribute_by_tenant(t regclass) RETURNS void',
        'app.distribute_by_user(t regclass) RETURNS void',
        'app.make_reference(t regclass) RETURNS void',
      ]) {
        expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${signature}`);
      }
      expect(sql).toContain(
        'CREATE TABLE IF NOT EXISTS app.tenant_colocation (tenant_id uuid PRIMARY KEY);',
      );
      // citus_table_kind and the three procedures return before touching a Citus object.
      expect(sql.match(/IF NOT app\.citus_enabled\(\) THEN/g)).toHaveLength(4);
      // An explicit colocation everywhere: 'default' joins whatever group Citus picks (P-14).
      expect(sql).not.toContain("colocate_with => 'default'");
    });
    ```
  - `libs/database/src/migrator/run-migrations.spec.ts`: add after the test
    `'applies the sets in array order on ONE session, under ONE lock, and sums the summary'`:
    ```ts
    it('on Citus, pins local execution and sequential shard modification before the first set', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const events: string[] = [];
      vi.mocked(migrate).mockImplementation(async () => {
        events.push('migrate');
      });
      const sql = createFakeSql((query) => {
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes("extname = 'citus'")) return [{ citus: true }];
        if (query.startsWith('set citus.')) events.push(query);
        return [];
      });
      vi.mocked(postgres).mockReturnValue(sql as never);
      const logger = silentLogger();

      await runMigrations(URL, { migrations: [orders], logger });

      expect(events).toEqual([
        'set citus.enable_local_execution to on',
        "set citus.multi_shard_modify_mode to 'sequential'",
        'migrate',
      ]);
      expect(logger.log).toHaveBeenCalledWith(
        'Citus detected: migration session uses local execution and sequential shard modification',
      );
    });

    it('without the citus extension, sends no Citus setting', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const sql = createFakeSql((query) => {
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes("extname = 'citus'")) return [{ citus: false }];
        return [];
      });
      vi.mocked(postgres).mockReturnValue(sql as never);

      await runMigrations(URL, { migrations: [orders], logger: silentLogger() });

      expect(sql.queries.some((query) => query.includes("extname = 'citus'"))).toBe(true);
      expect(sql.queries.some((query) => query.startsWith('set citus.'))).toBe(false);
    });
    ```

- [ ] **Step 2: Run them, expect FAIL.**
      `npx vitest run --project database src/platform/platform.migrations.spec.ts src/migrator/run-migrations.spec.ts`
      Expected: FAIL, `Tests 3 failed | 16 passed (19)`: the `0001_citus_helpers` test
      (`Error: ENOENT: no such file or directory, open '…/0001_citus_helpers.sql'`; the journal test still passes,
      the journal is edited in Step 3), the Citus runner test
      (`AssertionError: expected [ 'migrate' ] to deeply equal [ …(3) ]`) and the no-extension test
      (`AssertionError: expected false to be true`: no query contains `extname = 'citus'` yet). Every existing
      runner test stays green: their handlers return `[]` for the new probe, which reads as "no Citus".

- [ ] **Step 3: Implement the platform migration.** Create
      `libs/database/src/platform/migrations/0001_citus_helpers.sql`:

```sql
-- @platform/database platform set, 0001: Citus distribution helpers (Citus-optional).
-- Without the citus extension in this database every helper returns at once, so plain Postgres
-- runs the same history. Each one reads pg_dist_partition first (create_distributed_table is not
-- idempotent), so a re-run or a squashed 0000_init is safe, and a call that would change a table's
-- kind raises instead. Bodies that name Citus objects are plpgsql, which resolves names only when a
-- line runs. Domain sets call them from a hand-written `distribute` migration (docs/DEVELOPMENT.md,
-- "Citus-ready schema rules"): reference tables first, then tenant tables, then user tables.
CREATE OR REPLACE FUNCTION app.citus_enabled() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'citus') $$;--> statement-breakpoint
-- The colocation anchor of every tenant-distributed table: always empty, never queried.
-- app.distribute_by_tenant distributes it first (with the server's citus.shard_count at that
-- moment), and colocates every tenant table with it, so they all share one shard map.
CREATE TABLE IF NOT EXISTS app.tenant_colocation (tenant_id uuid PRIMARY KEY);--> statement-breakpoint
-- 'reference', 'hash:<distribution column>', 'local' (not a Citus table), 'other' (a Citus local or
-- single-shard table), or NULL without the citus extension.
CREATE OR REPLACE FUNCTION app.citus_table_kind(t regclass) RETURNS text
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  p record;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN NULL;
  END IF;
  SELECT d.partmethod, d.repmodel, d.partkey INTO p
    FROM pg_dist_partition d WHERE d.logicalrelid = t;
  IF NOT FOUND THEN
    RETURN 'local';
  ELSIF p.partmethod = 'h' THEN
    RETURN 'hash:' || column_to_column_name(t, p.partkey);
  ELSIF p.repmodel = 't' THEN
    RETURN 'reference';
  END IF;
  RETURN 'other';
END;
$$;--> statement-breakpoint
-- Hash-distributes t on tenant_id, colocated with app.tenant_colocation.
CREATE OR REPLACE FUNCTION app.distribute_by_tenant(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  IF app.citus_table_kind('app.tenant_colocation') IS DISTINCT FROM 'hash:tenant_id' THEN
    PERFORM create_distributed_table('app.tenant_colocation', 'tenant_id', colocate_with => 'none');
  END IF;
  IF t = 'app.tenant_colocation'::regclass THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'hash:tenant_id'
     AND (SELECT colocationid FROM pg_dist_partition WHERE logicalrelid = t)
       = (SELECT colocationid FROM pg_dist_partition
          WHERE logicalrelid = 'app.tenant_colocation'::regclass) THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.distribute_by_tenant(%): already a Citus table of another kind (%), not colocated with app.tenant_colocation', t, kind;
  END IF;
  PERFORM create_distributed_table(t, 'tenant_id', colocate_with => 'app.tenant_colocation');
END;
$$;--> statement-breakpoint
-- Hash-distributes t on user_id, colocated with the first user-distributed table (the first one
-- opens its own group), so every user table shares one shard map, apart from the tenant tables.
CREATE OR REPLACE FUNCTION app.distribute_by_user(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
  peer regclass;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'hash:user_id' THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.distribute_by_user(%): already a Citus table of another kind (%)', t, kind;
  END IF;
  SELECT d.logicalrelid INTO peer
    FROM pg_dist_partition d
    WHERE d.partmethod = 'h' AND column_to_column_name(d.logicalrelid, d.partkey) = 'user_id'
    ORDER BY d.colocationid, d.logicalrelid::oid
    LIMIT 1;
  PERFORM create_distributed_table(t, 'user_id',
    colocate_with => CASE WHEN peer IS NULL THEN 'none' ELSE peer::text END);
END;
$$;--> statement-breakpoint
-- Replicates t to every node (create_reference_table).
CREATE OR REPLACE FUNCTION app.make_reference(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'reference' THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.make_reference(%): already distributed (%)', t, kind;
  END IF;
  PERFORM create_reference_table(t);
END;
$$;
```

Append to `entries` in `libs/database/src/platform/migrations/meta/_journal.json`:

```text
    {
      "idx": 1,
      "version": "7",
      "when": 1794182400000,
      "tag": "0001_citus_helpers",
      "breakpoints": true
    }
```

In `libs/database/src/platform/platform.migrations.ts`, replace the doc-comment lines

```text
 * The platform migration set: the SQL no domain owns. It creates the `app` schema (bookkeeping in
 * `app.__drizzle_migrations`; B3 adds the RLS helper functions there) and the extensions domain
 * tables rely on (pg_trgm). Always applied first, under the same advisory lock as the domain sets
```

with

```text
 * The platform migration set: the SQL no domain owns. It creates the `app` schema (bookkeeping in
 * `app.__drizzle_migrations`; B3 adds the RLS helper functions there), the extensions domain tables
 * rely on (pg_trgm) and the Citus distribution helpers with their colocation anchor (0001, no-ops on
 * plain Postgres). Always applied first, under the same advisory lock as the domain sets
```

- [ ] **Step 4: Implement the runner change.** In `libs/database/src/migrator/run-migrations.ts`:
  - add after `summarize` (before the `runMigrations` doc comment):
    ```ts
    /**
     * drizzle applies a set's pending files in ONE transaction; on Citus two settings make that work:
     * - local execution on: with it off (a `localExecution: false` test server, or a role default),
     *   the coordinator creates its own shards over a loopback connection that cannot see a schema or
     *   enum created earlier in the same transaction, so a fresh database's `0000_init` plus its
     *   `distribute` file fail with `type "<schema>.<enum>" does not exist`;
     * - sequential shard modification: DDL on a table with a reference-table foreign key fails after
     *   any parallel shard operation in the same transaction (shards on workers), so one file can
     *   distribute tables and then add their foreign keys only in this mode (sharding design P-10).
     * Session `SET`s are safe: this client is private (`max: 1`) and must reach the coordinator
     * directly, never through a transaction pooler. Without the citus extension nothing is sent.
     */
    async function configureCitusSession(sql: Sql, logger: LoggerService): Promise<void> {
      const [row] = await sql<{ citus: boolean }[]>`
        select exists (select 1 from pg_extension where extname = 'citus') as citus`;
      if (row?.citus !== true) return;
      await sql`set citus.enable_local_execution to on`;
      await sql`set citus.multi_shard_modify_mode to 'sequential'`;
      logger.log(
        'Citus detected: migration session uses local execution and sequential shard modification',
      );
    }
    ```
  - in `runMigrations`, replace
    ```text
        locked = true;
        const results: MigrationSetSummary[] = [];
    ```
    with
    ```text
        locked = true;
        await configureCitusSession(sql, logger);
        const results: MigrationSetSummary[] = [];
    ```
  - in the `runMigrations` doc comment, after the bullet that starts
    `` * - `statement_timeout: 0` for this session only``, insert:
    ```text
     * - on Citus (the `citus` extension is installed), `citus.enable_local_execution = on` and
     *   `citus.multi_shard_modify_mode = 'sequential'` for this session, so a set can create a schema
     *   or enum, distribute tables and add their foreign keys in one transaction;
    ```

- [ ] **Step 5: Run the unit specs, expect PASS.**
      `npx vitest run --project database src/platform/platform.migrations.spec.ts src/migrator/run-migrations.spec.ts`
      Expected: PASS, 19 tests (4 platform tests; the runner file gains 2 tests, all green). The whole
      `database` unit project (`npx vitest run --project database`) then has 86 tests, all green.

- [ ] **Step 6: Write the int spec and its fixture.**
  - Create `libs/database/test/fixtures/citus/migrations/0000_create_catalog.sql` (a Citus-shaped history in the
    order the design prescribes: create, distribute, indexes, FKs; it needs the platform set first). The enum
    created in the same file mirrors identity's `user_role` + `distribute` shape on a fresh database, the case
    that needs the runner's `citus.enable_local_execution = on` (probe d in the plan review):
    ```sql
    CREATE SCHEMA IF NOT EXISTS "catalog";--> statement-breakpoint
    CREATE TYPE "catalog"."order_status" AS ENUM('open', 'closed');--> statement-breakpoint
    CREATE TABLE "catalog"."regions" (
    	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
    	"name" text NOT NULL
    );--> statement-breakpoint
    SELECT app.make_reference('catalog.regions');--> statement-breakpoint
    CREATE TABLE "catalog"."orders" (
    	"tenant_id" uuid NOT NULL,
    	"id" uuid DEFAULT uuidv7() NOT NULL,
    	"status" "catalog"."order_status" DEFAULT 'open' NOT NULL,
    	CONSTRAINT "orders_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
    );--> statement-breakpoint
    SELECT app.distribute_by_tenant('catalog.orders');--> statement-breakpoint
    CREATE TABLE "catalog"."order_lines" (
    	"tenant_id" uuid NOT NULL,
    	"id" uuid DEFAULT uuidv7() NOT NULL,
    	"order_id" uuid NOT NULL,
    	"region_id" uuid NOT NULL,
    	CONSTRAINT "order_lines_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
    );--> statement-breakpoint
    SELECT app.distribute_by_tenant('catalog.order_lines');--> statement-breakpoint
    CREATE INDEX "order_lines_tenant_id_order_id_idx" ON "catalog"."order_lines" USING btree ("tenant_id","order_id");--> statement-breakpoint
    ALTER TABLE "catalog"."order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "catalog"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
    ALTER TABLE "catalog"."order_lines" ADD CONSTRAINT "order_lines_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "catalog"."regions"("id") ON DELETE no action ON UPDATE no action;
    ```
  - Create `libs/database/test/fixtures/citus/migrations/meta/_journal.json`:
    ```json
    {
      "version": "7",
      "dialect": "postgresql",
      "entries": [
        {
          "idx": 0,
          "version": "7",
          "when": 1700000000000,
          "tag": "0000_create_catalog",
          "breakpoints": true
        }
      ]
    }
    ```
  - `libs/database/test/fixtures/fixture-sets.ts`: append
    ```ts
    /**
     * A hand-written, Citus-shaped history: an enum, a reference table and two colocated tenant tables,
     * then their foreign keys, in one file (one transaction). It calls the platform set's helpers, so it
     * runs after platformMigrations; on plain Postgres the helpers are no-ops and the tables stay local.
     */
    export const catalogMigrations: DatabaseMigrationSet = {
      name: 'catalog',
      folder: join(import.meta.dirname, 'citus', 'migrations'),
      migrationsSchema: 'catalog',
      migrationsTable: MIGRATIONS_TABLE,
    };
    ```
  - Create `libs/database/test/citus.int-spec.ts`:
    ```ts
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
    import { noop } from 'lodash-es';
    import postgres, { type Sql } from 'postgres';
    import { afterAll, beforeAll, describe, expect, it } from 'vitest';
    import { platformMigrations, runMigrations } from '../src/index.js';
    import { catalogMigrations } from './fixtures/fixture-sets.js';

    /*
     * The platform set's Citus helpers (0001_citus_helpers.sql) and the runner's sequential mode on
     * citusdata/citus:14.2.0 (single node, 4 shards). Database `app` has the citus extension; database
     * `plain`, created here, has not, so it behaves as plain Postgres. The tests build on each other in
     * file order. Opt-in (needs Docker):
     *   INTEGRATION=1 bunx vitest run --project database:int
     */

    const silent = { log: noop, warn: noop, error: noop, debug: noop };
    const HELPER_TABLES = [
      'app.tenant_colocation',
      'helpers.regions',
      'helpers.orders',
      'helpers.shipments',
      'helpers.devices',
      'helpers.alerts',
    ];
    const CREATE_HELPER_TABLES = `
      create schema helpers;
      create table helpers.regions (id uuid primary key);
      create table helpers.orders (tenant_id uuid not null, id uuid not null, primary key (tenant_id, id));
      create table helpers.shipments (tenant_id uuid not null, id uuid not null, primary key (tenant_id, id));
      create table helpers.devices (user_id uuid not null, id uuid not null, primary key (user_id, id));
      create table helpers.alerts (user_id uuid not null, id uuid not null, primary key (user_id, id));`;

    interface Placement {
      kind: string;
      colocation: number;
      shards: number;
    }

    describe('Citus helpers and sequential migrations on Citus 14.2 (single node)', () => {
      let pg: TestPostgres;
      let citus: Sql;
      let plain: Sql;
      let plainUrl: string;

      const call = (sql: Sql, helper: string, table: string) =>
        sql.unsafe(`select app.${helper}('${table}')`);

      /** The calls a domain's distribute migration makes, in its order. */
      const distributeAll = async (sql: Sql): Promise<void> => {
        await call(sql, 'make_reference', 'helpers.regions');
        await call(sql, 'distribute_by_tenant', 'helpers.orders');
        await call(sql, 'distribute_by_tenant', 'helpers.shipments');
        await call(sql, 'distribute_by_user', 'helpers.devices');
        await call(sql, 'distribute_by_user', 'helpers.alerts');
      };

      /** How Citus placed `table`, or undefined when it is not a Citus table. */
      const placement = async (table: string): Promise<Placement | undefined> => {
        const [row] = await citus<Placement[]>`
          select case when p.partmethod = 'h'
                        then 'hash:' || column_to_column_name(p.logicalrelid, p.partkey)
                      when p.repmodel = 't' then 'reference' else 'other' end as kind,
            p.colocationid::int as colocation,
            (select count(*)::int from pg_dist_shard s where s.logicalrelid = p.logicalrelid) as shards
          from pg_dist_partition p where p.logicalrelid = ${table}::regclass`;
        return row;
      };

      const foreignKeys = async (sql: Sql): Promise<string[]> => {
        const rows = await sql<{ name: string }[]>`
          select conname as name from pg_constraint
          where conrelid = 'catalog.order_lines'::regclass and contype = 'f' order by conname`;
        return rows.map((row) => row.name);
      };

      beforeAll(async () => {
        pg = await startTestPostgres({ allowExternalUrl: false });
        citus = postgres(pg.url, { max: 1, onnotice: noop });
        await citus`create database plain`;
        const url = new URL(pg.url);
        url.pathname = '/plain';
        plainUrl = url.toString();
        plain = postgres(plainUrl, { max: 1, onnotice: noop });
        for (const target of [pg.url, plainUrl]) {
          await runMigrations(target, { migrations: [platformMigrations], logger: silent });
        }
        await citus.unsafe(CREATE_HELPER_TABLES).simple();
        await plain.unsafe(CREATE_HELPER_TABLES).simple();
      });

      afterAll(async () => {
        await plain?.end({ timeout: 5 });
        await citus?.end({ timeout: 5 });
        await pg?.stop();
      });

      it('app.citus_enabled() is true only in the database that has the citus extension', async () => {
        const [onCitus] = await citus<
          { enabled: boolean }[]
        >`select app.citus_enabled() as enabled`;
        const [onPlain] = await plain<
          { enabled: boolean }[]
        >`select app.citus_enabled() as enabled`;
        expect(onCitus?.enabled).toBe(true);
        expect(onPlain?.enabled).toBe(false);
      });

      it('places reference, tenant and user tables; every tenant table joins the anchor group', async () => {
        await distributeAll(citus);
        const anchor = await placement('app.tenant_colocation');
        expect(anchor).toEqual({
          kind: 'hash:tenant_id',
          colocation: expect.any(Number),
          shards: 4,
        });
        expect(await placement('helpers.regions')).toMatchObject({ kind: 'reference', shards: 1 });
        for (const table of ['helpers.orders', 'helpers.shipments']) {
          expect(await placement(table)).toEqual({
            kind: 'hash:tenant_id',
            colocation: anchor?.colocation,
            shards: 4,
          });
        }
        const devices = await placement('helpers.devices');
        expect(devices).toMatchObject({ kind: 'hash:user_id', shards: 4 });
        expect(devices?.colocation).not.toBe(anchor?.colocation);
        expect(await placement('helpers.alerts')).toEqual(devices);
      });

      it('is idempotent: running every helper again changes nothing', async () => {
        const before = await Promise.all(HELPER_TABLES.map((table) => placement(table)));
        await distributeAll(citus);
        const after = await Promise.all(HELPER_TABLES.map((table) => placement(table)));
        expect(after).toEqual(before);
      });

      it('refuses to turn a Citus table of one kind into another', async () => {
        await expect(call(citus, 'make_reference', 'helpers.orders')).rejects.toThrow(
          /already distributed \(hash:tenant_id\)/,
        );
        await expect(call(citus, 'distribute_by_tenant', 'helpers.regions')).rejects.toThrow(
          /another kind \(reference\)/,
        );
        await expect(call(citus, 'distribute_by_tenant', 'helpers.devices')).rejects.toThrow(
          /another kind \(hash:user_id\)/,
        );
        await expect(call(citus, 'distribute_by_user', 'helpers.orders')).rejects.toThrow(
          /another kind \(hash:tenant_id\)/,
        );
      });

      it('is a no-op on plain Postgres: the tables stay ordinary tables', async () => {
        await distributeAll(plain);
        await distributeAll(plain);
        const [row] = await plain<{ citus: number; partition: string | null }[]>`
          select (select count(*)::int from pg_extension where extname = 'citus') as citus,
            to_regclass('pg_catalog.pg_dist_partition')::text as partition`;
        expect(row).toEqual({ citus: 0, partition: null });
        await plain`insert into helpers.orders (tenant_id, id) values (uuidv7(), uuidv7())`;
        const [count] = await plain<{ count: number }[]>`
          select count(*)::int as count from helpers.orders`;
        expect(count?.count).toBe(1);
      });

      it('rejects a misspelt table even on plain Postgres (the regclass cast runs first)', async () => {
        await expect(call(plain, 'make_reference', 'helpers.nope')).rejects.toThrow(
          /relation "helpers\.nope" does not exist/,
        );
      });

      describe('runMigrations()', () => {
        it('creates an enum, distributes tables and adds their foreign keys in one transaction, even when sessions default to remote execution', async () => {
          // Like a startTestPostgres({ localExecution: false }) server: new sessions of role app start
          // with local execution off. The runner turns it back on for its own session; without that,
          // the shard connection cannot see catalog.order_status, created in the same transaction.
          await citus`alter role app in database app set citus.enable_local_execution = off`;
          const summary = await runMigrations(pg.url, {
            migrations: [platformMigrations, catalogMigrations],
            logger: silent,
          }).finally(async () => {
            await citus`alter role app in database app reset citus.enable_local_execution`;
          });
          expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
            { name: 'platform', applied: 0 },
            { name: 'catalog', applied: 1 },
          ]);
          const anchor = await placement('app.tenant_colocation');
          expect(await placement('catalog.regions')).toMatchObject({ kind: 'reference' });
          for (const table of ['catalog.orders', 'catalog.order_lines']) {
            expect(await placement(table)).toMatchObject({
              kind: 'hash:tenant_id',
              colocation: anchor?.colocation,
            });
          }
          expect(await foreignKeys(citus)).toEqual([
            'order_lines_order_fk',
            'order_lines_region_id_regions_id_fk',
          ]);
        });

        it('needs sequential mode once shard commands go over connections, as on a cluster', async () => {
          // On one node with local execution on (this container) Citus runs every shard command in
          // this backend, so parallel mode cannot fail here. With local execution off, shard commands
          // go over connections, as they go to workers on a cluster: the fixture's foreign keys then
          // fail after the parallel distribution unless the transaction is sequential. The schema and
          // enum are committed first, because a loopback connection cannot see uncommitted ones.
          const statements = readFileSync(
            join(catalogMigrations.folder, '0000_create_catalog.sql'),
            'utf8',
          ).split('--> statement-breakpoint');
          const applyInOneTransaction = async (
            schema: string,
            sequential: boolean,
          ): Promise<void> => {
            const renamed = statements.map((statement) =>
              statement
                .replaceAll('"catalog"', `"${schema}"`)
                .replaceAll("'catalog.", `'${schema}.`),
            );
            const setup = renamed.filter((statement) => /^\s*CREATE (SCHEMA|TYPE)/.test(statement));
            const body = renamed.filter((statement) => !setup.includes(statement));
            for (const statement of setup) await citus.unsafe(statement);
            await citus.begin(async (tx) => {
              await tx`set local citus.enable_local_execution = off`;
              if (sequential) await tx`set local citus.multi_shard_modify_mode = 'sequential'`;
              for (const statement of body) await tx.unsafe(statement);
            });
          };
          await expect(applyInOneTransaction('parallel_probe', false)).rejects.toThrow(
            /because there was a parallel operation on a distributed table in the transaction/,
          );
          await applyInOneTransaction('sequential_probe', true);
          const [row] = await citus<{ parallel: number; sequential: number }[]>`
            select count(*) filter (where logicalrelid::text like 'parallel_probe.%')::int as parallel,
              count(*) filter (where logicalrelid::text like 'sequential_probe.%')::int as sequential
            from pg_dist_partition`;
          expect(row).toEqual({ parallel: 0, sequential: 3 });
        });

        it('applies the same set on plain Postgres, where every table stays local', async () => {
          const summary = await runMigrations(plainUrl, {
            migrations: [platformMigrations, catalogMigrations],
            logger: silent,
          });
          expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
            { name: 'platform', applied: 0 },
            { name: 'catalog', applied: 1 },
          ]);
          expect(await foreignKeys(plain)).toEqual([
            'order_lines_order_fk',
            'order_lines_region_id_regions_id_fk',
          ]);
        });
      });
    });
    ```

- [ ] **Step 7: Update the CLI counts in `database.int-spec.ts`, then run the project (sandbox off), expect PASS.**
  - `libs/database/test/database.int-spec.ts`, the CLI test that starts with
    `'applies the platform set, then the given sets, and exits 0;` (`:203`): the platform set now has two
    files, so replace
    `'Done: 4 applied, 4 total (platform, widgets, gadgets)'` with
    `'Done: 5 applied, 5 total (platform, widgets, gadgets)'`, replace
    `'Done: 0 applied, 4 total (platform, widgets, gadgets)'` with
    `'Done: 0 applied, 5 total (platform, widgets, gadgets)'`, and replace
    `expect(await migrationRows(url, platformMigrations)).toBe(1);` with
    `expect(await migrationRows(url, platformMigrations)).toBe(2);`.
  - `INTEGRATION=1 npx vitest run --project database:int`
    Expected: PASS, 25 tests: `citus.int-spec.ts` 9 plus the 16 of `database.int-spec.ts` (its `cli` and `boot`
    databases apply the platform set, `0001` included, on the plain path: they have no `citus` extension). The
    two files run in parallel, so two emulated containers start at once (about 25 s in the review run).
    The two `runMigrations()` tests of `citus.int-spec.ts` are the evidence for the runner's two `SET`s (plan
    review, probe d): without `set citus.enable_local_execution to on` the first fails with
    `type "catalog.order_status" does not exist`; the second shows the parallel-mode failure under remote
    execution. If either behaves otherwise on Citus 14.2.0, stop and report; do not delete or weaken it.

- [ ] **Step 8: Update the app-shaped specs' table lists, run them, expect PASS.**
  - `users.repository.int-spec.ts` and `billing.migrations.int-spec.ts`: in the sorted `tables` expectation,
    insert `'app.tenant_colocation',` right after `'app.__drizzle_migrations',`.
  - `INTEGRATION=1 npx vitest run --project identity:int`, then `INTEGRATION=1 npx vitest run --project billing:int`
    Expected: PASS, 15 and 6 tests; the bookkeeping test now expects `app: 2` (it reads the journal size).

- [ ] **Step 9: Docs.**
  - `libs/database/README.md`, "Platform migration set": after the first paragraph add
    ```markdown
    `0001_citus_helpers.sql` adds the Citus distribution helpers: `app.citus_enabled()`, the empty colocation
    anchor `app.tenant_colocation (tenant_id uuid PRIMARY KEY)`, `app.citus_table_kind(regclass)`,
    `app.distribute_by_tenant(regclass)` (hash on `tenant_id`, colocated with the anchor),
    `app.distribute_by_user(regclass)` (hash on `user_id`, one group for all user tables) and
    `app.make_reference(regclass)`. Without the `citus` extension they return at once; with it they check
    `pg_dist_partition` first, so a re-run is a no-op, and they raise instead of changing a table's kind. Domain
    sets call them from a hand-written `distribute` migration ([DEVELOPMENT.md](../../docs/DEVELOPMENT.md#citus-ready-schema-rules)).
    When the database has the `citus` extension, `runMigrations` sets `citus.enable_local_execution = on` and
    `citus.multi_shard_modify_mode = 'sequential'` on its private session, so a set can create a schema or enum,
    distribute tables and add their foreign keys in one transaction, also on a server whose sessions default to
    remote execution. The migration URL must reach the coordinator directly, never a transaction pooler.
    ```
  - `libs/database/README.md`, "Tests": append to the Integration bullet: "`test/citus.int-spec.ts` covers the
    Citus helpers (placement, colocation, idempotency, kind changes, the plain-Postgres no-op) and the runner's
    Citus session settings (a set applied while sessions default to remote execution, and the parallel-mode
    failure they avoid), with the `test/fixtures/citus` set."
  - `docs/TESTING.md` integration table: add after the `database:int` row
    ```text
    | [`libs/database/test/citus.int-spec.ts`](../libs/database/test/citus.int-spec.ts) | `database:int` | Docker (`@platform/testing/postgres`) | the platform set's Citus helpers on Citus and on a plain database, and the runner's Citus session settings (a set that creates an enum, distributes tables and adds their foreign keys in one transaction) |
    ```
  - `npx prettier --write libs/database/README.md docs/TESTING.md`

- [ ] **Step 10: Wider checks.**
      `npx biome check --write libs/database domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts && npx vitest run --project database && bun run --filter @platform/database build && bun run check`
      Expected: unit PASS; `libs/database/dist/platform/migrations/0001_citus_helpers.sql` exists (SWC
      `copyFiles`); `bun run check` ends with `Layer boundaries OK (26 packages: …)`. Then
      `bun run db:generate && git status --porcelain -- 'domains/*/src/infrastructure/persistence/migrations'`:
      Expected empty (no domain schema changed).

- [ ] **Step 11: Commit.**

```bash
printf '%s\n' "feat(database,identity,billing): add Citus distribution helpers and sequential migrations" | bunx commitlint
git add libs/database/src/platform libs/database/src/migrator/run-migrations.ts \
  libs/database/src/migrator/run-migrations.spec.ts libs/database/test/citus.int-spec.ts \
  libs/database/test/database.int-spec.ts \
  libs/database/test/fixtures/fixture-sets.ts libs/database/test/fixtures/citus libs/database/README.md \
  domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts \
  domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts docs/TESTING.md
git commit -S -m "feat(database,identity,billing): add Citus distribution helpers and sequential migrations" \
  -m "SH-3. Platform set 0001: app.citus_enabled, the app.tenant_colocation anchor, citus_table_kind,
distribute_by_tenant, distribute_by_user and make_reference; idempotent, no-ops without the citus
extension, and they refuse kind changes. On Citus the runner pins local execution on and
multi_shard_modify_mode to sequential, so one set can create an enum, distribute tables and add
their foreign keys in its single transaction."
```

### Task 4: SH-4 Conventions doc: Citus-ready schema rules

Design section 2.1 (rules), 2.3 (shapes), 4.2 (distribution migrations) and 4.7 (drizzle-kit) become a binding
section of `docs/DEVELOPMENT.md` and a plan-writer checklist item, so that every B2 plan writes composite keys,
tenant-leading uniques and no cross-domain FKs from the start. Prose only: there is no behaviour to test, so the
gates are Prettier and `bun run check`.

**Files:**

- Modify: `docs/DEVELOPMENT.md` (new subsection right before `## Cassandra CQL migrations`, `:466`),
  `docs/superpowers/plans/program-work/conventions.md` (new `### 4.11` right before `## 5. Parallelism`, `:664`)

**Interfaces:**

- Consumes: the helper names and signatures from Task 3; the anchor `app.tenant_colocation`.
- Produces: the anchor `docs/DEVELOPMENT.md#citus-ready-schema-rules` (linked from `docs/DOCKER.md` in Task 2 and
  `libs/database/README.md` in Task 3).

**Wave:** after Task 3 (lane `s0`).

- [ ] **Step 1: Write the section.** In `docs/DEVELOPMENT.md`, insert right before `## Cassandra CQL migrations`:

```markdown
### Citus-ready schema rules

Postgres is Citus 14.2 in compose, in CI and in every int spec (single node: one server holds every shard). These
rules bind every table a migration creates from B2 on, so that each domain's `distribute` migration can shard it
later without a rewrite. Background and probes:
[sharding design](superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md), sections 2 and 4.

| Kind               | Use it for                                                                             | Distribution call                                      | Keys                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| reference          | global, small, read-mostly tables that policy helpers read or every tenant table joins | `SELECT app.make_reference('<schema>.<table>');`       | any; global uniques work                                                              |
| tenant-distributed | rows owned by one tenant                                                               | `SELECT app.distribute_by_tenant('<schema>.<table>');` | `tenant_id uuid NOT NULL`; PK `(tenant_id, id)`; every UNIQUE starts with `tenant_id` |
| user-distributed   | rows looked up by user across tenants                                                  | `SELECT app.distribute_by_user('<schema>.<table>');`   | `user_id uuid NOT NULL`; PK `(user_id, id)`; every UNIQUE starts with `user_id`       |
| coordinator-local  | bookkeeping and system-only tables (`<schema>.__drizzle_migrations`, …)                | none                                                   | any                                                                                   |

1. **One kind per table.** Note it on the table in `*.schema.ts` (`// citus: reference`, `// citus: tenant`,
   `// citus: user`, `// citus: local`); the domain's `distribute` migration is the source of truth.
2. **Keys.** On a distributed table the PK and every UNIQUE (constraint or unique index) start with the
   distribution column; Citus rejects anything else. `id` stays `uuid` with `DEFAULT uuidv7()`, but
   `uuid().primaryKey()` alone is only valid on reference and local tables. In Drizzle:
   `(t) => [primaryKey({ columns: [t.tenantId, t.id] }), uniqueIndex('<table>_tenant_id_<col>_uq').on(t.tenantId, t.<col>)]`.
3. **Foreign keys.** Distributed → reference: allowed (`ON DELETE CASCADE` too). Distributed → distributed: only
   between tables of the same kind, and the key includes the distribution column
   (`(tenant_id, parent_id) REFERENCES parent (tenant_id, id)`). Reference → distributed: never. Distributed →
   coordinator-local and local → distributed: never; such a column (for example a run id) is a plain column. No
   foreign key crosses a domain schema: a domain's `tenant_id` or `user_id` that points into another domain is a
   plain column.
4. **Policies (B3).** No subquery anywhere in a policy: call `app.user_id()`, `app.tenant_id()`, `app.elevated()`
   directly, never `(select app.x())`. A cross-table check goes through a `STABLE` SQL helper that reads
   **reference tables only**; one that reads a distributed table fails inside pushed-down queries.
5. **Queries.** Every tenant-scoped repository query carries an explicit `tenant_id = $param` predicate from the
   principal, even where RLS filters too: without it the query fans out to every shard.
6. **Locks and session state.** No `SELECT … FOR UPDATE` without an equality on the distribution column (Citus
   refuses multi-shard row locks). Use `pg_advisory_xact_lock`, never `pg_advisory_lock`; no session `SET` or
   `set_config(…, false)` outside the migrator (a transaction pooler arrives with B3).
7. **Cross-shard work** (crons, relays, reconciliation) runs on the system pool as multi-shard statements without
   row locks, or loops per tenant.
8. **Platform tenant.** Platform-level rows of a tenant-distributed table (for example platform Stripe events and
   their ledger rows) use `PLATFORM_TENANT_ID`, the nil UUID `00000000-0000-0000-0000-000000000000`, as
   `tenant_id`. It is never issued as a tenant id and never accepted as a runtime principal's tenant, so only the
   system role reads or writes those rows; they all hash to one shard, which is fine for their small volume.

**Distribution migrations.** Each domain gets one hand-written migration,
`bun run --filter @domain/<x> db:generate --custom --name distribute`, that holds only helper calls, in this
order: reference tables (parents before children), then tenant-distributed, then user-distributed tables
(identity and billing get theirs right after their B2 table tasks). Every table created **after** that migration
carries its own call in the migration that creates it, in the order CREATE TABLE → distribution call → indexes →
foreign keys → RLS and policies: drizzle-kit writes foreign keys at the end of a generated file, so add the call by
hand right after each `CREATE TABLE` (the CI drift check compares snapshots, not SQL). A coordinator-local table
gets no call. Migrations of one domain are serialized on one lane, and each takes the next free `NNNN` at merge
time. The helpers come from the platform set
(`0001_citus_helpers.sql`): they do nothing without the `citus` extension, a second call is a no-op, and a call
that would change a table's kind raises. On Citus the migrator runs with `citus.enable_local_execution = on` and
`citus.multi_shard_modify_mode = 'sequential'`, so one migration can create a schema or enum, distribute tables
and then add their foreign keys in its single transaction (drizzle applies all pending files of a set in one).

**Shard count.** All tenant tables share the shard map of `app.tenant_colocation`, fixed by the server's
`citus.shard_count` when the first tenant table is distributed (8 in compose, 4 in int specs, Citus' default 32
elsewhere). Set it in the server config before the first `distribute` migration runs in production.

**Tools.** Migrations, `drizzle-kit` and `db:studio` connect to the Citus coordinator directly
(`DATABASE_MIGRATION_URL` from B3 on), never through a pooler. Citus hides shards from `pg_class` and
`information_schema` (`citus.override_table_visibility`), so Studio and `drizzle-kit pull` see each table once.
```

- [ ] **Step 2: Write the plan-writer addendum.** In `docs/superpowers/plans/program-work/conventions.md`, insert
      right before the `---` line that precedes `## 5. Parallelism` (this folder is Prettier-ignored; keep the
      wrapping at 116 columns by hand):

```markdown
### 4.11 Citus-ready tables (SH-4, binding from B2 on)

- [ ] Every new table follows `docs/DEVELOPMENT.md` "Citus-ready schema rules": pick its kind (reference, tenant,
      user, local), composite PK `(tenant_id, id)` / `(user_id, id)` on distributed tables, every UNIQUE leads with
      the distribution column, no FK across domain schemas or between distributed and coordinator-local tables, no
      subquery in a policy, platform-level rows use `PLATFORM_TENANT_ID` (nil UUID).
- [ ] The table shapes for B2 are in `docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md`
      section 2.3. Distribution migrations (SH-5 identity, SH-6 billing) follow the B2 table tasks and only call
      `app.make_reference` / `app.distribute_by_tenant` / `app.distribute_by_user`. A table created later (G-1
      outbox, L-10 ledger tables) carries its own call right after its `CREATE TABLE`; coordinator-local tables
      get none. Billing migrations stay on one lane: B2-6 → SH-6 → B3-5/B3-6 → G-1 → L-10.
- [ ] Postgres int specs start their database with `startTestPostgres()` from `@platform/testing/postgres`
      (Citus 14.2 single node; `localExecution: false` for RLS specs; `initSql` for role scripts). This supersedes
      CONV-1 (§4.10).
- [ ] Platform-set index `0001` is taken by `0001_citus_helpers.sql`: the next platform file is `0002_*` with a
      larger journal `when`.
- [ ] Compose `postgres` is `citusdata/citus:14.2.0` (amd64, emulated on Apple Silicon); new init SQL goes in
      `docker/postgres/init/` after `00-citus.sql` and `01-extensions.sql`.
```

- [ ] **Step 3: Format and check.** `npx prettier --write docs/DEVELOPMENT.md && bun run check`
      Expected: Prettier re-pads the new table; `bun run check` passes (`prettier --check` skips the
      Prettier-ignored `conventions.md`) and ends with `Layer boundaries OK (26 packages: …)`.
      Then `rg -n 'citus-ready-schema-rules' docs libs/database/README.md`: Expected the two links (DOCKER.md,
      libs/database/README.md) and the heading resolve to `### Citus-ready schema rules`.

- [ ] **Step 4: Commit.**

```bash
printf '%s\n' "docs(docs): add the Citus-ready schema rules for every new table" | bunx commitlint
git add docs/DEVELOPMENT.md docs/superpowers/plans/program-work/conventions.md
git commit -S -m "docs(docs): add the Citus-ready schema rules for every new table" \
  -m "SH-4. Table kinds and their distribution calls, distribution-column-first keys, foreign key and
policy limits, the distribute migration order, shard count and direct coordinator connections;
plus the plan-writer addendum that binds B2 to them."
```

## Later S tasks (SH-5 to SH-12, not written here)

From the sharding design, section 9 (files and tests there). Each later plan consumes this wave's contracts.

| Id    | Title                                                                                            | Wave                    | Depends on                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| SH-5  | Identity distribution migration (`NNNN_distribute.sql`, custom)                                  | after B2-1…B2-5         | SH-3 (helpers), SH-4 (rules), B2 identity table tasks                                                      |
| SH-6  | Billing distribution migration                                                                   | after B2-6              | SH-3, SH-4, B2-6; billing lane order B2-6 → SH-6 → B3-5/B3-6 → G-1 → L-10 (later tables distribute inline) |
| SH-7  | RLS context via `SET LOCAL` (replaces spec §8.1; refuses `PLATFORM_TENANT_ID`) + spec text edits | B3, merged into B3-7    | SH-1 (`localExecution: false`), B3-4 helpers                                                               |
| SH-8  | Role server settings in the shared init SQL; worker authentication choice                        | B3, merged into B3-2    | SH-2 (init folder order), SH-1 (`initSql`)                                                                 |
| SH-9  | PgBouncer service + `DATABASE_POOLER` (+ migrator coordinator assertion)                         | B3, with B3-3           | SH-2, SH-8                                                                                                 |
| SH-10 | Boot guard: `citus.propagate_set_commands = local` on Citus                                      | B3, with the boot guard | SH-3 (`app.citus_enabled()`), SH-8                                                                         |
| SH-11 | Worker compose profile `citus` + sharding smoke spec (adds `workers: 1`)                         | after B3                | SH-1 (extends `TestPostgresOptions`), SH-2, SH-5, SH-6, SH-7                                               |
| SH-12 | Final squash keeps the distribution SQL                                                          | final squash task       | SH-5, SH-6; the squash spec asserts `pg_dist_partition` unchanged                                          |

## Self-review

- **Scope coverage.** Design section 8 "BEFORE B2" item 1 (compose, Testcontainers, CI on Citus with
  `citus,pg_stat_statements`) → Tasks 1 and 2; item 2 (helpers in platform `0001` + the runner's `SET`) → Task 3;
  item 3 (Citus-ready conventions as a plan-writer rule) → Task 4. Section 9 rows SH-1..SH-4 map one-to-one;
  SH-5..SH-12 are tabulated above. Section 6's `check-infra.sh` `citus_version()` assertion → Task 2 Step 1.
  Section 6's `workers` option is deferred to SH-11 on purpose (additive). Section 4.1's "runner can assert it is
  on the coordinator" is deferred to SH-9, when a pooler first exists. No inventory item (inventory.md) is in
  this scope; B1FU-4 (shared `INTEGRATION_DATABASE_URL`) stays open: Task 1 keeps today's opt-out semantics.
- **Names.** `startTestPostgres`, `TestPostgres`, `TestPostgresOptions`, `TEST_POSTGRES_IMAGE`,
  `TEST_POSTGRES_SHARD_COUNT`, `testPostgresCommand`, `urlWithLogin`, `catalogMigrations`, `app.citus_enabled`,
  `app.tenant_colocation`, `app.citus_table_kind`, `app.distribute_by_tenant`, `app.distribute_by_user`,
  `app.make_reference`, `configureCitusSession`, and the log line
  `Citus detected: migration session uses local execution and sequential shard modification` are spelled the same
  in every task, the contracts and the tests.
- **Deviations from the design, with reasons.** (1) `00-citus.sql` is added: the design assumed the image's init
  script still runs under our mount; it does not. (2) `app.tenant_colocation` is created by the migration (design
  section 4.3 sketch) rather than on first use (P-16), so it exists, plain and empty, on plain Postgres too; the two
  app-shaped specs list it. (3) `app.citus_table_kind(regclass)` is an extra helper shared by the three
  procedures. (4) `allowExternalUrl` is an extra option, for `database.int-spec.ts`, which creates databases and
  must never run against a shared URL. (5) The two "no table in public" specs filter `BASE TABLE` because Citus puts
  its views in `public`. (6) Design decision 11.1 calls plain Postgres an unsupported fallback that "nothing
  tests"; Task 3 still checks the helpers' no-op path, because it costs one `create database` inside the same
  Citus container and the no-op is part of the helpers' contract. It is not a supported target.
- **Re-read of the design after the reconcile pass (16:07).** Sections 4, 6, 8 and 9 kept their content; new
  material that touches this wave was folded into Task 4: rule 2.1.3 (no FK between distributed and
  coordinator-local tables), rule 2.1.8 (`PLATFORM_TENANT_ID`, nil UUID), section 4.2 (tables created after
  SH-5/SH-6 distribute inline; billing lane order B2-6 → SH-6 → B3-5/B3-6 → G-1 → L-10). Section 6 said the
  image's init script creates the extension under compose; Task 2 corrects that in code and in `docs/DOCKER.md`,
  and the plan review (2026-11-10) corrected the design's section 6 text and its volume note.

## Plan review (2026-11-09)

Status: DONE (review:s, third pass, 2026-11-10 00:20-01:00 +07; the second pass was cut off at 20:41 by a network
outage after recording probes a-d; the first pass recorded nothing, its in-place edits were re-reviewed as part of
the plan). `feat/domains-tenancy` moved to `13030b0` (E Tasks 1-2 merged) during this pass; every anchor was
re-checked against it.

Re-dispatch check (2026-11-10 01:31 +07): the workflow re-sent the "continue" task after the third pass had
finished. Nothing was re-run: `feat/domains-tenancy` is still `13030b0`; the C, E and ledger plans are unchanged
since 16:47 on 2026-11-09; the G and B2 plans, edited at 01:31, still use the contract above (G Task 10 picks its
variant by `fd -t f index.ts libs/testing/src/postgres`; B2 uses `startTestPostgres()` and its own identity
`0001`, not the platform index); the five headers pass `bunx commitlint` again (89, 71, 89, 64, 78 characters);
testcontainers and `@testcontainers/postgresql` are 12.2.0 (`withPlatform` at
`generic-container.d.ts:52`) and postgres.js is 3.4.9; no `prog-probe-*` container or network exists.

### Changes made to this plan

1. **Executive summary** rewritten to 38 lines; the false "could not run Docker" line replaced by the review's
   real runs; Goal/Architecture/Stack/Spec moved under their own heading.
2. **`bun install`** (controller ruling): the implementer runs it in the worktree in Task 1 Step 7 (sandbox off)
   and commits `bun.lock` with Task 1; fixed in Global Constraints, the `bun.lock` row, the execution-order table
   and Step 7 (it was "ask the controller" in all four).
3. **Task 1 Step 2** expected output: Vitest 5.0.3 prints "Cannot find module
   '/src/postgres/start-test-postgres.js'", not "Failed to load url" (measured).
4. **Task 1 Steps 6 and 8, Task 3 Steps 5, 7 and 8**: exact test counts from the review runs (5; 16/15/6; 19 and
   86; 25; 15 and 6) instead of "same count as before"; `database:int` runs two containers at once (noted in
   Global Constraints).
5. **Task 3 Step 2** expected messages replaced by the real ones (`Tests 3 failed | 16 passed (19)`,
   `expected [ 'migrate' ] to deeply equal [ …(3) ]`, `expected false to be true`, `ENOENT`).
6. **Task 1 Step 9 docs**: three edits had nested backticks that Prettier had collapsed into unusable text
   (`` `startTestPostgres()`from`@platform/testing/postgres`(Citus… ``, the TESTING.md "Needs" cells, the
   `libs/testing/README.md` rows). Each is now an exact old/new pair in fenced blocks. The `libs/database/README.md`
   anchor is a sentence wrapped over `:138-139`; the old text is quoted with its line break. The
   `libs/testing/README.md` intro now also allows `*.int-spec.ts` importers.
7. **Task 2 Step 6**: DOCKER.md "Gotchas" is a numbered list, so the two entries are items 15-16 (not bullets);
   the `check-infra.sh` sentence at `:223` gains "Citus"; the volume command names its compose project
   (`boilerplate`, `docker-compose.yml:21`).
8. **`citus.int-spec.ts`**: its code block is Prettier-formatted (this file is checked by `prettier --check`),
   which differs from Biome in one test; Step 10's `npx biome check --write libs/database` settles it (the only
   Biome diff in the plan's code, measured).
9. **Shared files** table rewritten: E-1/E-2 marked merged, wrong E task numbers fixed (the `db:check` script is
   E-1, not E-3), rows added for `libs/database/package.json`, `database.int-spec.ts`, `run-migrations.spec.ts`,
   `libs/database/README.md`, the platform migration index and the two app-shaped int specs (S before B2), with a
   merge-order column. C's plan has no compose change (E's overlap table says it does; `rg` finds none).
10. **Line hints** moved to `13030b0`: `ci.yml:104-105`/`:102-136`, `identity/package.json:64`,
    `billing/package.json:57`, `DEVELOPMENT.md:466`.
11. **Global Constraints, Layering**: the E mapping and the guard's scope (all of `libs/testing/src/**`) spelled
    out.
12. **Design section 6** (`docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md`): the init-script
    bullet now says the compose mount hides the image script and SH-2 adds `00-citus.sql`; the volume note says
    an old Alpine `pg-data` volume lacks the extension; the Testcontainers bullet lists the real dependencies
    (`@testcontainers/postgresql`, `postgres`).

Checked and left as written: every path, import and symbol (`PostgreSqlContainer` with a non-postgres image and
`withPlatform`/`withCommand`/`getConnectionUri` in testcontainers 12.2.0; postgres.js 3.4.9 `decodeURIComponent`s
URL logins, `src/index.js:549-550`; `createFakeSql` normalizes queries so `startsWith('set citus.')` holds;
`TEST_ONLY` matches the subpath; the `0001` journal `when` is newer than `0000_init`'s); the four headers and the
merge subject pass `bunx commitlint` (89, 71, 89, 64, 78 characters) and every body line is at most 97 characters;
the controller rulings (plain-Postgres no-op test kept, 512M limit with an OOM report, no `workers` option before
SH-11, DOCKER.md volume recreation) were already in the plan.

### Probe results

All on `citusdata/citus:14.2.0` (linux/amd64 under emulation); commands and outputs in the appendix.

- **(a)** (second pass) `CREATE DATABASE` works on the coordinator; the new database has no `citus` extension.
- **(b)** Confirmed twice. Remote execution on one node connects to `localhost:5432`, trusted by the image's
  `pg_hba.conf` for every role; a non-superuser over TCP is really password-checked. Without
  `citus.propagate_set_commands = 'local'` the shard query does not see `SET LOCAL app.tenant_id` (0 rows), with
  it it does (1 row). New control: under local execution both give 1 row, so only `localExecution: false` catches
  the bug.
- **(c)** The plan's `0001` runs in one transaction on Citus and on a plain database, re-applies cleanly, places
  the five tables as the spec expects (tenant tables share the anchor's group, user tables their own), is a no-op
  on the second run, raises on each kind change and on a misspelt table (plain too).
- **(d)** With role default `citus.enable_local_execution = off`, the fixture applies only when the session turns
  local execution on (`sequential` alone fails with `type "catalog.order_status" does not exist`). The parallel
  control fails with Citus' parallel-operation error and the sequential one passes (0 vs 3 tables).
- **Task 2's compose service** (emulated with `docker run`, the review may not run `docker compose`): the init
  folder runs `00-citus.sql` then `01-extensions.sql`; the new `check-infra.sh` queries print the
  preload `citus,pg_stat_statements`, the extensions `citus,pg_stat_statements,pg_trgm,plpgsql`, PostgreSQL 18.4,
  `shard_count=8` and Citus 14.2.0; 105 MiB of the 512 MiB limit after init.
- **Real runs of the plan's code** (scratch copy of `13030b0`, containers named `prog-probe-tc-*` by a probe-only
  `.withName(…)` patch, Ryuk off): Task 1 unit red then 8/8, `testing:int` 5/5; Task 3 unit red (3) then 86/86;
  `database:int` 25/25, `identity:int` 15/15, `billing:int` 6/6; E's `scripts/libs-vocabulary.spec.ts` 3/3 with
  every S file in place; root `tsc`, Biome and ESLint clean. Removing `set citus.enable_local_execution to on`
  from the runner makes the first `runMigrations()` int test fail as the plan predicts.

### Shared files and merge order

See the rewritten "Shared files" table under "Lane and files". In short: no S file conflicts with a block another
lane edits; all four S tasks must merge before B2 executes (the app-shaped int specs and the platform index `0001`
are the hard ordering points); `bun.lock` is regenerated by whichever lane merges second.

### Unresolved

None that blocks execution. Notes for the implementer: Task 1's intermediate state (Citus without `0001`) was not
run separately (the review ran the specs after Task 3; Task 1 only adds the `BASE TABLE` filter, which the probe
shows is sufficient); the Task 2 compose run (`check-infra.sh`) was not run by the review because it boots the
whole infra stack under `docker compose`, which the review rules forbid; its Postgres half was emulated with
`docker run` (appendix).

## Appendix: probe evidence

All probes ran on 2026-11-09 on Apple Silicon (Docker 29.9.2, arm64 host) with
`docker pull --platform linux/amd64 citusdata/citus:14.2.0`, in containers named `prog-probe-*` without published
ports, driven by `docker exec … psql` (and, for the runner, by the repo's own code from the host through a
`127.0.0.1` random port where noted). Every container and network was removed afterwards.

**Container.** Same command as `testPostgresCommand({ localExecution: true })`:

```text
$ docker run -d --name prog-probe-citus --platform linux/amd64 -e POSTGRES_DB=app -e POSTGRES_USER=app \
    -e POSTGRES_PASSWORD=app citusdata/citus:14.2.0 postgres -c citus.shard_count=4 -c citus.enable_local_execution=on
ready (pg_isready -h 127.0.0.1) after ~10 s
select citus_version(), version(), current_setting('citus.shard_count'), current_setting('shared_preload_libraries'), …
Citus 14.2.0 on x86_64-pc-linux-gnu, … | PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) on x86_64-pc-linux-gnu, … | 4 | citus | plpgsql 1.0,citus 14.2-1
$ docker exec prog-probe-citus ls /docker-entrypoint-initdb.d/      → 001-create-citus-extension.sql
  BEGIN; CREATE EXTENSION citus; UPDATE pg_dist_node_metadata SET metadata=jsonb_insert(metadata, '{docker}', 'true'); COMMIT;
$ docker exec prog-probe-citus cat /var/lib/postgresql/18/docker/pg_hba.conf   (comments dropped)
local all all trust | host all all 127.0.0.1/32 trust | host all all ::1/128 trust | (replication ×3 trust) | host all all all scram-sha-256
```

**(a) CREATE DATABASE on the coordinator: works; the new database has no citus.**

```text
app=# show citus.enable_create_database_propagation;   → off
app=# create database plain; create database race;
NOTICE:  Citus partially supports CREATE DATABASE for distributed databases
DETAIL:  Citus does not propagate CREATE DATABASE command to other nodes
CREATE DATABASE   (×2)
plain=# select count(*) from pg_extension where extname='citus';          → 0
plain=# select coalesce(to_regclass('pg_catalog.pg_dist_partition')::text,'NULL');  → NULL
plain=# select uuidv7() is not null;                                       → t
```

The NOTICE is harmless: every admin client in `database.int-spec.ts` and `citus.int-spec.ts` passes
`onnotice: noop`.

**(b) `citus.enable_local_execution=off` on one node: remote execution authenticates over loopback, and the RLS
context reaches the shard query only with `citus.propagate_set_commands = 'local'`.** Second container
`prog-probe-remote`, command `postgres -c citus.shard_count=4 -c citus.enable_local_execution=off`:

```text
app=# select create_distributed_table('probe_accounts', 'tenant_id');   (tenant_id uuid, id int, pk (tenant_id, id); 2 rows, tenants …01 and …02)
app=# select nodename, nodeport, groupid, noderole from pg_dist_node;   → localhost | 5432 | 0 | primary  (auto-registered)
app=# set citus.log_remote_commands = on; select count(*) from probe_accounts where tenant_id = '…0001';
NOTICE:  issuing SELECT count(*) AS count FROM public.probe_accounts_102010 probe_accounts WHERE (tenant_id OPERATOR(pg_catalog.=) '…0001'::uuid)
DETAIL:  on server app@localhost:5432 connectionId: 1
(local container, same query)  NOTICE:  executing the command locally: SELECT count(*) AS count FROM public.probe_accounts_102010 …
```

The loopback connection goes to `localhost:5432`, which the image's `pg_hba.conf` trusts (`127.0.0.1/32`, `::1/128`),
so it authenticates for any role. RLS, as a non-superuser `probe_rt` (password `p@ss:w/rd%41 é`) connected over
TCP to the container's bridge IP (the `scram-sha-256` line, so the password is really checked; a wrong one fails
with `password authentication failed for user "probe_rt"`), policy
`using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`:

```text
begin; set local app.tenant_id = '…0001';                               (no propagation)
NOTICE:  issuing BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;SELECT assign_distributed_transaction_id(…)
 no-propagate multi-shard | 0          ← the shard sessions never saw app.tenant_id
 no-propagate router t1   | 0
begin; set local citus.propagate_set_commands = 'local'; set local app.tenant_id = '…0001';
NOTICE:  issuing BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;set local app.tenant_id = '0190f3a0-…0001';set local citus.log_remote_commands = on;SELECT assign_distributed_transaction_id(…)
 propagate multi-shard | 1
 propagate router t1   | 1
 propagate router t2   | 0
```

So `localExecution: false` is a real guard for B3-6/SH-7: without propagation the policy silently sees no tenant
on the shard.

**(c) The SH-3 helper SQL as written runs, on Citus and on plain Postgres, idempotently.** The plan's
`0001_citus_helpers.sql` block was extracted verbatim (114 lines) and applied with `psql -1` (one transaction, as
drizzle does) after `CREATE SCHEMA IF NOT EXISTS "app"`:

```text
0001 applied in one transaction on app (citus)
0001 applied on plain
0001 re-applied on app        (NOTICE: relation "tenant_colocation" already exists, skipping)
-- the five helper tables of citus.int-spec.ts, then the five distributeAll() calls, twice:
== citus, first run  (pg_dist_partition: t | kind | colocationid | shards)
 helpers.alerts    | hash:user_id   | 4 | 4
 helpers.devices   | hash:user_id   | 4 | 4
 helpers.orders    | hash:tenant_id | 3 | 4
 helpers.regions   | reference      | 2 | 1
 helpers.shipments | hash:tenant_id | 3 | 4
 probe_accounts    | hash:tenant_id | 1 | 4     ← an unrelated tenant_id table distributed earlier with the default
 tenant_colocation | hash:tenant_id | 3 | 4       colocation: the anchor did NOT join it (explicit 'none' + anchor)
== citus, second run: identical rows
== kind changes
ERROR:  app.make_reference(helpers.orders): already distributed (hash:tenant_id)
ERROR:  app.distribute_by_tenant(helpers.regions): already a Citus table of another kind (reference), not colocated with app.tenant_colocation
ERROR:  app.distribute_by_tenant(helpers.devices): already a Citus table of another kind (hash:user_id), not colocated with app.tenant_colocation
ERROR:  app.distribute_by_user(helpers.orders): already a Citus table of another kind (hash:tenant_id)
ERROR:  app.distribute_by_tenant(probe_accounts): already a Citus table of another kind (hash:tenant_id), not colocated with app.tenant_colocation
ERROR:  relation "helpers.nope" does not exist
== plain (database from (a)), distributeAll twice: two runs OK
 citus ext 0 | pg_dist_partition NULL | app.citus_enabled() f | app.citus_table_kind('helpers.orders') NULL
 insert into helpers.orders … ; select count(*) → 1
 select app.make_reference('helpers.nope') → ERROR:  relation "helpers.nope" does not exist
```

Note: `logicalrelid::text` prints `tenant_colocation` unqualified because the role is named `app`, so schema
`app` is on its `"$user", public` search path. The specs pass qualified names in and never compare that text.

**(d) The runner's session settings, with drizzle's real migrator.** A third container `prog-probe-runner`
(`-c citus.enable_local_execution=off`, i.e. `localExecution: false`; port published on `127.0.0.1` only) and a
Node 24.4.0 script that imports `postgres` 3.4.9 and `drizzle-orm` 0.45.4 `migrate()` from the repo's
`node_modules`, opens the runner's client (`max: 1, prepare: false, max_lifetime: null`), sends the given session
`SET`s, then migrates the platform set (`0000_init` + the plan's `0001`) and the plan's `0000_create_catalog.sql`
fixture (journals as in the plan), each in a fresh database with `create extension citus`:

```text
A runner SETs (local on + sequential) [session default local=off]: OK catalog.order_lines=hash:tenant_id
  catalog.orders=hash:tenant_id catalog.regions=reference tenant_colocation=hash:tenant_id
  fks=order_lines_order_fk,order_lines_region_id_regions_id_fk
B sequential only: ERROR type "catalog.order_status" does not exist
C local on only (parallel) [session default local=off]: OK (same placement and foreign keys)
D no SET: ERROR type "catalog.order_status" does not exist
```

The plan's control test ("needs sequential mode once shard commands go over connections"), transcribed line for
line (schema and enum committed first, then `begin; set local citus.enable_local_execution = off; [set local
citus.multi_shard_modify_mode = 'sequential';] <body>`), in database `d_runner`:

```text
parallel_probe: ERROR cannot modify table "order_lines" because there was a parallel operation on a distributed table in the transaction
sequential_probe: OK
{ parallel: 0, sequential: 3 }
```

So: `citus.enable_local_execution = on` is what makes a one-transaction "create enum + distribute" file work on a
server whose sessions default to remote execution (A vs B, C vs D); `sequential` is what makes "distribute, then
FK to a reference table" work once shard DDL goes over connections (the control), which is the multi-node case.
Both `SET`s and both int tests stay as written.

**Re-run, 2026-11-10 00:20-00:33 +07 (review:s third pass).** One container, removed afterwards
(`docker ps -a --filter name=prog-probe-` and `docker network ls --filter name=prog-probe-` both empty):

```text
$ docker run -d --name prog-probe-s3 --platform linux/amd64 -e POSTGRES_DB=app -e POSTGRES_USER=app \
    -e POSTGRES_PASSWORD=app citusdata/citus:14.2.0 postgres -c citus.shard_count=4 -c citus.enable_local_execution=on
ready after ~14 s; Citus 14.2.0 on x86_64-pc-linux-gnu; citus.enable_local_execution = on
app=# select table_name||':'||table_type from information_schema.tables where table_schema='public';
citus_schemas:VIEW | citus_tables:VIEW          ← views only: the BASE TABLE filter of Task 1 Step 7 is right
```

(c) The plan's `0001_citus_helpers.sql` block (Task 3 Step 3, 114 lines, `--> statement-breakpoint`
stripped) after the repo's `libs/database/src/platform/migrations/0000_init.sql`, `psql -1` (one transaction):

```text
0000+0001 applied in one transaction on app        (citus)
0000+0001 applied in one transaction on plain      (create database plain: Citus NOTICE + DETAIL + HINT, then OK)
0001 re-applied on app                             (NOTICE: relation "tenant_colocation" already exists, skipping)
== citus run 1 / run 2 (identical)   t | kind | colocationid | shards
helpers.alerts    | hash:user_id   | 3 | 4
helpers.devices   | hash:user_id   | 3 | 4
helpers.orders    | hash:tenant_id | 2 | 4
helpers.regions   | reference      | 1 | 1
helpers.shipments | hash:tenant_id | 2 | 4
tenant_colocation | hash:tenant_id | 2 | 4
== kind changes
ERROR:  app.make_reference(helpers.orders): already distributed (hash:tenant_id)
ERROR:  app.distribute_by_tenant(helpers.regions): already a Citus table of another kind (reference), not colocated with app.tenant_colocation
ERROR:  app.distribute_by_tenant(helpers.devices): already a Citus table of another kind (hash:user_id), not colocated with app.tenant_colocation
ERROR:  app.distribute_by_user(helpers.orders): already a Citus table of another kind (hash:tenant_id)
ERROR:  relation "helpers.nope" does not exist
== plain: distributeAll twice OK; citus ext 0 | pg_dist_partition NULL | app.citus_enabled() f | citus_table_kind NULL
insert into helpers.orders … ; count → 1;  app.make_reference('helpers.nope') → ERROR: relation "helpers.nope" does not exist
```

(d) The plan's `0000_create_catalog.sql` fixture (breakpoints stripped), as drizzle applies it: bookkeeping schema
first, then `begin; <file>; commit;` on one session, in fresh databases with `create extension citus` + platform
`0000`+`0001`, each with `alter role app in database d_x set citus.enable_local_execution = off`:

```text
a [set citus.enable_local_execution to on; set citus.multi_shard_modify_mode to 'sequential'] → OK
   catalog.regions=reference tenant_colocation=hash:tenant_id catalog.orders=hash:tenant_id catalog.order_lines=hash:tenant_id
   fks: order_lines_order_fk,order_lines_region_id_regions_id_fk
b [sequential only]  → ERROR: type "catalog.order_status" does not exist  CONTEXT: while executing command on localhost:5432
c [local on only]    → OK (same placement)
d [no SET]           → ERROR: type "catalog.order_status" does not exist
== control (citus.int-spec.ts "needs sequential mode…"), database app, schema+enum committed first, then
   begin; set local citus.enable_local_execution = off; [set local citus.multi_shard_modify_mode = 'sequential';] <body>; commit
parallel_probe   → ERROR: cannot modify table "order_lines" because there was a parallel operation on a distributed table in the transaction
                   DETAIL: When there is a foreign key to a reference table, Citus needs to perform …
sequential_probe → OK
pg_dist_partition: parallel_probe.% 0 | sequential_probe.% 3
```

(b) Same container, remote execution per session (`PGOPTIONS='-c citus.enable_local_execution=off'`):

```text
pg_dist_node: localhost:5432 primary (auto-registered by the first create_distributed_table)
superuser router query → NOTICE: issuing SELECT count(*) … FROM app.probe_accounts_102051 … DETAIL: on server app@localhost:5432
PGPASSWORD=wrong psql -h 172.17.0.2 -U probe_rt → FATAL: password authentication failed for user "probe_rt"
psql "postgresql://probe_rt:p%40ss%3Aw%2Frd%2541%20%C3%A9@172.17.0.2:5432/app" → current_user = probe_rt
RLS as probe_rt over TCP (scram), policy tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid:
  remote execution:  no-propagate multi-shard 0 | no-propagate router t1 0 | propagate multi-shard 1 | router t1 1 | router t2 0
  local execution:   no-propagate multi-shard 1 | no-propagate router t1 1 | propagate multi-shard 1 | router t1 1 | router t2 0
  propagated BEGIN: issuing BEGIN …;set local app.tenant_id = '…0001';… DETAIL: on server probe_rt@localhost:5432
pg_hba.conf: local all all trust; host all all 127.0.0.1/32 trust; host all all ::1/128 trust; (replication ×3 trust); host all all all scram-sha-256
```

The local-execution control row is new: with local execution on, the missing propagation is invisible (1 row
either way), which is exactly why the RLS specs need `localExecution: false`. The shard connection logs in as the
calling role (`probe_rt@localhost`) under the loopback `trust` lines.

Testing int-spec router query (fresh database without schema `app`, `prepare s(uuid)` + `execute`, like
postgres.js' prepared statements): local on → `NOTICE: executing the command locally: SELECT count(*) … FROM
public.probe_accounts_102010 …`; local off → `NOTICE: issuing SELECT count(*) …` with `DETAIL: on server
app@localhost:5432`. Side finding: once the platform set has run, an unqualified `create table` by role `app`
lands in schema `app` (search path `"$user", public`), so the RLS probe above used `app.probe_accounts`.

**Task 2's compose service, emulated with `docker run`** (the review may not run `docker compose`): the plan's
`postgres` flags, the 512 MB / 1.5 CPU limits, and the repo's `docker/postgres/init` folder plus the plan's
`00-citus.sql` mounted read-only over `/docker-entrypoint-initdb.d`; then the plan's new `check-infra.sh` queries:

```text
$ docker run -d --name prog-probe-s3-compose --platform linux/amd64 --memory 512m --cpus 1.5 --shm-size 128m \
    -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app -v <init>:/docker-entrypoint-initdb.d:ro \
    citusdata/citus:14.2.0 postgres -c max_connections=200 -c shared_buffers=128MB … \
    -c shared_preload_libraries=citus,pg_stat_statements -c citus.shard_count=8 -c citus.max_shared_pool_size=180 …
healthy (TCP pg_isready -h 127.0.0.1) after ~12 s
docker-entrypoint.sh: running /docker-entrypoint-initdb.d/00-citus.sql
docker-entrypoint.sh: running /docker-entrypoint-initdb.d/01-extensions.sql
preload OK
  preload: citus,pg_stat_statements; extensions: citus,pg_stat_statements,pg_trgm,plpgsql; 18.4 (Debian 18.4-1.pgdg13+1) uuidv7=01a1c16e-… shard_count=8 Citus 14.2.0 on x86_64-pc-linux-gnu, …
docker stats: 104.5MiB / 512MiB
```

The plan's compose edit, applied to a copy of `docker-compose.yml`, parses (`yaml`) to `image
citusdata/citus:14.2.0`, `platform linux/amd64`, the three `-c` values and the unchanged 512M limit, and passes
`prettier --check`. Container removed; `docker ps -a --filter name=prog-probe-` is empty.
