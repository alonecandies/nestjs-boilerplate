# Ledger Wave 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Executive summary

- **Scope:** ledger wave 0 (spec section 8): L-1..L-9 as 11 tasks (L-2, L-8 split a/b). No tenant
  columns, billing Postgres migrations, outbox or app wiring.
- **Order:** `libs/immudb` first: L-1 → L-2a → L-2b → L-3; L-2a → L-6; L-1 → L-4 → L-5 (needs L-2b).
  Billing after **G-11**: L-7, L-8a → L-8b → L-9 (needs L-3, L-5). **L-7 and L-8a merge before B2
  edge Lane B Task 1** (controller ruling 2026-11-10; that task quotes post-L-7 code and rewrites
  L-8a's `PLATFORM_TENANT_ID` line).
- **Client:** ts-proto `grpc-js` client from the vendored, stripped v1.11.2 `schema.proto` (own
  `buf.gen.yaml`); session pool with keepalive; `readWrite` never rolls back after a failed
  statement; error kinds mapped from server strings; migrator provisions an INSERT/SELECT-only user.
- **Verification:** port from Apache-2.0 `v1.9DOM.1` only (BUSL-1.1 `v1.11.2` never copied);
  vectors captured from the container; `Alh(header) === state.txHash` as oracle.
- **Billing:** L-7 S-1/S-3/S-5/S-8/S-10; L-8a/L-8b model, posting rules, `LedgerPort`,
  `InMemoryLedger` (`@domain/billing/testing`), shared contract; L-9 `ImmudbLedgerAdapter`.
- **Review 2026-11-10 (run 2), 16 findings fixed in place**, 7 of them would have failed a task:
  R-1 expired sessions say `no session found` (not `session not found`; v1.9DOM.1 and v1.11.2
  `sessions/errors.go:29`); R-2 `all-config.spec.ts` pins the namespace list; R-3 pool queueing test
  threw `release is not a function`; R-4 Biome `useIterableCallbackReturn` in the vector spec; R-5
  vectors proved since tx 0 (= "the tx itself"); R-10 compose/Prometheus YAML at column 0; R-11 L-7
  quoted `complete()` text that does not exist. Also: concurrent provisioning/catalog races (R-6),
  `COUNT(*)` on an empty table (R-7), aggregate selector naming (R-8), adapter vs fake semantics for
  a trusted state ahead of the store (R-9), ordering (R-12), commit bodies wrapped to 100 (R-13),
  missing buf/ts-proto devDeps (R-14), text fixes (R-15), BUSL-1.1 + Additional Use Grant in
  `docs/DOCKER.md` (R-16), S-4 remainder as later-wave row S-4b.
- **Evidence:** all libs/immudb, libs/config and billing-ledger code blocks extracted to a scratch
  workspace: `tsc` exit 0, 19 unit spec files / 198 tests green after the fixes (2 failed before),
  Biome lint clean apart from the scratch manifests' dependency rule. Proto sha256, strip output,
  buf output, golden ids/hash recomputed. Port fidelity checked function by function (v1.9DOM.1).
- **Docker was down:** no container probe ran. Selector format, `UPSERT` text, concurrent
  `CreateUser`, `--signingKey`, `GROUP BY … COUNT(*)`, `HISTORY OF` without `WHERE`: **unverified,
  the L-9 (or named L-2b/L-3/L-5) int spec must confirm it**; fallbacks are written in each task.
- **Not run:** L-7 (edits existing code, checked by reading), ESLint, vector specs (need captures).
- **User decision left:** legal review of running the BUSL-1.1 server under its Additional Use Grant.

**Goal:** Build everything of the immudb ledger that needs neither tenant columns nor the outbox: a typed,
verified immudb client library, its config and compose service, the billing ledger model with a fake and
an immudb adapter behind one contract spec, and the schema-free Stripe idempotency fixes.

**Architecture:** `libs/immudb` (`@platform/immudb`, names no domain) owns the generated gRPC client,
session pool, transactions, error mapping, migrator/provisioning and pure proof verification. Billing owns
the ledger model (`domain/ledger`), posting rules and `LedgerPort` (`application`), and the immudb adapter
plus its `001_ledger.sql` (`infrastructure/ledger`). Tenancy on immudb rows is a column checked in code.

**Tech Stack:** Node 24.4.0, TypeScript 6 (strict, NodeNext), NestJS, `@grpc/grpc-js` 1.14.6, ts-proto
2.13.3 via buf 1.73.0, `@bufbuild/protobuf` 2.15.0, `uuid` 14.0.3, Stripe 22.6.2, Vitest 5, testcontainers
12.2.0, immudb `codenotary/immudb:1.11.2`.

**Spec:** `docs/superpowers/specs/2026-11-09-stripe-ledger-immudb-design.md` (binding: section 8 tasks,
"Interface contracts"); program spec `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md`;
conventions `docs/superpowers/plans/program-work/conventions.md`.

## Global Constraints

- **Node:** prefix every command with
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;` and run it from
  the lane worktree root. Full Vitest, int specs (Docker), e2e and GPG signing run outside the sandbox.
- **Worktree:** this lane runs in its own git worktree off `feat/domains-tenancy` (under the session
  scratchpad, never inside the repo); merged back `--no-ff -S` by the controller. Never two implementers in
  one checkout.
- **Dependencies:** only the controller runs `bun install` (one at a time). A task that changes a
  `package.json` stops at its "Controller: `bun install`" step; the controller runs
  `bun install` in the worktree and **commits nothing**; the implementer then includes `bun.lock` in the
  task's own `git add` list (one signed commit per task, `bun.lock` included when it changed).
- **Commits:** one GPG-signed commit per task (`commit.gpgsign=true` is set; never `--no-verify`).
  **No attribution lines**: this overrides `conventions.md:38-39` and `:536-537` (user ruling 2026-11-09);
  do not add `Co-Authored-By`. Header `<type>(<scopes>): <subject>` at most 100 characters, subject
  starts lower-case, no trailing period; body lines at most 100. Types: `build chore ci docs feat fix perf
refactor revert style test`. Scopes used here: `immudb` (valid once `libs/immudb/package.json` exists in
  the working tree, i.e. from L-1's own commit), `config`, `billing`, `billing-contracts`, `docker`, `ci`,
  `repo`, `deps`. Pre-check: `printf '%s\n' "<header>" | bunx commitlint`.
- **Search:** `rg` and `fd` (never `grep`/`find`; a hook blocks them); `jaq` for JSON.
- **Formatting:** after editing TypeScript run `npx biome check --write <files>`; after Markdown/YAML run
  `npx prettier --write <files>`. Match edits on the quoted old text; line numbers are hints.
- **Layering:** `libs/immudb` imports no `@domain/*`/`@app/*` and names no domain (no "ledger", "billing",
  "stripe" in identifiers, SQL or messages). Billing imports `@platform/immudb` only from
  `infrastructure/**` and `testing/**`. `@platform/immudb/testing` and `@domain/billing/testing` are imported
  only from specs, `test/**` or `src/testing/**` (`scripts/check-boundaries.mjs` `TEST_ONLY`).
- **Generated code:** `libs/immudb/src/generated/**` is produced by `bun run --filter @platform/immudb
proto:gen`, committed, never hand-edited; Biome, ESLint, Prettier, the boundary checker and coverage
  already ignore `**/generated`. Never set fields marked `[deprecated = true]` (in v1.11.2 only
  `SQLQueryRequest.reuseSnapshot`) and never call the deprecated RPCs (`Login`, `Logout`,
  `CreateDatabase`, `CreateDatabaseWith`, `DatabaseList`, `UpdateDatabase`, `GetDatabaseSettings`,
  `UpdateAuthConfig`, `UpdateMTLSConfig`): ts-proto emits `@deprecated` and `no-deprecated` warnings fail
  `bun run check`. Generated types stay internal to `@platform/immudb` (never re-exported from its barrel).
- **Licence:** port verification code only from immudb tag `v1.9DOM.1` (Apache-2.0); never read-and-copy
  `v1.11.2` Go code (BUSL-1.1). Record every ported function in `libs/immudb/THIRD_PARTY_NOTICES.md`.
- **Money and time:** ledger amounts are `bigint` end to end (immudb `INTEGER` = int64, wire `string`);
  times are epoch microseconds `bigint`. Never `Number()` an amount.
- **No schema dependency (D5):** wave-0 code must not read or write `tenant_id`, `request_hash` or the new
  payment statuses on Postgres tables, nor add billing migrations.
- **Config:** every new env key is defaulted (`validateAllEnv({})` must pass), documented in the root
  `.env.example` above `# docker compose ONLY`, and in `docs/CONFIGURATION.md`; check with
  `node scripts/check-env-example.mjs`.
- **Tests:** unit `npx vitest run --project <project> <path filter>`; int
  `INTEGRATION=1 npx vitest run --project <project>:int <path filter>` (Docker, sandbox off; int specs use
  `describe.skipIf(process.env['INTEGRATION'] !== '1')`). Static gate: `bun run check`. Boundary spec:
  `npx vitest run --project scripts`.
- **Docker:** int specs start their own containers through testcontainers; compose checks run only in an
  isolated project (`PROJECT=ledger-infra-check`, shifted `*_HOST_PORT`s), never the developer's
  `boilerplate` project or ports 5432/6379; any `down -v` is guarded on `COMPOSE_PROJECT_NAME`.

## Review Focus

Five failure modes no task's happy-path tests would otherwise catch; each has a named test in its task.

1. **A failed statement ends the server transaction** (spec P6:712, P8:733). Calling `Rollback` afterwards
   returns `no transaction found` and hides the real error. Test: L-2b int spec "a duplicate-key insert
   surfaces `duplicate-key`, not `tx-closed`, and the session stays usable".
2. **Result column naming.** immudb names result columns `(table.col)`, aliased ones `(table.alias)` and
   unaliased aggregates `(table.colN)` (`EncodeSelector`, `proj_row_reader.go` `Columns`); a wrong
   normalisation silently returns
   `undefined` fields. Test: L-2a unit table for `columnKey`, L-2b int spec pins the raw selector of a plain
   column, an alias and an aliased `SUM`.
3. **Session expiry and pool poisoning.** Sessions die after 3 min idle or a server restart (`no session
found`); a dead session must be discarded, not returned to the pool. Test: L-2b int spec closes a pooled
   session behind the client's back and asserts the next `readOnly` succeeds on a fresh session.
4. **int64 money round trip.** Values above 2^53 and negative values must survive params and rows. Test:
   L-2a codec unit table and L-2b int spec inserting `9007199254740993n` and `-1n`.
5. **Proof direction and tampering.** A trusted state newer than the target, a source equal to the target,
   and any flipped byte in any proof component must fail closed. Test: L-4 vector spec (every component
   flipped), L-5 int spec (`trusted.txId > target.txId` rejected; row value flipped rejected).

## Lane and files

**Owned exclusively by this lane:**

- `libs/immudb/**` (new package `@platform/immudb`).
- `libs/config/src/namespaces/immudb.config.ts`, `libs/config/src/namespaces/immudb.config.spec.ts`.
- `domains/billing/src/domain/ledger/**`, `domains/billing/src/application/ledger/**`,
  `domains/billing/src/application/ports/ledger.port.ts`, `domains/billing/src/infrastructure/ledger/**`,
  `domains/billing/src/testing/in-memory-ledger.ts`, `domains/billing/src/testing/in-memory-ledger.spec.ts`,
  `domains/billing/src/testing/ledger.contract.test.ts`.

**Shared files (exact changes):**

| File                                                        | Task            | Change                                                                                                                                                     |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (root)                                       | L-1             | catalog `"@bufbuild/protobuf": "2.15.0"`; `proto:gen` gains `--filter @platform/immudb`                                                                    |
| `bun.lock`                                                  | L-1, L-8a, L-9  | regenerated by the controller's `bun install`; committed by the task                                                                                       |
| `.github/workflows/ci.yml`                                  | L-1             | drift step adds `libs/immudb/src/generated` and `libs/immudb/proto` to its `git status --porcelain` paths                                                  |
| `libs/config/src/all-config.ts`, `libs/config/src/index.ts` | L-2a            | import + `immudb: immudbConfig` in `CONFIG_NAMESPACES`, `immudb: ImmudbConfig` in `AllConfig`, one export line                                             |
| `.env.example` (root)                                       | L-2a, L-6       | L-2a: `# ── immudb: …` section after the cassandra section; L-6: `# IMMUDB_HOST_PORT=3322` in the compose-only section                                     |
| `docs/CONFIGURATION.md`                                     | L-2a            | namespace-table row `immudb` + a `### immudb` variable table + production-guard row                                                                        |
| `docker-compose.yml`                                        | L-6             | `x-env-immudb` anchor, services `immudb`, `immudb-init`, volume `immudb-data`, `infra-ready.depends_on`                                                    |
| `scripts/docker/check-infra.sh`                             | L-6             | `immudb-init` in the init list, `/readyz` check, port loop entry                                                                                           |
| `docker/prometheus/prometheus.yml`                          | L-6             | job `immudb` (static target `immudb:9497`) appended after job `jaeger`                                                                                     |
| `docs/DOCKER.md`                                            | L-6             | `immudb`/`immudb-init` rows in the stack map + bootstrap/backup note                                                                                       |
| `docs/API.md`, `domains/billing/README.md`                  | L-7, L-9        | new 409 codes and replay semantics (L-7); "Ledger (immudb)" section (L-9)                                                                                  |
| `domains/billing/package.json`                              | L-8a, L-8b, L-9 | L-8a `"uuid": "catalog:"`; L-8b `exports["./testing"]` (unless G-11 added it); L-9 `"@platform/immudb": "workspace:*"`, dev `"testcontainers": "catalog:"` |
| `domains/billing/src/index.ts`                              | L-8a, L-8b, L-9 | appended export lines (placement rules in each task; after G-11 the root barrel keeps core/domain exports)                                                 |
| `domains/billing/contracts/src/events/billing.events.ts`    | L-7             | optional `stripePaymentIntentId` on `paymentSucceededPayload`                                                                                              |
| `domains/billing/src/billing-core.module.ts`                | L-7             | one `makeCounterProvider` for `billing_checkout_amount_mismatch_total`, one for `billing_stripe_api_version_mismatch_total`                                |
| `README.md:63` test count                                   | none            | left to the phase checkpoint (conventions §3)                                                                                                              |

## Decisions for the user and deviations from the spec

1. **Licence (recorded, not optional to ignore):** immudb `v1.11.2` Go code is BUSL-1.1 (`LICENSE`:
   "Licensed Work: immudb Version 1.9DOM.2 or later"); the spec's "Apache-2.0" is wrong. This plan ports
   from `v1.9DOM.1` (Apache-2.0, identical algorithms, verified by diff on 2026-11-09) and records it in
   `THIRD_PARTY_NOTICES.md`. Running the `v1.11.2` **server** image is unaffected (the BUSL grant allows
   production use that is not a competing database offering). Decide whether legal review is wanted.
2. **Vectors from the container, not Go** (spec 6.4 says "produced once by the Go SDK"): a committed
   script `libs/immudb/scripts/capture-vectors.mjs` captures `CurrentState`, `VerifiableTxById` and
   `VerifiableSQLGet` responses from `codenotary/immudb:1.11.2` using the L-1 generated client. This removes
   the Go toolchain and BUSL code from the repo. The independent oracle is `Alh(header) === state.txHash`.
3. **S-3 without `Retry-After`:** `DomainExceptionOptions` has no header hook (only the maintenance
   middleware sets `retry-after`, `libs/common/src/middlewares/maintenance-mode.middleware.ts:74`). L-7 puts
   `retryAfterSec: 1` in the problem `details`; a header needs a `libs/common` filter change (C lane area).
4. **S-1 on a paid session:** the spec returns 409 `CHECKOUT_SESSION_CLOSED` when a replay finds the
   session `complete` (today, within Stripe's 24 h window, the replay returns the same session). Kept as
   specified; say so if a replay after payment should instead return the session with a `null` URL.
5. **`IMMUDB_CLIENT` token:** the spec prose names a token `IMMUDB_CLIENT`; the binding contract has the
   abstract class `ImmudbClient`. The abstract class is the DI token (like every port in this repo).
6. **Tenant gating in wave 0:** `PLATFORM_TENANT_ID` reads/posts "only inside `SystemContext`" (spec
   section 5) cannot be enforced before B3-10. The adapter takes an explicit `tenantId`; tenant reads use SQL
   module constants that a unit spec pins to contain `tenant_id = @tenant`; principal gating lands with
   `LedgerService` in wave 2 (L-12).
7. **Neutral immudb defaults:** `IMMUDB_DATABASE` defaults to `app` and `IMMUDB_USERNAME` to
   `app_writer` (spec 6.2: `ledger`, `ledger_app`), because `libs/config` must name no domain. Compose and
   production may set `IMMUDB_DATABASE=ledger`; nothing in code depends on the name.
8. **Admin credentials optional:** `IMMUDB_ADMIN_PASSWORD` has no default (spec 6.2 implies one), so an
   app that never migrates carries no superuser secret and the production guard only fires when it is set.

## Execution order

| #   | Task                                              | Waits for      | Notes                                                                           |
| --- | ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| 1   | L-1 `@platform/immudb` package + codegen          | nothing        | controller `bun install` mid-task                                               |
| 2   | L-2a config namespace, value codec, error map     | L-1            | touches `libs/config` registry (serialize with B3/C/G edits of `all-config.ts`) |
| 3   | L-2b session pool, `ImmudbClient`, module, health | L-2a           | first int spec                                                                  |
| 4   | L-4 proof primitives + captured vectors           | L-1            | can run in parallel with L-2a/L-2b                                              |
| 5   | L-3 provisioning + migrator + CLI                 | L-2b           |                                                                                 |
| 6   | L-5 row verification + client verify methods      | L-2b, L-4      |                                                                                 |
| 7   | L-6 compose service + infra check                 | L-2a           | parallel with L-3/L-5                                                           |
| 8   | L-7 Stripe fixes                                  | G-11 merged    | merges **before** B2 edge Lane B Task 1 (controller ruling 2026-11-10)          |
| 9   | L-8a ledger model                                 | G-11 merged    | merges **before** B2 edge Lane B Task 1 (which rewrites `PLATFORM_TENANT_ID`)   |
| 10  | L-8b posting rules, port, fake, contract spec     | L-8a           |                                                                                 |
| 11  | L-9 immudb adapter + `001_ledger.sql`             | L-3, L-5, L-8b |                                                                                 |

### Task L-1: `@platform/immudb` package, vendored proto and generated gRPC client

**Files:**

- Create: `libs/immudb/package.json`, `libs/immudb/tsconfig.json`, `libs/immudb/README.md`,
  `libs/immudb/THIRD_PARTY_NOTICES.md`, `libs/immudb/buf.yaml`, `libs/immudb/buf.gen.yaml`,
  `libs/immudb/vendor/immudb-v1.11.2-schema.proto` (downloaded), `libs/immudb/scripts/strip-proto.mjs`,
  `libs/immudb/proto/immudb/schema/schema.proto` (written by the strip script),
  `libs/immudb/src/generated/**` (written by buf), `libs/immudb/src/index.ts`
- Modify: `package.json` (root) `catalog` and `scripts["proto:gen"]` (`:155`);
  `.github/workflows/ci.yml:82-83` (drift paths, after E's `db:check` line)
- Test: `libs/immudb/test/strip-proto.spec.ts`, `libs/immudb/test/generated-client.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (internal to the package; never re-exported from the barrel):
  `libs/immudb/src/generated/immudb/schema/schema.pb.ts` with `ImmuServiceClient` (grpc-js constructor
  `new (address: string, credentials: ChannelCredentials, options?: Partial<ClientOptions>)`), message
  codecs (`X.encode/decode/fromPartial`), `SQLValue.value` as `{ $case: 'null'|'n'|'s'|'b'|'bs'|'ts'|'f';
value }`, int64/uint64 as `string`, bytes as `Buffer`, enums as strings (`TxMode.ReadWrite`,
  `PermissionAction.REVOKE`). Barrel:
  ```ts
  export const IMMUDB_SERVER_VERSION = '1.11.2';
  export const IMMUDB_TEST_IMAGE = 'codenotary/immudb:1.11.2';
  ```

**Wave:** start now.

- [ ] **Step 1: Write the failing tests.** `libs/immudb/test/strip-proto.spec.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/strip-proto.mjs');
const UPSTREAM = join(ROOT, 'vendor/immudb-v1.11.2-schema.proto');
const STRIPPED = join(ROOT, 'proto/immudb/schema/schema.proto');
const UPSTREAM_SHA256 = '66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa';
const IMPORTS =
  'import "google/api/annotations.proto";\nimport "google/protobuf/empty.proto";\n' +
  'import "protoc-gen-swagger/options/annotations.proto";\n';

function strip(input: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'strip-proto-'));
  const source = join(dir, 'in.proto');
  const target = join(dir, 'out.proto');
  writeFileSync(source, input);
  const run = spawnSync(process.execPath, [SCRIPT, source, target], { encoding: 'utf8' });
  return { status: run.status, output: run.status === 0 ? readFileSync(target, 'utf8') : '' };
}

describe('strip-proto', () => {
  it('vendors the exact upstream v1.11.2 schema.proto', () => {
    const digest = createHash('sha256').update(readFileSync(UPSTREAM)).digest('hex');
    expect(digest).toBe(UPSTREAM_SHA256);
  });

  it('the committed stripped proto equals strip(upstream) (regenerate with proto:gen)', () => {
    const { status, output } = strip(readFileSync(UPSTREAM, 'utf8'));
    expect(status).toBe(0);
    expect(output).toBe(readFileSync(STRIPPED, 'utf8'));
  });

  it('keeps every rpc and the well-known imports, drops annotations', () => {
    const upstream = readFileSync(UPSTREAM, 'utf8');
    const stripped = readFileSync(STRIPPED, 'utf8');
    const rpcs = (text: string): number => text.match(/^\s*rpc \w+\(/gm)?.length ?? 0;
    expect(rpcs(stripped)).toBe(rpcs(upstream));
    expect(rpcs(stripped)).toBeGreaterThan(70);
    expect(stripped).not.toMatch(/option \(/);
    expect(stripped).not.toContain('google/api/annotations.proto');
    expect(stripped).toContain('import "google/protobuf/empty.proto";');
  });

  it('removes scalar and aggregate options, braces inside strings included', () => {
    const { status, output } = strip(
      `${IMPORTS}option (a.b) = { x: "}{"; y: { z: 1 } };\nservice S {\n  rpc A(E) returns (E) {\n` +
        '    option (google.api.http) = {\n      get: "/a/{id}"\n    };\n  }\n  option (c) = 3;\n}\n',
    );
    expect(status).toBe(0);
    expect(output).toBe(
      'import "google/protobuf/empty.proto";\nservice S {\n  rpc A(E) returns (E) {\n  }\n}\n',
    );
  });

  it('fails when upstream no longer has the imports it expects', () => {
    expect(strip('syntax = "proto3";\n').status).not.toBe(0);
  });
});
```

`libs/immudb/test/generated-client.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ImmuServiceClient,
  NewTxRequest,
  SQLQueryRequest,
  SQLValue,
  TxMode,
} from '../src/generated/immudb/schema/schema.pb.js';
import { IMMUDB_SERVER_VERSION, IMMUDB_TEST_IMAGE } from '../src/index.js';

describe('generated immudb client', () => {
  it('targets the pinned server version', () => {
    expect(IMMUDB_TEST_IMAGE).toBe(`codenotary/immudb:${IMMUDB_SERVER_VERSION}`);
  });

  it.each([
    ['openSession', '/immudb.schema.ImmuService/OpenSession'],
    ['newTx', '/immudb.schema.ImmuService/NewTx'],
    ['txSqlExec', '/immudb.schema.ImmuService/TxSQLExec'],
    ['txSqlQuery', '/immudb.schema.ImmuService/TxSQLQuery'],
    ['commit', '/immudb.schema.ImmuService/Commit'],
    ['rollback', '/immudb.schema.ImmuService/Rollback'],
    ['currentState', '/immudb.schema.ImmuService/CurrentState'],
    ['verifiableTxById', '/immudb.schema.ImmuService/VerifiableTxById'],
    ['verifiableSqlGet', '/immudb.schema.ImmuService/VerifiableSQLGet'],
    ['changeSqlPrivileges', '/immudb.schema.ImmuService/ChangeSQLPrivileges'],
    ['createDatabaseV2', '/immudb.schema.ImmuService/CreateDatabaseV2'],
  ] as const)('%s calls %s', (method, path) => {
    expect(ImmuServiceClient.service[method].path).toBe(path);
  });

  it('round-trips int64 beyond 2^53 and negatives as decimal strings', () => {
    for (const n of ['9007199254740993', '-9007199254740993', '-1']) {
      const wire = SQLValue.encode({ value: { $case: 'n', value: n } }).finish();
      expect(SQLValue.decode(wire)).toEqual({ value: { $case: 'n', value: n } });
    }
  });

  it('fills scalar defaults with fromPartial and never sets deprecated fields', () => {
    expect(NewTxRequest.fromPartial({ mode: TxMode.ReadWrite })).toEqual({
      mode: 'ReadWrite',
      unsafeMVCC: false,
    });
    expect(SQLQueryRequest.fromPartial({ sql: 'SELECT 1' })).toMatchObject({
      sql: 'SELECT 1',
      params: [],
      acceptStream: false,
    });
  });
});
```

- [ ] **Step 2: Run them.**
      `npx vitest run --project immudb` — Expected: FAIL (no project `immudb`: `libs/immudb/package.json`
      does not exist yet; Vitest reports "No projects matched the filter" or missing files).

- [ ] **Step 3: Package manifest, tsconfig, buf configs.** `libs/immudb/package.json`:

```json
{
  "name": "@platform/immudb",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "immudb over gRPC: generated client (immudb v1.11.2 schema.proto), session pool, SQL transactions, error mapping, versioned SQL migrations with provisioning, and client-side proof verification",
  "exports": {
    ".": {
      "@repo/source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "swc src -d dist --config-file ../../.swcrc --cli-config-file ../../swc.cli.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --config ../../vitest.config.ts --project immudb",
    "clean": "rimraf dist coverage",
    "proto:gen": "node scripts/strip-proto.mjs vendor/immudb-v1.11.2-schema.proto proto/immudb/schema/schema.proto && buf generate --template buf.gen.yaml"
  },
  "dependencies": {
    "@platform/config": "workspace:*",
    "@platform/observability": "workspace:*",
    "@bufbuild/protobuf": "catalog:",
    "@grpc/grpc-js": "catalog:",
    "@nestjs/common": "catalog:",
    "@nestjs/config": "catalog:",
    "@nestjs/terminus": "catalog:"
  },
  "devDependencies": {
    "@platform/testing": "workspace:*",
    "@bufbuild/buf": "catalog:",
    "@nestjs/testing": "catalog:",
    "testcontainers": "catalog:",
    "ts-proto": "catalog:"
  }
}
```

`libs/immudb/tsconfig.json` (same as `libs/cassandra/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "types": ["node", "vitest/globals"],
    "tsBuildInfoFile": "./node_modules/.cache/tsc/tsbuildinfo"
  },
  "include": ["src", "test", "*.ts"]
}
```

`libs/immudb/buf.yaml`:

```yaml
# immudb's own proto (vendored, stripped of REST/Swagger annotations by scripts/strip-proto.mjs).
# Not linted: it is upstream's API, not ours. Run `bun run --filter @platform/immudb proto:gen`.
version: v2
modules:
  - path: proto
```

`libs/immudb/buf.gen.yaml` (NOT the shared `libs/contracts/buf.gen.yaml`: that one is `nestJs=true` and is
followed by `proto-esm-fix.mjs`, whose `import type` rewrite would break this client because the grpc-js
output uses sibling messages such as `Empty` as values):

```yaml
# ts-proto with full binary codecs and a grpc-js client. Output committed; never edit src/generated.
version: v2
clean: true
plugins:
  - local: protoc-gen-ts_proto
    out: src/generated
    strategy: all
    opt:
      - outputServices=grpc-js
      - importSuffix=.js
      - esModuleInterop=true
      - env=node
      - forceLong=string
      - stringEnums=true
      - useOptionals=messages
      - fileSuffix=.pb
      - oneof=unions-value
inputs:
  - directory: proto
```

Root `package.json`: add to `catalog` (alphabetical position, before `@grpc/grpc-js`):
`"@bufbuild/protobuf": "2.15.0",` (the version already hoisted in `node_modules` as a dependency of
ts-proto 2.13.3, which requires `^2.14.1`; the lockfile resolution does not move). Replace
`"proto:gen": "bun run --filter './domains/*/contracts' --filter @platform/transport proto:gen",` with
`"proto:gen": "bun run --filter './domains/*/contracts' --filter @platform/transport --filter @platform/immudb proto:gen",`.

- [ ] **Step 4: Controller: `bun install`.** Stop and ask the controller to run `bun install` in this
      worktree (new workspace package + catalog entry). Continue when it reports success; `bun.lock` is
      committed in Step 10 of this task.

- [ ] **Step 5: Vendor the upstream proto and write the strip script.**

```bash
mkdir -p libs/immudb/vendor libs/immudb/proto/immudb/schema libs/immudb/scripts
curl -sfo libs/immudb/vendor/immudb-v1.11.2-schema.proto \
  https://raw.githubusercontent.com/codenotary/immudb/v1.11.2/pkg/api/schema/schema.proto
shasum -a 256 libs/immudb/vendor/immudb-v1.11.2-schema.proto
# Expected: 66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa
```

`libs/immudb/scripts/strip-proto.mjs`:

```js
// Strips the REST-gateway and Swagger annotations from immudb's upstream schema.proto so buf can
// compile it without googleapis/grpc-gateway: removes their two imports and every `option (...)`
// statement (scalar or `{ ... }` aggregate). Deterministic and idempotent.
// Usage: node scripts/strip-proto.mjs <upstream.proto> <out.proto>
import { readFile, writeFile } from 'node:fs/promises';

const DROPPED_IMPORTS = [
  'import "google/api/annotations.proto";',
  'import "protoc-gen-swagger/options/annotations.proto";',
];

/** Index just past the `}` closing the `{` at `open`, skipping string literals. */
function closingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  throw new Error(`unbalanced braces from offset ${open}`);
}

export function stripProto(source) {
  let out = '';
  let i = 0;
  const OPTION = /^[ \t]*option \(/gm;
  for (let m = OPTION.exec(source); m !== null; m = OPTION.exec(source)) {
    const start = m.index;
    let j = source.indexOf('=', start) + 1;
    while (source[j] === ' ') j++;
    let end = source[j] === '{' ? closingBrace(source, j) : source.indexOf(';', j);
    if (source[end] === ';') end++;
    if (source[end] === '\n') end++;
    out += source.slice(i, start);
    i = end;
    OPTION.lastIndex = end;
  }
  out += source.slice(i);
  for (const line of DROPPED_IMPORTS) {
    if (!out.includes(`${line}\n`)) throw new Error(`expected upstream import missing: ${line}`);
    out = out.replace(`${line}\n`, '');
  }
  if (/option \(/.test(out)) throw new Error('an option (...) statement survived stripping');
  return out;
}

const [input, output] = process.argv.slice(2);
if (input !== undefined && output !== undefined) {
  await writeFile(output, stripProto(await readFile(input, 'utf8')));
}
```

- [ ] **Step 6: Generate and write the barrel.** Run
      `bun run --filter @platform/immudb proto:gen`. Expected: `libs/immudb/proto/immudb/schema/schema.proto`
      (1,786 lines; only `option go_package` and `option deprecated = true` lines remain) and
      `libs/immudb/src/generated/{immudb/schema/schema.pb.ts (18,424 lines),google/protobuf/empty.pb.ts,google/protobuf/struct.pb.ts}`.
      Do not run `libs/contracts/scripts/proto-esm-fix.mjs`.

`libs/immudb/src/index.ts`:

```ts
/**
 * @platform/immudb — immudb over gRPC (never pg-wire): the client generated from immudb's
 * schema.proto, a session pool with SQL transactions and error mapping, versioned SQL migrations
 * with provisioning, and client-side proof verification. Names no domain.
 */

/** The immudb server version the vendored proto, the error strings and the int specs are pinned to. */
export const IMMUDB_SERVER_VERSION = '1.11.2';
/** Image for integration specs and compose (`docker-compose.yml` pins the same tag). */
export const IMMUDB_TEST_IMAGE = `codenotary/immudb:${IMMUDB_SERVER_VERSION}`;
```

- [ ] **Step 7: Run the tests.** `npx vitest run --project immudb` — Expected: PASS (5 + 14 tests).
      Native-ESM smoke test of the compiled client (the spec's probe P6 only used `@grpc/proto-loader`):

```bash
bun run --filter @platform/immudb build && node --input-type=module -e "const m = await import('./libs/immudb/dist/generated/immudb/schema/schema.pb.js'); console.log(typeof m.ImmuServiceClient, m.ImmuServiceClient.service.openSession.path)"
# Expected: function /immudb.schema.ImmuService/OpenSession
```

- [ ] **Step 8: Notices, README, CI drift.** `libs/immudb/THIRD_PARTY_NOTICES.md`:

```markdown
# Third-party notices: @platform/immudb

## immudb API definition (vendored)

- File: `vendor/immudb-v1.11.2-schema.proto` (stripped copy: `proto/immudb/schema/schema.proto`,
  generated code: `src/generated/**`).
- Source: https://github.com/codenotary/immudb/blob/v1.11.2/pkg/api/schema/schema.proto,
  sha256 `66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa`.
- Licence: Apache License 2.0 (header of the file). Copyright 2022 Codenotary Inc.

## Ported verification code

Ported to TypeScript from immudb tag `v1.9DOM.1` (Apache License 2.0, Copyright Codenotary Inc.).
Later immudb versions (1.9DOM.2 and newer, including the 1.11.2 server this package talks to) are
licensed BUSL-1.1; no code from them is copied here. Each ported function is listed below with its
source file.

| TypeScript | Source (`v1.9DOM.1`) |
| ---------- | -------------------- |

## Apache License 2.0

Full text: https://www.apache.org/licenses/LICENSE-2.0.txt
```

`libs/immudb/README.md`:

```markdown
# @platform/immudb

immudb over gRPC for this repo: the client generated from immudb's `schema.proto` (pinned to server
1.11.2), a session pool with SQL transactions, versioned SQL migrations with provisioning, and
client-side verification of immudb's Merkle proofs. It names no domain.

## Regenerating the client

`bun run --filter @platform/immudb proto:gen` strips the REST/Swagger annotations from
`vendor/immudb-v1.11.2-schema.proto` (`scripts/strip-proto.mjs`) and runs buf with this package's own
`buf.gen.yaml` (ts-proto `outputServices=grpc-js`). `src/generated/**` is committed and checked for drift
in CI. To move to a new immudb version, vendor the new file, update the sha256 in
`test/strip-proto.spec.ts` and `IMMUDB_SERVER_VERSION`, regenerate, and re-run the int specs (error
strings are pinned to the server version).

## Licences

See `THIRD_PARTY_NOTICES.md`.
```

`.github/workflows/ci.yml:82-83`: in both the `git diff --exit-code -- …` and the
`git status --porcelain -- …` path lists, append ` libs/immudb/src/generated libs/immudb/proto` after
`libs/transport/test/fixtures/src/generated`.

- [ ] **Step 9: Wider checks.** `npx prettier --write libs/immudb/README.md libs/immudb/THIRD_PARTY_NOTICES.md libs/immudb/buf.yaml libs/immudb/buf.gen.yaml .github/workflows/ci.yml`,
      `npx biome check --write libs/immudb/src/index.ts libs/immudb/test libs/immudb/scripts libs/immudb/package.json package.json`,
      then `bun run check` — Expected: PASS, ending `Layer boundaries OK (27 packages: …)`. Then
      `bun run proto:gen && git status --porcelain -- libs/immudb domains/*/contracts/src/generated` — Expected:
      only this task's new files, no diff in contracts output.

- [ ] **Step 10: Commit.**

```bash
git add libs/immudb package.json bun.lock .github/workflows/ci.yml
git commit -m "feat(immudb,repo): add @platform/immudb with the generated immudb gRPC client" \
  -m "Vendors immudb v1.11.2 schema.proto (Apache-2.0), strips its REST/Swagger annotations with a
committed script and generates a grpc-js ts-proto client with its own buf template. Adds
@bufbuild/protobuf 2.15.0 to the catalog and the generated paths to the CI drift check."
```

### Task L-2a: `immudb` config namespace, SQL value codec and error mapping

**Files:**

- Create: `libs/config/src/namespaces/immudb.config.ts`, `libs/immudb/src/immudb.types.ts`,
  `libs/immudb/src/client/sql-values.ts`, `libs/immudb/src/errors/immudb.error.ts`
- Modify: `libs/config/src/all-config.ts` (import, `CONFIG_NAMESPACES`, `AllConfig`),
  `libs/config/src/all-config.spec.ts` (the pinned `CONFIG_NAMESPACES` key list `:18-33`),
  `libs/config/src/index.ts` (after `:17` `export * from './namespaces/cassandra.config.js';`),
  `libs/immudb/src/index.ts`, `.env.example` (new section after the cassandra section, `:89-116`),
  `docs/CONFIGURATION.md` (namespace table `:96-118`, a new `### immudb` section before `### redis`
  `:217`, a production-guard row in the table at `:494+`)
- Test: `libs/config/src/namespaces/immudb.config.spec.ts`, `libs/immudb/src/client/sql-values.spec.ts`,
  `libs/immudb/src/errors/immudb.error.spec.ts`

**Interfaces:**

- Consumes: L-1 generated `SQLValue`, `NamedParam`, `SQLQueryResult`, `NullValue`.
- Produces:

```ts
// @platform/config
export const IMMUDB_DEFAULT_ADMIN_PASSWORD = 'immudb';
export const IMMUDB_LOCAL_PASSWORD = 'Compose-local-App1!';
export const immudbConfig: ConfigNamespace<'immudb', ImmudbConfig>;
export type ImmudbConfig = {
  address: string; // host:port
  database: string;
  credentials: { username: string; password: string };
  admin: { username: string; password: string } | undefined;
  sessionPoolSize: number;
  timeoutMs: number;
  keepAliveIntervalMs: number;
  tls: boolean;
  serverSigningPublicKeyPem: string | undefined;
  runMigrations: boolean;
};
// @platform/immudb
export type ImmudbValue = null | string | bigint | boolean | Uint8Array | Date;
export type ImmudbParams = Readonly<Record<string, ImmudbValue>>;
export type ImmudbRow = Record<string, ImmudbValue>;
export interface ImmudbTx {
  exec(sql: string, params?: ImmudbParams): Promise<void>;
  query<T extends Record<string, ImmudbValue>>(sql: string, params?: ImmudbParams): Promise<T[]>;
}
export interface ImmudbState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
  readonly signature: Uint8Array | null;
}
export interface ImmudbMigrationSource {
  readonly name: string;
  readonly dir: string;
}
export interface ImmudbModuleOptions {
  readonly migrations?: readonly ImmudbMigrationSource[];
}
export type ImmudbErrorKind =
  | 'duplicate-key'
  | 'read-conflict'
  | 'read-only'
  | 'access-denied'
  | 'tx-closed'
  | 'unavailable'
  | 'verification-failed';
export class ImmudbError extends Error {
  readonly kind: ImmudbErrorKind;
  get retryable(): boolean; // read-conflict | unavailable
}
export function toImmudbError(error: unknown): ImmudbError | undefined;
export function isSessionGone(error: unknown): boolean;
// internal (libs/immudb/src/client/sql-values.ts)
export function toSqlValue(value: ImmudbValue): SQLValue;
export function fromSqlValue(value: SQLValue | undefined): ImmudbValue;
export function toNamedParams(params?: ImmudbParams): NamedParam[];
export function columnKey(selector: string): string;
export function rowsOf(results: readonly SQLQueryResult[]): ImmudbRow[];
```

**Wave:** after L-1. Edits `libs/config/src/all-config.ts`, which B3, C and G also touch: keep the edit to
the three quoted hunks so a merge resolves line-wise.

- [ ] **Step 1: Write the failing tests.** `libs/config/src/namespaces/immudb.config.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { validateAllEnv } from '../all-config.js';
import {
  IMMUDB_DEFAULT_ADMIN_PASSWORD,
  IMMUDB_LOCAL_PASSWORD,
  immudbConfig,
} from './immudb.config.js';

const PROD = { NODE_ENV: 'production' } as const;
const STRONG = 'R3al-Secret-Value!';
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n';

describe('immudb config', () => {
  it('defaults to the local compose immudb', () => {
    expect(immudbConfig.parse({})).toEqual({
      address: 'localhost:3322',
      database: 'app',
      credentials: { username: 'app_writer', password: IMMUDB_LOCAL_PASSWORD },
      admin: undefined,
      sessionPoolSize: 4,
      timeoutMs: 5_000,
      keepAliveIntervalMs: 60_000,
      tls: false,
      serverSigningPublicKeyPem: undefined,
      runMigrations: false,
    });
    expect(validateAllEnv({}).immudb.address).toBe('localhost:3322');
  });

  it('the local password satisfies immudb password policy (8-32, upper, digit, symbol)', () => {
    expect(IMMUDB_LOCAL_PASSWORD).toMatch(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,32}$/);
  });

  it('builds admin credentials only when the admin password is set', () => {
    expect(immudbConfig.parse({ IMMUDB_ADMIN_PASSWORD: 'immudb' }).admin).toEqual({
      username: 'immudb',
      password: 'immudb',
    });
  });

  it.each([
    ['IMMUDB_ADDRESS', 'localhost'],
    ['IMMUDB_DATABASE', 'Bad-Name'],
    ['IMMUDB_USERNAME', 'a b'],
    ['IMMUDB_KEEPALIVE_INTERVAL_MS', '180000'],
    ['IMMUDB_SESSION_POOL_SIZE', '0'],
    ['IMMUDB_SERVER_SIGNING_PUBLIC_KEY', 'bm90LWEtcGVt'],
  ])('rejects %s=%s', (key, value) => {
    const error = errorOf(() => immudbConfig.parse({ [key]: value }));
    expect(error.issues.map((issue) => issue.path[0])).toContain(key);
  });

  it('decodes a base64 PEM signing key', () => {
    const encoded = Buffer.from(PEM).toString('base64');
    expect(
      immudbConfig.parse({ IMMUDB_SERVER_SIGNING_PUBLIC_KEY: encoded }).serverSigningPublicKeyPem,
    ).toBe(PEM);
  });

  describe('production guards', () => {
    it('refuses the local app password, the default admin password and plaintext gRPC', () => {
      const error = errorOf(() =>
        immudbConfig.parse({ ...PROD, IMMUDB_ADMIN_PASSWORD: IMMUDB_DEFAULT_ADMIN_PASSWORD }),
      );
      expect(error.issues.map((issue) => issue.path[0]).sort()).toEqual([
        'IMMUDB_ADMIN_PASSWORD',
        'IMMUDB_PASSWORD',
        'IMMUDB_TLS',
      ]);
      expect(error.message).not.toContain(IMMUDB_LOCAL_PASSWORD);
    });

    it('accepts real secrets with TLS, or the explicit opt-outs', () => {
      expect(() =>
        immudbConfig.parse({ ...PROD, IMMUDB_PASSWORD: STRONG, IMMUDB_TLS: 'true' }),
      ).not.toThrow();
      expect(() =>
        immudbConfig.parse({
          ...PROD,
          ALLOW_KNOWN_LOCAL_SECRETS: 'true',
          IMMUDB_ALLOW_INSECURE: 'true',
          IMMUDB_ADMIN_PASSWORD: IMMUDB_DEFAULT_ADMIN_PASSWORD,
        }),
      ).not.toThrow();
    });
  });
});
```

`libs/immudb/src/client/sql-values.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { columnKey, fromSqlValue, rowsOf, toNamedParams, toSqlValue } from './sql-values.js';

describe('sql values', () => {
  it.each([
    [null, { value: { $case: 'null', value: 'NULL_VALUE' } }],
    ['a', { value: { $case: 's', value: 'a' } }],
    [9007199254740993n, { value: { $case: 'n', value: '9007199254740993' } }],
    [-1n, { value: { $case: 'n', value: '-1' } }],
    [true, { value: { $case: 'b', value: true } }],
    [new Date('2026-11-09T00:00:00.000Z'), { value: { $case: 'ts', value: '1794182400000000' } }],
  ] as const)('encodes %s', (input, expected) => {
    expect(toSqlValue(input)).toEqual(expected);
  });

  it('encodes bytes and rejects values outside int64', () => {
    expect(toSqlValue(new Uint8Array([1, 2]))).toEqual({
      value: { $case: 'bs', value: Buffer.from([1, 2]) },
    });
    expect(() => toSqlValue(2n ** 63n)).toThrow(RangeError);
    expect(() => toSqlValue(-(2n ** 63n) - 1n)).toThrow(RangeError);
    expect(() => toSqlValue(new Date(Number.NaN))).toThrow(TypeError);
  });

  it('decodes every supported case and refuses FLOAT', () => {
    expect(fromSqlValue(undefined)).toBeNull();
    expect(fromSqlValue({ value: { $case: 'n', value: '-9007199254740993' } })).toBe(
      -9007199254740993n,
    );
    expect(fromSqlValue({ value: { $case: 'ts', value: '1794182400000000' } })).toEqual(
      new Date('2026-11-09T00:00:00.000Z'),
    );
    expect(fromSqlValue({ value: { $case: 'bs', value: Buffer.from([7]) } })).toEqual(
      Buffer.from([7]),
    );
    expect(() => fromSqlValue({ value: { $case: 'f', value: 1.5 } })).toThrow(TypeError);
  });

  it('names params without the @ prefix', () => {
    expect(toNamedParams({ id: 'x' })).toEqual([
      { name: 'id', value: { value: { $case: 's', value: 'x' } } },
    ]);
    expect(toNamedParams()).toEqual([]);
  });

  it.each([
    ['(orders.id)', 'id'],
    ['(db.orders.id)', 'id'],
    ['(orders.col0)', 'col0'],
    ['(t.total)', 'total'],
    ['SUM(t.debit)', 'SUM(t.debit)'],
    ['id', 'id'],
  ])('column key of %s is %s', (selector, key) => {
    expect(columnKey(selector)).toBe(key);
  });

  it('builds row objects from streamed result chunks and refuses duplicate keys', () => {
    const chunk = {
      columns: [],
      rows: [
        {
          columns: ['(t.id)', '(t.n)'],
          values: [
            { value: { $case: 's' as const, value: 'a' } },
            { value: { $case: 'n' as const, value: '2' } },
          ],
        },
      ],
    };
    expect(rowsOf([chunk, chunk])).toEqual([
      { id: 'a', n: 2n },
      { id: 'a', n: 2n },
    ]);
    expect(() =>
      rowsOf([
        {
          columns: [],
          rows: [{ columns: ['(a.id)', '(b.id)'], values: [{}, {}] }],
        },
      ]),
    ).toThrow(/alias/);
  });
});
```

`libs/immudb/src/errors/immudb.error.spec.ts`:

```ts
import { Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { ImmudbError, isSessionGone, toImmudbError } from './immudb.error.js';

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(`${code} ${status[code]}: ${details}`), {
    code,
    details,
    metadata: new Metadata(),
  });
}

describe('toImmudbError', () => {
  it.each([
    ['key already exists', 'duplicate-key', false],
    ['tx read conflict', 'read-conflict', true],
    ['tx read conflict: fetching more entries than expected', 'read-conflict', true],
    ['read-only transaction', 'read-only', false],
    ['access denied: statement requires [UPDATE] privileges', 'access-denied', false],
    ['no transaction found', 'tx-closed', false],
    ['no ongoing transaction', 'tx-closed', false],
    ['no session found', 'unavailable', true],
  ] as const)('maps "%s" to %s', (details, kind, retryable) => {
    const mapped = toImmudbError(serviceError(status.UNKNOWN, details));
    expect(mapped).toBeInstanceOf(ImmudbError);
    expect(mapped?.kind).toBe(kind);
    expect(mapped?.retryable).toBe(retryable);
  });

  it('maps transport failures to unavailable and leaves other errors alone', () => {
    expect(toImmudbError(serviceError(status.UNAVAILABLE, 'connect ECONNREFUSED'))?.kind).toBe(
      'unavailable',
    );
    expect(toImmudbError(serviceError(status.DEADLINE_EXCEEDED, 'deadline'))?.kind).toBe(
      'unavailable',
    );
    expect(toImmudbError(serviceError(status.UNKNOWN, 'syntax error'))).toBeUndefined();
    expect(toImmudbError(new Error('plain'))).toBeUndefined();
  });

  it('detects a session the server forgot', () => {
    expect(isSessionGone(serviceError(status.UNKNOWN, 'no session found'))).toBe(true);
    expect(isSessionGone(serviceError(status.UNKNOWN, 'key already exists'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project config immudb.config && npx vitest run --project immudb src/client src/errors`
      — Expected: FAIL (`Cannot find module './immudb.config.js'`, `'./sql-values.js'`, `'./immudb.error.js'`).

- [ ] **Step 3: Implement the namespace.** `libs/config/src/namespaces/immudb.config.ts`:

```ts
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';
import { addKnownLocalSecretIssue, isKnownLocalSecret } from '../env/production-guards.js';

/** immudb's built-in superuser password (public knowledge): refused in production. */
export const IMMUDB_DEFAULT_ADMIN_PASSWORD = 'immudb';
/**
 * Local default of the application user. It satisfies immudb's password policy (8-32 chars, an
 * uppercase letter, a digit and a symbol) and matches `isKnownLocalSecret`, so production refuses it.
 */
export const IMMUDB_LOCAL_PASSWORD = 'Compose-local-App1!';

const HOST_PORT = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/;

const decodePem = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

export const immudbEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    IMMUDB_ADDRESS: zStr('localhost:3322', {
      pattern: HOST_PORT,
      patternMessage: 'Expected host:port, e.g. localhost:3322',
    }),
    // Interpolated into CREATE DATABASE / user provisioning → strict identifiers only.
    IMMUDB_DATABASE: zStr('app', {
      pattern: IDENTIFIER,
      patternMessage: 'Expected a lowercase identifier ([a-z][a-z0-9_]*, max 63 chars)',
    }),
    IMMUDB_USERNAME: zStr('app_writer', {
      pattern: IDENTIFIER,
      patternMessage: 'Expected a lowercase identifier ([a-z][a-z0-9_]*, max 63 chars)',
    }),
    IMMUDB_PASSWORD: zStr(IMMUDB_LOCAL_PASSWORD),
    // Provisioning and migrations only (the migrate step or IMMUDB_RUN_MIGRATIONS).
    IMMUDB_ADMIN_USERNAME: zStr('immudb'),
    IMMUDB_ADMIN_PASSWORD: zStr(),
    IMMUDB_SESSION_POOL_SIZE: zInt(4, { min: 1, max: 64 }),
    IMMUDB_TIMEOUT_MS: zInt(5_000, { min: 100 }),
    // Must stay below the server's --max-session-inactivity-time (default 3 min).
    IMMUDB_KEEPALIVE_INTERVAL_MS: zInt(60_000, { min: 1_000, max: 170_000 }),
    IMMUDB_TLS: zBool(false),
    // Production refuses plaintext gRPC without it (a mesh encrypts the hop, or the compose stack).
    IMMUDB_ALLOW_INSECURE: zBool(false),
    // base64 of the PEM public key matching the server's --signingKey (state signatures).
    IMMUDB_SERVER_SIGNING_PUBLIC_KEY: zStr(),
    IMMUDB_RUN_MIGRATIONS: zBool(false),
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    const key = env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY;
    if (key !== undefined && !PEM_PUBLIC_KEY.test(decodePem(key))) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMUDB_SERVER_SIGNING_PUBLIC_KEY'],
        message: 'Expected the base64 encoding of a PEM "PUBLIC KEY" block',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.ALLOW_KNOWN_LOCAL_SECRETS) {
      if (isKnownLocalSecret(env.IMMUDB_PASSWORD)) addKnownLocalSecretIssue(ctx, 'IMMUDB_PASSWORD');
      const admin = env.IMMUDB_ADMIN_PASSWORD;
      if (admin === IMMUDB_DEFAULT_ADMIN_PASSWORD || isKnownLocalSecret(admin)) {
        addKnownLocalSecretIssue(ctx, 'IMMUDB_ADMIN_PASSWORD');
      }
    }
    if (!env.IMMUDB_TLS && !env.IMMUDB_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMUDB_TLS'],
        message:
          'immudb credentials and data would travel unencrypted: set IMMUDB_TLS=true in production, or IMMUDB_ALLOW_INSECURE=true when the network layer secures it',
      });
    }
  })
  .transform((env) => ({
    address: env.IMMUDB_ADDRESS,
    database: env.IMMUDB_DATABASE,
    credentials: { username: env.IMMUDB_USERNAME, password: env.IMMUDB_PASSWORD },
    /** Superuser for provisioning/migrations; `undefined` = this process never provisions. */
    admin:
      env.IMMUDB_ADMIN_PASSWORD === undefined
        ? undefined
        : { username: env.IMMUDB_ADMIN_USERNAME, password: env.IMMUDB_ADMIN_PASSWORD },
    sessionPoolSize: env.IMMUDB_SESSION_POOL_SIZE,
    timeoutMs: env.IMMUDB_TIMEOUT_MS,
    keepAliveIntervalMs: env.IMMUDB_KEEPALIVE_INTERVAL_MS,
    tls: env.IMMUDB_TLS,
    serverSigningPublicKeyPem:
      env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY === undefined
        ? undefined
        : decodePem(env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY),
    runMigrations: env.IMMUDB_RUN_MIGRATIONS,
  }));

/** immudb (append-only, verifiable SQL store) over gRPC. */
export const immudbConfig = defineConfigNamespace('immudb', immudbEnvSchema);
export type ImmudbConfig = ConfigType<typeof immudbConfig>;
```

Defaults are deliberately domain-neutral (`app`, `app_writer`; the spec's `ledger`/`ledger_app` would put
a billing concept into `libs/`): deviation 7 below.

`libs/config/src/all-config.ts`: after `import { type GrpcConfig, grpcConfig } from './namespaces/grpc.config.js';`
add `import { type ImmudbConfig, immudbConfig } from './namespaces/immudb.config.js';`; after
`  cassandra: cassandraConfig,` add `  immudb: immudbConfig,`; after `  cassandra: CassandraConfig;` add
`  immudb: ImmudbConfig;`. `libs/config/src/index.ts`: after
`export * from './namespaces/cassandra.config.js';` add `export * from './namespaces/immudb.config.js';`.
`libs/config/src/all-config.spec.ts` (`describe('CONFIG_NAMESPACES')` pins the exact key list, so it
fails without this): after `      'cassandra',` add `      'immudb',`.

- [ ] **Step 4: Implement the types, codec and errors.** `libs/immudb/src/immudb.types.ts`:

```ts
/** A value bound to or read from immudb SQL. `bigint` = INTEGER (int64); `Date` = TIMESTAMP (µs). */
export type ImmudbValue = null | string | bigint | boolean | Uint8Array | Date;
/** Named parameters: `{ id: 'x' }` binds `@id`. */
export type ImmudbParams = Readonly<Record<string, ImmudbValue>>;
/** One result row keyed by column name (aliases for computed columns: `SUM(x) AS total`). */
export type ImmudbRow = Record<string, ImmudbValue>;

/** Statements inside one server-side transaction. */
export interface ImmudbTx {
  exec(sql: string, params?: ImmudbParams): Promise<void>;
  /** Row shapes must be `type` aliases (interfaces have no index signature). */
  query<T extends Record<string, ImmudbValue>>(sql: string, params?: ImmudbParams): Promise<T[]>;
}

/** The server's current state of one database (`CurrentState`). */
export interface ImmudbState {
  readonly database: string;
  readonly txId: bigint;
  /** Alh (accumulative linear hash) of `txId`, 32 bytes. */
  readonly txHash: Uint8Array;
  /** ECDSA (P-256, SHA-256, ASN.1 DER) over the state, when the server runs with --signingKey. */
  readonly signature: Uint8Array | null;
}

/** A folder of versioned `NNN_name.sql` files, applied in order by `runImmudbMigrations`. */
export interface ImmudbMigrationSource {
  readonly name: string;
  readonly dir: string;
}

export interface ImmudbModuleOptions {
  /** Applied at boot when IMMUDB_RUN_MIGRATIONS=true (needs IMMUDB_ADMIN_PASSWORD). */
  readonly migrations?: readonly ImmudbMigrationSource[];
}
```

`libs/immudb/src/client/sql-values.ts`:

```ts
import { NullValue } from '../generated/google/protobuf/struct.pb.js';
import type { NamedParam, SQLQueryResult, SQLValue } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbRow, ImmudbValue } from '../immudb.types.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export function toSqlValue(value: ImmudbValue): SQLValue {
  if (value === null) return { value: { $case: 'null', value: NullValue.NULL_VALUE } };
  if (typeof value === 'string') return { value: { $case: 's', value } };
  if (typeof value === 'boolean') return { value: { $case: 'b', value } };
  if (typeof value === 'bigint') {
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new RangeError(`${value} is outside the int64 range of an immudb INTEGER`);
    }
    return { value: { $case: 'n', value: value.toString() } };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('Invalid Date bound to an immudb TIMESTAMP');
    return { value: { $case: 'ts', value: (BigInt(ms) * 1_000n).toString() } };
  }
  return { value: { $case: 'bs', value: Buffer.from(value) } };
}

export function fromSqlValue(value: SQLValue | undefined): ImmudbValue {
  const v = value?.value;
  switch (v?.$case) {
    case undefined:
    case 'null':
      return null;
    case 'n':
      return BigInt(v.value);
    case 's':
    case 'b':
      return v.value;
    case 'bs':
      return v.value;
    case 'ts':
      return new Date(Number(BigInt(v.value) / 1_000n));
    case 'f':
      throw new TypeError('FLOAT columns are not supported by @platform/immudb');
  }
}

export function toNamedParams(params: ImmudbParams = {}): NamedParam[] {
  return Object.entries(params).map(([name, value]) => ({ name, value: toSqlValue(value) }));
}

/**
 * Result columns come back as selectors `(table.col)` (`EncodeSelector`, `ColDescriptor.Selector`):
 * plain and aliased columns map to the bare name. An unaliased aggregate comes back as
 * `(table.colN)` (N = its position, v1.9DOM.1 `proj_row_reader.go` `Columns`), so always alias
 * computed columns (`SUM(debit) AS debit_total`).
 */
export function columnKey(selector: string): string {
  const plain = /^\(([^()]+)\)$/.exec(selector);
  if (plain?.[1] === undefined) return selector;
  return plain[1].slice(plain[1].lastIndexOf('.') + 1);
}

/** Flattens the streamed `TxSQLQuery` chunks into row objects. */
export function rowsOf(results: readonly SQLQueryResult[]): ImmudbRow[] {
  const rows: ImmudbRow[] = [];
  for (const result of results) {
    for (const row of result.rows) {
      const out: ImmudbRow = {};
      row.columns.forEach((selector, i) => {
        const key = columnKey(selector);
        if (Object.hasOwn(out, key)) {
          throw new Error(`Result column "${key}" appears twice: alias it in the SELECT`);
        }
        out[key] = fromSqlValue(row.values[i]);
      });
      rows.push(out);
    }
  }
  return rows;
}
```

`libs/immudb/src/errors/immudb.error.ts`:

```ts
import { type ServiceError, status } from '@grpc/grpc-js';

export type ImmudbErrorKind =
  | 'duplicate-key'
  | 'read-conflict'
  | 'read-only'
  | 'access-denied'
  | 'tx-closed'
  | 'unavailable'
  | 'verification-failed';

/** A classified immudb failure. The server sends no error codes, so kinds come from messages. */
export class ImmudbError extends Error {
  override readonly name = 'ImmudbError';

  constructor(
    readonly kind: ImmudbErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** Worth a new transaction: an MVCC loser or a transport/session failure. */
  get retryable(): boolean {
    return this.kind === 'read-conflict' || this.kind === 'unavailable';
  }
}

/**
 * Server messages pinned to immudb 1.11.2 (spec appendix P2-P8); the int spec covers each one. Order
 * matters: the first match wins.
 */
const MESSAGE_KINDS: readonly (readonly [RegExp, ImmudbErrorKind])[] = [
  [/key already exists/, 'duplicate-key'],
  [/tx read conflict/, 'read-conflict'],
  [/read-only transaction/, 'read-only'],
  [/access denied/, 'access-denied'],
  [/no transaction found|no ongoing transaction/, 'tx-closed'],
  // pkg/server/sessions/errors.go ErrSessionNotFound (idle timeout, restart, closed session).
  [/no session found|session not found/, 'unavailable'],
];

function isServiceError(error: unknown): error is ServiceError {
  return error instanceof Error && typeof (error as Partial<ServiceError>).code === 'number';
}

function detailsOf(error: ServiceError): string {
  return error.details === '' ? error.message : error.details;
}

/** Classifies a gRPC error from immudb; `undefined` for anything this package does not know. */
export function toImmudbError(error: unknown): ImmudbError | undefined {
  if (error instanceof ImmudbError) return error;
  if (!isServiceError(error)) return undefined;
  const details = detailsOf(error);
  const match = MESSAGE_KINDS.find(([pattern]) => pattern.test(details));
  if (match !== undefined) return new ImmudbError(match[1], details, { cause: error });
  if (error.code === status.UNAVAILABLE || error.code === status.DEADLINE_EXCEEDED) {
    return new ImmudbError('unavailable', details, { cause: error });
  }
  return undefined;
}

/** The server no longer knows the session (idle timeout, restart): discard it, never reuse it. */
export function isSessionGone(error: unknown): boolean {
  return isServiceError(error) && /no session found|session not found/.test(detailsOf(error));
}
```

`libs/immudb/src/index.ts`: append

```ts
export * from './errors/immudb.error.js';
export type * from './immudb.types.js';
```

- [ ] **Step 5: Run the tests.** Same command as Step 2 — Expected: PASS.

- [ ] **Step 6: Document the variables.** Root `.env.example`: insert after the line
      `# CASSANDRA_ALLOW_SIMPLE_STRATEGY=false` and its blank line, before `# ── redis: …`:

```dotenv
# ── immudb: append-only verifiable SQL store over gRPC (monolith, billing-service from wave 2) ──
IMMUDB_ADDRESS=localhost:3322
IMMUDB_DATABASE=app
# INSERT/SELECT-only application user (provisioned by the migrate step). immudb policy: 8-32 chars,
# an uppercase letter, a digit and a symbol. The default is refused in production.
IMMUDB_USERNAME=app_writer
# IMMUDB_PASSWORD=Compose-local-App1!
# Superuser for provisioning + migrations only (immudb's built-in default is immudb/immudb,
# refused in production). Leave unset in processes that never migrate.
# IMMUDB_ADMIN_USERNAME=immudb
# IMMUDB_ADMIN_PASSWORD=
# IMMUDB_SESSION_POOL_SIZE=4
# IMMUDB_TIMEOUT_MS=5000
# Below the server's 3-minute session inactivity limit
# IMMUDB_KEEPALIVE_INTERVAL_MS=60000
# gRPC over TLS (required in production unless IMMUDB_ALLOW_INSECURE=true)
# IMMUDB_TLS=false
# IMMUDB_ALLOW_INSECURE=false
# base64 of the PEM public key of the server's --signingKey (verifies state signatures)
# IMMUDB_SERVER_SIGNING_PUBLIC_KEY=
# Provision the database/user and apply SQL migrations at boot (needs IMMUDB_ADMIN_PASSWORD)
# IMMUDB_RUN_MIGRATIONS=false
```

`docs/CONFIGURATION.md`: in the "Which app loads which namespace" table add after the `cassandra` row:
`| `immudb`| | | | | |`ImmudbModule` (`@platform/immudb`); wired into monolith and billing-service in ledger wave 2 (L-12) |`.
Add before `### `redis` — …`:

```markdown
### `immudb` — append-only verifiable SQL store

[`immudb.config.ts`](../libs/config/src/namespaces/immudb.config.ts) · not loaded by any app yet
(ledger wave 2 wires monolith and billing-service)

| Variable                           | Default               | Description                                                                                       |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `IMMUDB_ADDRESS`                   | `localhost:3322`      | gRPC `host:port` (pg-wire is never used).                                                         |
| `IMMUDB_DATABASE`                  | `app`                 | Database (lowercase identifier); created by provisioning.                                         |
| `IMMUDB_USERNAME`                  | `app_writer`          | Application user, provisioned with SQL `SELECT` and `INSERT` only.                                |
| `IMMUDB_PASSWORD`                  | `Compose-local-App1!` | 8-32 chars with an uppercase letter, a digit and a symbol (immudb policy). Refused in production. |
| `IMMUDB_ADMIN_USERNAME`            | `immudb`              | Superuser for provisioning and migrations.                                                        |
| `IMMUDB_ADMIN_PASSWORD`            | —                     | Unset = this process never provisions or migrates. `immudb` is refused in production.             |
| `IMMUDB_SESSION_POOL_SIZE`         | `4`                   | Sessions per process (server cap: 100 in total).                                                  |
| `IMMUDB_TIMEOUT_MS`                | `5000`                | Deadline of every gRPC call.                                                                      |
| `IMMUDB_KEEPALIVE_INTERVAL_MS`     | `60000`               | Session keepalive; must stay below the server's 3-minute inactivity limit (max 170000).           |
| `IMMUDB_TLS`                       | `false`               | gRPC over TLS with the system roots.                                                              |
| `IMMUDB_ALLOW_INSECURE`            | `false`               | Production opt-out of `IMMUDB_TLS`.                                                               |
| `IMMUDB_SERVER_SIGNING_PUBLIC_KEY` | —                     | base64 PEM public key; when set, state signatures are verified.                                   |
| `IMMUDB_RUN_MIGRATIONS`            | `false`               | Provision and migrate at boot.                                                                    |
```

In "## Production guards", add the row:
`| immudb must use TLS unless `IMMUDB_ALLOW_INSECURE=true`; the local app password and immudb's default admin password are publicly known values | `IMMUDB_TLS`, `IMMUDB_PASSWORD`, `IMMUDB_ADMIN_PASSWORD`|`immudb.config.ts` |`.

- [ ] **Step 7: Wider checks.** `npx biome check --write libs/config/src libs/immudb/src`,
      `npx prettier --write docs/CONFIGURATION.md`, `node scripts/check-env-example.mjs` (Expected: exit 0),
      `npx vitest run --project config --project immudb` (Expected: PASS, including `namespaces.spec.ts`
      "every namespace parses {}"), `npx vitest run --project '*-service' --project monolith --project gateway env-example`
      (Expected: PASS: every app's `validateAllEnv` now also parses `immudb` from its `.env.example`), then
      `bun run check` (Expected: PASS).

- [ ] **Step 8: Commit.**

```bash
git add libs/config/src/namespaces/immudb.config.ts libs/config/src/namespaces/immudb.config.spec.ts \
  libs/config/src/all-config.ts libs/config/src/all-config.spec.ts libs/config/src/index.ts \
  libs/immudb/src .env.example docs/CONFIGURATION.md
git commit -m "feat(config,immudb): add the immudb namespace, SQL value codec and error mapping" \
  -m "Platform namespace immudb (13 keys, all defaulted) with production guards for known passwords
and plaintext gRPC. @platform/immudb maps ImmudbValue to the generated SQLValue (int64 as
bigint, timestamps in microseconds), normalises result selectors and classifies immudb 1.11.2
error messages."
```

### Task L-2b: session pool, `ImmudbClient`, `ImmudbModule`, health indicator

**Files:**

- Create: `libs/immudb/src/client/grpc-call.ts`, `libs/immudb/src/client/immudb-session.ts`,
  `libs/immudb/src/client/session-pool.ts`, `libs/immudb/src/client/immudb.client.ts`,
  `libs/immudb/src/client/grpc-immudb.client.ts`, `libs/immudb/src/client/create-immudb-grpc-client.ts`,
  `libs/immudb/src/immudb.constants.ts`, `libs/immudb/src/immudb.module.ts`,
  `libs/immudb/src/health/immudb.health.ts`, `libs/immudb/src/testing/recording-immudb.client.ts`,
  `libs/immudb/src/testing/index.ts`
- Modify: `libs/immudb/src/index.ts`, `libs/immudb/package.json` (`exports["./testing"]`)
- Test: `libs/immudb/src/client/session-pool.spec.ts`, `libs/immudb/src/client/grpc-immudb.client.spec.ts`,
  `libs/immudb/test/immudb-client.int-spec.ts`

**Interfaces:**

- Consumes: L-1 generated client; L-2a `ImmudbTx`, `ImmudbState`, `ImmudbRow`, `ImmudbModuleOptions`,
  `toImmudbError`, `isSessionGone`, `toNamedParams`, `toSqlValue`, `rowsOf`; `immudbConfig`.
- Produces:

```ts
// @platform/immudb (barrel)
export abstract class ImmudbClient {
  /** Commits when work ran an exec, rolls back otherwise; never rolls back after a failed statement. */
  abstract readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }>;
  abstract readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts?: { mustIncludeTxId?: bigint },
  ): Promise<T>;
  abstract currentState(): Promise<ImmudbState>;
  // L-5 adds verifyConsistency and verifiedRow (spec contract).
}
export class ImmudbModule {
  static forRootAsync(options?: ImmudbModuleOptions): DynamicModule;
}
export class ImmudbHealthIndicator extends HealthContributor {
  readonly key: 'immudb';
}
// @platform/immudb/testing
export interface RecordedStatement {
  readonly mode: 'readWrite' | 'readOnly';
  readonly kind: 'exec' | 'query';
  readonly sql: string;
  readonly params: ImmudbParams;
}
export class RecordingImmudbClient extends ImmudbClient {
  constructor(respond?: (statement: RecordedStatement) => ImmudbRow[]);
  readonly statements: RecordedStatement[];
}
// internal to libs/immudb (used by L-3 and L-5)
export interface ImmudbLogin {
  readonly username: string;
  readonly password: string;
  readonly database: string;
}
export class ImmudbSession {
  static open(
    client: ImmuServiceClient,
    login: ImmudbLogin,
    timeoutMs: number,
  ): Promise<ImmudbSession>;
  readonly id: string;
  keepAlive(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<HealthResponse>;
  newTx(mode: TxMode, mustIncludeTxId?: bigint): Promise<string>;
  commit(transactionId: string): Promise<CommittedSQLTx>;
  rollback(transactionId: string): Promise<void>;
  txExec(transactionId: string, sql: string, params?: ImmudbParams): Promise<void>;
  txQueryRaw(transactionId: string, sql: string, params?: ImmudbParams): Promise<SQLQueryResult[]>;
  txQuery(transactionId: string, sql: string, params?: ImmudbParams): Promise<ImmudbRow[]>;
  exec(sql: string, params?: ImmudbParams): Promise<void>; // SQLExec, auto-committed
  currentState(): Promise<ImmutableState>;
  verifiableTxById(tx: bigint, proveSinceTx: bigint): Promise<VerifiableTx>;
  verifiableSqlGet(
    table: string,
    pk: readonly ImmudbValue[],
    proveSinceTx: bigint,
  ): Promise<VerifiableSQLEntry>;
  createDatabase(name: string): Promise<void>; // CreateDatabaseV2, ifNotExists
  createUser(username: string, password: string, database: string): Promise<void>; // read-write permission
  revokeSqlPrivileges(
    username: string,
    database: string,
    privileges: readonly string[],
  ): Promise<void>;
}
export interface PoolableSession {
  keepAlive(): Promise<void>;
  close(): Promise<void>;
}
export class ImmudbSessionPool<TSession extends PoolableSession = ImmudbSession> {
  constructor(factory: () => Promise<TSession>, size: number, keepAliveIntervalMs: number);
  use<T>(work: (session: TSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class GrpcImmudbClient extends ImmudbClient {
  constructor(pool: ImmudbSessionPool);
}
export function createImmudbGrpcClient(cfg: { address: string; tls: boolean }): ImmuServiceClient;
export function toImmudbState(state: ImmutableState): ImmudbState;
export const IMMUDB_GRPC_CLIENT: unique symbol;
export const IMMUDB_MODULE_OPTIONS: unique symbol;
```

**Wave:** after L-2a.

- [ ] **Step 1: Write the failing unit tests.** `libs/immudb/src/client/session-pool.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImmudbError } from '../errors/immudb.error.js';
import { ImmudbSessionPool, type PoolableSession } from './session-pool.js';

interface FakeSession extends PoolableSession {
  readonly n: number;
  keepAlive: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function factory(): { open: () => Promise<FakeSession>; made: FakeSession[] } {
  const made: FakeSession[] = [];
  const open = async (): Promise<FakeSession> => {
    const session: FakeSession = {
      n: made.length + 1,
      keepAlive: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    made.push(session);
    return session;
  };
  return { open, made };
}

describe('ImmudbSessionPool', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses an idle session', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 2, 60_000);
    await pool.use(async (s) => s.n);
    expect(await pool.use(async (s) => s.n)).toBe(1);
    expect(made).toHaveLength(1);
    await pool.close();
  });

  it('caps open sessions at size and queues the rest', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    let release!: () => void;
    const first = pool.use(
      () =>
        new Promise<number>((r) => {
          release = () => r(1);
        }),
    );
    const second = pool.use(async (s) => s.n);
    // A macrotask lets the first use() open its session and start its work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(made).toHaveLength(1);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    await pool.close();
  });

  it('discards a session that failed with unavailable and opens a fresh one', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await expect(
      pool.use(async () => {
        throw new ImmudbError('unavailable', 'no session found');
      }),
    ).rejects.toThrow('no session found');
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    expect(await pool.use(async (s) => s.n)).toBe(2);
    await pool.close();
  });

  it('keeps a session after a domain error such as duplicate-key', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await expect(
      pool.use(async () => {
        throw new ImmudbError('duplicate-key', 'key already exists');
      }),
    ).rejects.toThrow();
    expect(await pool.use(async (s) => s.n)).toBe(1);
    expect(made).toHaveLength(1);
    await pool.close();
  });

  it('keeps idle sessions alive and drops one whose keepalive fails', async () => {
    vi.useFakeTimers();
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 1_000);
    await pool.use(async () => undefined);
    made[0]?.keepAlive.mockRejectedValueOnce(new Error('no session found'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    expect(await pool.use(async (s) => s.n)).toBe(2);
    await pool.close();
  });

  it('closes idle sessions and refuses new work after close', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await pool.use(async () => undefined);
    await pool.close();
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    await expect(pool.use(async () => undefined)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
```

`libs/immudb/src/client/grpc-immudb.client.spec.ts`:

```ts
import { Metadata, status } from '@grpc/grpc-js';
import { createMock, type Mocked } from '@platform/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TxHeader, TxMode } from '../generated/immudb/schema/schema.pb.js';
import { GrpcImmudbClient } from './grpc-immudb.client.js';
import type { ImmudbSession } from './immudb-session.js';
import { ImmudbSessionPool } from './session-pool.js';

const grpcError = (details: string): Error =>
  Object.assign(new Error(details), { code: status.UNKNOWN, details, metadata: new Metadata() });

describe('GrpcImmudbClient', () => {
  let sessions: Mocked<ImmudbSession>[];
  let client: GrpcImmudbClient;

  const newSession = (): Mocked<ImmudbSession> => {
    const session = createMock<ImmudbSession>();
    session.newTx.mockResolvedValue('tx-1');
    session.txExec.mockResolvedValue(undefined);
    session.txQuery.mockResolvedValue([]);
    session.rollback.mockResolvedValue(undefined);
    session.close.mockResolvedValue(undefined);
    session.commit.mockResolvedValue({
      header: undefined,
      updatedRows: 1,
      lastInsertedPKs: {},
      firstInsertedPKs: {},
    });
    sessions.push(session);
    return session;
  };

  beforeEach(() => {
    sessions = [];
    const pool = new ImmudbSessionPool(
      async () => newSession() as unknown as ImmudbSession,
      1,
      60_000,
    );
    client = new GrpcImmudbClient(pool);
  });

  it('commits after an exec and returns the committed tx id', async () => {
    const result = client.readWrite(async (tx) => {
      sessions[0]?.commit.mockResolvedValueOnce({
        header: TxHeader.fromPartial({ id: '42' }),
        updatedRows: 1,
        lastInsertedPKs: {},
        firstInsertedPKs: {},
      });
      await tx.exec('INSERT', { a: 1n });
      return 'ok';
    });
    await expect(result).resolves.toEqual({ result: 'ok', txId: 42n });
    const [session] = sessions;
    expect(session?.newTx).toHaveBeenCalledWith(TxMode.ReadWrite, undefined);
    expect(session?.commit).toHaveBeenCalledWith('tx-1');
    expect(session?.rollback).not.toHaveBeenCalled();
  });

  it('rolls back instead of committing when nothing was written', async () => {
    await expect(client.readWrite(async () => 1)).resolves.toEqual({ result: 1, txId: null });
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
    expect(sessions[0]?.commit).not.toHaveBeenCalled();
  });

  it('never rolls back after a failed statement and surfaces the original error', async () => {
    const work = client.readWrite(async (tx) => {
      sessions[0]?.txExec.mockRejectedValueOnce(grpcError('key already exists'));
      await tx.exec('INSERT');
    });
    await expect(work).rejects.toMatchObject({ kind: 'duplicate-key' });
    expect(sessions[0]?.rollback).not.toHaveBeenCalled();
  });

  it('rolls back after an application error', async () => {
    await expect(
      client.readWrite(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
  });

  it('passes the snapshot floor of a read-only transaction', async () => {
    await client.readOnly(async () => undefined, { mustIncludeTxId: 7n });
    expect(sessions[0]?.newTx).toHaveBeenCalledWith(TxMode.ReadOnly, 7n);
    expect(sessions[0]?.rollback).toHaveBeenCalledWith('tx-1');
  });

  it('retries once on a fresh session when the server forgot the pooled one', async () => {
    await client.readOnly(async () => undefined);
    sessions[0]?.newTx.mockRejectedValueOnce(grpcError('no session found'));
    await expect(client.readOnly(async () => 'again')).resolves.toBe('again');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project immudb src/client` — Expected: FAIL (modules
      `./session-pool.js`, `./grpc-immudb.client.js` not found).

- [ ] **Step 3: Implement the call helpers and the session.** `libs/immudb/src/client/grpc-call.ts`:

```ts
import type {
  CallOptions,
  ClientReadableStream,
  ClientUnaryCall,
  Metadata,
  ServiceError,
} from '@grpc/grpc-js';

export type UnaryMethod<TReq, TRes> = (
  request: TReq,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: TRes) => void,
) => ClientUnaryCall;

export type ServerStreamMethod<TReq, TRes> = (
  request: TReq,
  metadata: Metadata,
  options: Partial<CallOptions>,
) => ClientReadableStream<TRes>;

/** One unary call with a deadline, as a promise. */
export function unary<TReq, TRes>(
  method: UnaryMethod<TReq, TRes>,
  request: TReq,
  metadata: Metadata,
  timeoutMs: number,
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    method(request, metadata, { deadline: Date.now() + timeoutMs }, (error, response) => {
      if (error === null) resolve(response);
      else reject(error);
    });
  });
}

/** Drains a server stream (immudb streams SQL results in chunks). */
export function drain<TReq, TRes>(
  method: ServerStreamMethod<TReq, TRes>,
  request: TReq,
  metadata: Metadata,
  timeoutMs: number,
): Promise<TRes[]> {
  return new Promise<TRes[]>((resolve, reject) => {
    const chunks: TRes[] = [];
    const stream = method(request, metadata, { deadline: Date.now() + timeoutMs });
    stream.on('data', (chunk: TRes) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks));
  });
}
```

`libs/immudb/src/client/immudb-session.ts`:

```ts
import { Metadata } from '@grpc/grpc-js';
import type { Empty } from '../generated/google/protobuf/empty.pb.js';
import {
  ChangeSQLPrivilegesRequest,
  type ChangeSQLPrivilegesResponse,
  type CommittedSQLTx,
  CreateDatabaseRequest,
  type CreateDatabaseResponse,
  CreateUserRequest,
  type HealthResponse,
  type ImmuServiceClient,
  type ImmutableState,
  NewTxRequest,
  type NewTxResponse,
  OpenSessionRequest,
  type OpenSessionResponse,
  PermissionAction,
  SQLExecRequest,
  type SQLExecResult,
  SQLQueryRequest,
  type SQLQueryResult,
  type TxMode,
  type VerifiableSQLEntry,
  VerifiableSQLGetRequest,
  type VerifiableTx,
  VerifiableTxRequest,
} from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbRow, ImmudbValue } from '../immudb.types.js';
import { drain, type ServerStreamMethod, type UnaryMethod, unary } from './grpc-call.js';
import { rowsOf, toNamedParams, toSqlValue } from './sql-values.js';

export interface ImmudbLogin {
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/** CreateUser permission: 1 read, 2 read-write, 254 admin. SQL privileges are narrowed afterwards. */
const PERMISSION_READ_WRITE = 2;

/**
 * One immudb session (`OpenSession`, metadata `sessionid`). A session runs at most one
 * transaction at a time (metadata `transactionid`). Every RPC is wrapped in a lambda so the
 * generated client's methods are never referenced unbound.
 */
export class ImmudbSession {
  private constructor(
    private readonly client: ImmuServiceClient,
    readonly id: string,
    private readonly timeoutMs: number,
  ) {}

  static async open(
    client: ImmuServiceClient,
    login: ImmudbLogin,
    timeoutMs: number,
  ): Promise<ImmudbSession> {
    const response = await unary<OpenSessionRequest, OpenSessionResponse>(
      (r, m, o, cb) => client.openSession(r, m, o, cb),
      OpenSessionRequest.fromPartial({
        username: Buffer.from(login.username),
        password: Buffer.from(login.password),
        databaseName: login.database,
      }),
      new Metadata(),
      timeoutMs,
    );
    return new ImmudbSession(client, response.sessionID, timeoutMs);
  }

  private metadata(transactionId?: string): Metadata {
    const metadata = new Metadata();
    metadata.set('sessionid', this.id);
    if (transactionId !== undefined) metadata.set('transactionid', transactionId);
    return metadata;
  }

  private call<TReq, TRes>(
    method: UnaryMethod<TReq, TRes>,
    request: TReq,
    transactionId?: string,
  ): Promise<TRes> {
    return unary(method, request, this.metadata(transactionId), this.timeoutMs);
  }

  async keepAlive(): Promise<void> {
    await this.call<Empty, Empty>((r, m, o, cb) => this.client.keepAlive(r, m, o, cb), {});
  }

  async close(): Promise<void> {
    await this.call<Empty, Empty>((r, m, o, cb) => this.client.closeSession(r, m, o, cb), {});
  }

  health(): Promise<HealthResponse> {
    return this.call<Empty, HealthResponse>((r, m, o, cb) => this.client.health(r, m, o, cb), {});
  }

  async newTx(mode: TxMode, mustIncludeTxId?: bigint): Promise<string> {
    const response = await this.call<NewTxRequest, NewTxResponse>(
      (r, m, o, cb) => this.client.newTx(r, m, o, cb),
      NewTxRequest.fromPartial({
        mode,
        snapshotMustIncludeTxID:
          mustIncludeTxId === undefined ? undefined : { value: mustIncludeTxId.toString() },
      }),
    );
    return response.transactionID;
  }

  commit(transactionId: string): Promise<CommittedSQLTx> {
    return this.call<Empty, CommittedSQLTx>(
      (r, m, o, cb) => this.client.commit(r, m, o, cb),
      {},
      transactionId,
    );
  }

  async rollback(transactionId: string): Promise<void> {
    await this.call<Empty, Empty>(
      (r, m, o, cb) => this.client.rollback(r, m, o, cb),
      {},
      transactionId,
    );
  }

  async txExec(transactionId: string, sql: string, params?: ImmudbParams): Promise<void> {
    await this.call<SQLExecRequest, Empty>(
      (r, m, o, cb) => this.client.txSqlExec(r, m, o, cb),
      SQLExecRequest.fromPartial({ sql, params: toNamedParams(params) }),
      transactionId,
    );
  }

  txQueryRaw(transactionId: string, sql: string, params?: ImmudbParams): Promise<SQLQueryResult[]> {
    const method: ServerStreamMethod<SQLQueryRequest, SQLQueryResult> = (r, m, o) =>
      this.client.txSqlQuery(r, m, o);
    return drain(
      method,
      SQLQueryRequest.fromPartial({ sql, params: toNamedParams(params) }),
      this.metadata(transactionId),
      this.timeoutMs,
    );
  }

  async txQuery(transactionId: string, sql: string, params?: ImmudbParams): Promise<ImmudbRow[]> {
    return rowsOf(await this.txQueryRaw(transactionId, sql, params));
  }

  /** `SQLExec`: statements in their own server transaction, committed on success (DDL, provisioning). */
  async exec(sql: string, params?: ImmudbParams): Promise<void> {
    await this.call<SQLExecRequest, SQLExecResult>(
      (r, m, o, cb) => this.client.sqlExec(r, m, o, cb),
      SQLExecRequest.fromPartial({ sql, params: toNamedParams(params) }),
    );
  }

  currentState(): Promise<ImmutableState> {
    return this.call<Empty, ImmutableState>(
      (r, m, o, cb) => this.client.currentState(r, m, o, cb),
      {},
    );
  }

  verifiableTxById(tx: bigint, proveSinceTx: bigint): Promise<VerifiableTx> {
    return this.call<VerifiableTxRequest, VerifiableTx>(
      (r, m, o, cb) => this.client.verifiableTxById(r, m, o, cb),
      VerifiableTxRequest.fromPartial({ tx: tx.toString(), proveSinceTx: proveSinceTx.toString() }),
    );
  }

  verifiableSqlGet(
    table: string,
    pk: readonly ImmudbValue[],
    proveSinceTx: bigint,
  ): Promise<VerifiableSQLEntry> {
    return this.call<VerifiableSQLGetRequest, VerifiableSQLEntry>(
      (r, m, o, cb) => this.client.verifiableSqlGet(r, m, o, cb),
      VerifiableSQLGetRequest.fromPartial({
        sqlGetRequest: { table, pkValues: pk.map(toSqlValue) },
        proveSinceTx: proveSinceTx.toString(),
      }),
    );
  }

  async createDatabase(name: string): Promise<void> {
    await this.call<CreateDatabaseRequest, CreateDatabaseResponse>(
      (r, m, o, cb) => this.client.createDatabaseV2(r, m, o, cb),
      CreateDatabaseRequest.fromPartial({ name, ifNotExists: true }),
    );
  }

  async createUser(username: string, password: string, database: string): Promise<void> {
    await this.call<CreateUserRequest, Empty>(
      (r, m, o, cb) => this.client.createUser(r, m, o, cb),
      CreateUserRequest.fromPartial({
        user: Buffer.from(username),
        password: Buffer.from(password),
        permission: PERMISSION_READ_WRITE,
        database,
      }),
    );
  }

  async revokeSqlPrivileges(
    username: string,
    database: string,
    privileges: readonly string[],
  ): Promise<void> {
    await this.call<ChangeSQLPrivilegesRequest, ChangeSQLPrivilegesResponse>(
      (r, m, o, cb) => this.client.changeSqlPrivileges(r, m, o, cb),
      ChangeSQLPrivilegesRequest.fromPartial({
        action: PermissionAction.REVOKE,
        username,
        database,
        privileges: [...privileges],
      }),
    );
  }
}
```

If `tsc` reports that a generated message or method name differs (ts-proto keeps proto casing, e.g.
`txSqlExec`, `verifiableSqlGet`, `createDatabaseV2`, `LinearProof.TargetTxId`), use the generated name.

- [ ] **Step 4: Implement the pool and the client.** `libs/immudb/src/client/session-pool.ts`:

```ts
import { ImmudbError, isSessionGone, toImmudbError } from '../errors/immudb.error.js';
import type { ImmudbSession } from './immudb-session.js';

export interface PoolableSession {
  keepAlive(): Promise<void>;
  close(): Promise<void>;
}

/** Property-style members: they are passed unbound to `then` (no unbound-method). */
interface Waiter<TSession> {
  readonly resolve: (session: TSession) => void;
  readonly reject: (error: unknown) => void;
}

/** A failure after which the session must not be reused (expired, server gone). */
function poisons(error: unknown): boolean {
  if (error instanceof ImmudbError) return error.kind === 'unavailable';
  return isSessionGone(error) || toImmudbError(error)?.kind === 'unavailable';
}

/**
 * At most `size` sessions, opened lazily. Idle sessions get a `KeepAlive` every
 * `keepAliveIntervalMs` (the server drops sessions idle for 3 minutes); a session whose call or
 * keepalive failed with `unavailable` is closed and replaced, never returned to the pool.
 */
export class ImmudbSessionPool<TSession extends PoolableSession = ImmudbSession> {
  private readonly idle: TSession[] = [];
  private readonly waiting: Waiter<TSession>[] = [];
  private open = 0;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly factory: () => Promise<TSession>,
    private readonly size: number,
    keepAliveIntervalMs: number,
  ) {
    this.timer = setInterval(() => {
      void this.keepAliveIdle();
    }, keepAliveIntervalMs);
    this.timer.unref();
  }

  async use<T>(work: (session: TSession) => Promise<T>): Promise<T> {
    const session = await this.acquire();
    let healthy = true;
    try {
      return await work(session);
    } catch (error) {
      healthy = !poisons(error);
      throw error;
    } finally {
      this.release(session, healthy);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new ImmudbError('unavailable', 'immudb session pool is closed'));
    }
    await Promise.all(this.idle.splice(0).map((session) => this.discard(session)));
  }

  private async acquire(): Promise<TSession> {
    if (this.closed) throw new ImmudbError('unavailable', 'immudb session pool is closed');
    const idle = this.idle.pop();
    if (idle !== undefined) return idle;
    if (this.open < this.size) return this.openOne();
    return new Promise<TSession>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private async openOne(): Promise<TSession> {
    this.open++;
    try {
      return await this.factory();
    } catch (error) {
      this.open--;
      throw toImmudbError(error) ?? error;
    }
  }

  private release(session: TSession, healthy: boolean): void {
    if (healthy && !this.closed) {
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.idle.push(session);
      else waiter.resolve(session);
      return;
    }
    void this.discard(session);
    const waiter = this.waiting.shift();
    if (waiter !== undefined) this.openOne().then(waiter.resolve, waiter.reject);
  }

  private async discard(session: TSession): Promise<void> {
    this.open--;
    await session.close().catch(() => undefined);
  }

  private async keepAliveIdle(): Promise<void> {
    for (const session of [...this.idle]) {
      try {
        await session.keepAlive();
      } catch {
        const index = this.idle.indexOf(session);
        if (index >= 0) {
          this.idle.splice(index, 1);
          await this.discard(session);
        }
      }
    }
  }
}
```

`libs/immudb/src/client/immudb.client.ts`:

```ts
import type { ImmudbState, ImmudbTx } from '../immudb.types.js';

/** The immudb SQL client every consumer injects (DI token: this class). */
export abstract class ImmudbClient {
  /** Commits when work ran an exec, rolls back otherwise; never rolls back after a failed statement. */
  abstract readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }>;

  /** Snapshot read; `mustIncludeTxId` waits until that tx is visible (read-your-writes). */
  abstract readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts?: { mustIncludeTxId?: bigint },
  ): Promise<T>;

  abstract currentState(): Promise<ImmudbState>;
}
```

`libs/immudb/src/client/grpc-immudb.client.ts`:

```ts
import { ImmudbError, isSessionGone, toImmudbError } from '../errors/immudb.error.js';
import { type ImmutableState, TxMode } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbParams, ImmudbState, ImmudbTx, ImmudbValue } from '../immudb.types.js';
import { ImmudbClient } from './immudb.client.js';
import type { ImmudbSession } from './immudb-session.js';
import type { ImmudbSessionPool } from './session-pool.js';

async function mapped<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toImmudbError(error) ?? error;
  }
}

export function toImmudbState(state: ImmutableState): ImmudbState {
  const signature = state.signature?.signature;
  return {
    database: state.db,
    txId: BigInt(state.txId),
    txHash: new Uint8Array(state.txHash),
    signature: signature !== undefined && signature.length > 0 ? new Uint8Array(signature) : null,
  };
}

/** The pooled session was dropped by the server before the transaction began: safe to retry. */
class StaleSessionError extends ImmudbError {
  constructor(cause: unknown) {
    super('unavailable', 'immudb session expired before the transaction began', { cause });
  }
}

class SessionTx implements ImmudbTx {
  wrote = false;
  /** A statement failed: the server already ended the transaction (never Rollback it). */
  failed = false;

  constructor(
    private readonly session: ImmudbSession,
    private readonly id: string,
  ) {}

  async exec(sql: string, params?: ImmudbParams): Promise<void> {
    this.wrote = true;
    await this.guard(this.session.txExec(this.id, sql, params));
  }

  async query<T extends Record<string, ImmudbValue>>(
    sql: string,
    params?: ImmudbParams,
  ): Promise<T[]> {
    return (await this.guard(this.session.txQuery(this.id, sql, params))) as T[];
  }

  private async guard<R>(call: Promise<R>): Promise<R> {
    try {
      return await call;
    } catch (error) {
      this.failed = true;
      throw toImmudbError(error) ?? error;
    }
  }
}

export class GrpcImmudbClient extends ImmudbClient {
  constructor(private readonly pool: ImmudbSessionPool) {
    super();
  }

  override readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }> {
    return this.inTx(TxMode.ReadWrite, undefined, async (session, id) => {
      const tx = new SessionTx(session, id);
      const result = await this.run(session, id, tx, work);
      if (!tx.wrote) {
        await mapped(session.rollback(id));
        return { result, txId: null };
      }
      const committed = await mapped(session.commit(id));
      return { result, txId: BigInt(committed.header?.id ?? '0') };
    });
  }

  override readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts: { mustIncludeTxId?: bigint } = {},
  ): Promise<T> {
    return this.inTx(TxMode.ReadOnly, opts.mustIncludeTxId, async (session, id) => {
      const tx = new SessionTx(session, id);
      const result = await this.run(session, id, tx, work);
      await mapped(session.rollback(id));
      return result;
    });
  }

  override currentState(): Promise<ImmudbState> {
    return this.pool.use(async (session) => toImmudbState(await mapped(session.currentState())));
  }

  private async run<T>(
    session: ImmudbSession,
    id: string,
    tx: SessionTx,
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(tx);
    } catch (error) {
      // An application error leaves the server tx open: end it. After a failed statement the
      // server already ended it, and Rollback would answer "no transaction found".
      if (!tx.failed) await session.rollback(id).catch(() => undefined);
      throw error;
    }
  }

  private async inTx<T>(
    mode: TxMode,
    mustIncludeTxId: bigint | undefined,
    body: (session: ImmudbSession, id: string) => Promise<T>,
  ): Promise<T> {
    const attempt = (): Promise<T> =>
      this.pool.use(async (session) => {
        let id: string;
        try {
          id = await session.newTx(mode, mustIncludeTxId);
        } catch (error) {
          throw isSessionGone(error)
            ? new StaleSessionError(error)
            : (toImmudbError(error) ?? error);
        }
        return body(session, id);
      });
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof StaleSessionError) return attempt();
      throw error;
    }
  }
}
```

- [ ] **Step 5: Module, constants, health, factory, testing fake.** `libs/immudb/src/client/create-immudb-grpc-client.ts`:

```ts
import { credentials } from '@grpc/grpc-js';
import { ImmuServiceClient } from '../generated/immudb/schema/schema.pb.js';

/** One HTTP/2 channel per process; sessions multiplex over it. */
export function createImmudbGrpcClient(cfg: { address: string; tls: boolean }): ImmuServiceClient {
  return new ImmuServiceClient(
    cfg.address,
    cfg.tls ? credentials.createSsl() : credentials.createInsecure(),
    {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    },
  );
}
```

`libs/immudb/src/immudb.constants.ts`:

```ts
/** The generated grpc-js `ImmuServiceClient` (one channel per process). */
export const IMMUDB_GRPC_CLIENT = Symbol('IMMUDB_GRPC_CLIENT');
/** The options passed to `ImmudbModule.forRootAsync()`. */
export const IMMUDB_MODULE_OPTIONS = Symbol('IMMUDB_MODULE_OPTIONS');
```

`libs/immudb/src/health/immudb.health.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { HealthContributor } from '@platform/observability';
import { ImmudbSessionPool } from '../client/session-pool.js';

/** Below the readiness endpoint's per-contributor budget (3 s). */
const PING_TIMEOUT_MS = 2_000;

/** Readiness contributor `immudb`: the `Health` RPC on a pooled session. */
@Injectable()
export class ImmudbHealthIndicator extends HealthContributor {
  override readonly key = 'immudb';

  constructor(
    private readonly pool: ImmudbSessionPool,
    private readonly health: HealthIndicatorService,
  ) {
    super();
  }

  override async check(): Promise<HealthIndicatorResult> {
    return this.health
      .check(this.key)
      .attempt(async () => {
        const response = await this.pool.use((session) => session.health());
        if (!response.status) throw new Error('immudb reports itself unhealthy');
      })
      .withTimeout(PING_TIMEOUT_MS);
  }
}
```

`libs/immudb/src/immudb.module.ts`:

```ts
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { type ImmudbConfig, immudbConfig } from '@platform/config';
import { createImmudbGrpcClient } from './client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from './client/grpc-immudb.client.js';
import { ImmudbClient } from './client/immudb.client.js';
import { ImmudbSession } from './client/immudb-session.js';
import { ImmudbSessionPool } from './client/session-pool.js';
import type { ImmuServiceClient } from './generated/immudb/schema/schema.pb.js';
import { ImmudbHealthIndicator } from './health/immudb.health.js';
import { IMMUDB_GRPC_CLIENT, IMMUDB_MODULE_OPTIONS } from './immudb.constants.js';
import type { ImmudbModuleOptions } from './immudb.types.js';

@Injectable()
class ImmudbLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('ImmudbModule');

  constructor(
    private readonly pool: ImmudbSessionPool,
    @Inject(IMMUDB_GRPC_CLIENT) private readonly grpc: ImmuServiceClient,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.pool.close();
    this.grpc.close();
    this.logger.log(`immudb sessions closed (${signal ?? 'shutdown'})`);
  }
}

/**
 * immudb (global): `ImmudbClient` (inject the class) and `ImmudbHealthIndicator` (register it with
 * `ObservabilityModule.forRoot({ healthContributors: [ImmudbHealthIndicator] })`).
 */
@Module({})
export class ImmudbModule {
  static forRootAsync(options: ImmudbModuleOptions = {}): DynamicModule {
    return {
      module: ImmudbModule,
      global: true,
      imports: [ConfigModule.forFeature(immudbConfig), TerminusModule],
      providers: [
        { provide: IMMUDB_MODULE_OPTIONS, useValue: options },
        {
          provide: IMMUDB_GRPC_CLIENT,
          inject: [immudbConfig.KEY],
          useFactory: (cfg: ImmudbConfig): ImmuServiceClient => createImmudbGrpcClient(cfg),
        },
        {
          provide: ImmudbSessionPool,
          inject: [IMMUDB_GRPC_CLIENT, immudbConfig.KEY],
          useFactory: (grpc: ImmuServiceClient, cfg: ImmudbConfig): ImmudbSessionPool =>
            new ImmudbSessionPool(
              () =>
                ImmudbSession.open(
                  grpc,
                  { ...cfg.credentials, database: cfg.database },
                  cfg.timeoutMs,
                ),
              cfg.sessionPoolSize,
              cfg.keepAliveIntervalMs,
            ),
        },
        {
          provide: ImmudbClient,
          inject: [ImmudbSessionPool],
          useFactory: (pool: ImmudbSessionPool): ImmudbClient => new GrpcImmudbClient(pool),
        },
        ImmudbLifecycle,
        ImmudbHealthIndicator,
      ],
      exports: [ImmudbClient, ImmudbHealthIndicator],
    };
  }
}
```

`libs/immudb/src/testing/recording-immudb.client.ts`:

```ts
import { ImmudbClient } from '../client/immudb.client.js';
import type {
  ImmudbParams,
  ImmudbRow,
  ImmudbState,
  ImmudbTx,
  ImmudbValue,
} from '../immudb.types.js';

export interface RecordedStatement {
  readonly mode: 'readWrite' | 'readOnly';
  readonly kind: 'exec' | 'query';
  readonly sql: string;
  readonly params: ImmudbParams;
}

/**
 * Unit-test `ImmudbClient`: records every statement and answers queries with `respond`. Pins the
 * SQL an adapter sends (tenant predicates, parameter binding) without a server.
 */
export class RecordingImmudbClient extends ImmudbClient {
  readonly statements: RecordedStatement[] = [];
  private nextTxId = 1n;

  constructor(private readonly respond: (statement: RecordedStatement) => ImmudbRow[] = () => []) {
    super();
  }

  override async readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }> {
    let wrote = false;
    const result = await work(this.tx('readWrite', () => (wrote = true)));
    return { result, txId: wrote ? this.nextTxId++ : null };
  }

  override readOnly<T>(work: (tx: ImmudbTx) => Promise<T>): Promise<T> {
    return work(this.tx('readOnly', () => undefined));
  }

  override async currentState(): Promise<ImmudbState> {
    return {
      database: 'test',
      txId: this.nextTxId - 1n,
      txHash: new Uint8Array(32),
      signature: null,
    };
  }

  private tx(mode: RecordedStatement['mode'], onExec: () => void): ImmudbTx {
    return {
      exec: async (sql: string, params: ImmudbParams = {}): Promise<void> => {
        onExec();
        const statement = { mode, kind: 'exec', sql, params } as const;
        this.statements.push(statement);
        this.respond(statement);
      },
      query: async <T extends Record<string, ImmudbValue>>(
        sql: string,
        params: ImmudbParams = {},
      ): Promise<T[]> => {
        const statement = { mode, kind: 'query', sql, params } as const;
        this.statements.push(statement);
        return this.respond(statement) as T[];
      },
    };
  }
}
```

`libs/immudb/src/testing/index.ts`:

```ts
export * from './recording-immudb.client.js';
```

`libs/immudb/package.json`: add after the `"."` export block:

```json
    "./testing": {
      "@repo/source": "./src/testing/index.ts",
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    },
```

`libs/immudb/src/index.ts`: append

```ts
export * from './client/immudb.client.js';
export * from './health/immudb.health.js';
export * from './immudb.module.js';
```

- [ ] **Step 6: Run the unit tests.** `npx vitest run --project immudb` — Expected: PASS.

- [ ] **Step 7: Write the int spec.** `libs/immudb/test/immudb-client.int-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '@platform/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbClient } from '../src/client/immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import type { ImmudbError } from '../src/errors/immudb.error.js';
import { type ImmuServiceClient, TxMode } from '../src/generated/immudb/schema/schema.pb.js';
import { ImmudbHealthIndicator } from '../src/health/immudb.health.js';
import { ImmudbModule } from '../src/immudb.module.js';
import type { ImmudbTx } from '../src/immudb.types.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';

const ADMIN = { username: 'immudb', password: 'immudb', database: 'defaultdb' } as const;
const TIMEOUT_MS = 5_000;

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb client against immudb 1.11.2', () => {
  let container: StartedTestContainer | undefined;
  let address: string;
  let grpc: ImmuServiceClient;
  const opened: ImmudbSession[] = [];
  let pool: ImmudbSessionPool;
  let client: GrpcImmudbClient;

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    address = `${container.getHost()}:${container.getMappedPort(3322)}`;
    grpc = createImmudbGrpcClient({ address, tls: false });
    pool = new ImmudbSessionPool(
      async () => {
        const session = await ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS);
        opened.push(session);
        return session;
      },
      1,
      60_000,
    );
    client = new GrpcImmudbClient(pool);
    await client.readWrite((tx) =>
      tx.exec('CREATE TABLE IF NOT EXISTS kv (id VARCHAR[64], n INTEGER, PRIMARY KEY id)'),
    );
  });

  afterAll(async () => {
    await pool?.close();
    grpc?.close();
    await container?.stop();
  });

  const insert = (id: string, n: bigint) => (tx: ImmudbTx) =>
    tx.exec('INSERT INTO kv (id, n) VALUES (@id, @n)', { id, n });

  it('commits, returns the tx id and reads int64 extremes back at that snapshot', async () => {
    const { txId } = await client.readWrite(async (tx) => {
      await insert('big', 9007199254740993n)(tx);
      await insert('neg', -1n)(tx);
    });
    expect(txId).toBeGreaterThan(0n);
    const rows = await client.readOnly(
      (tx) =>
        tx.query<{ id: string; n: bigint }>(
          'SELECT id, n FROM kv WHERE id = @a OR id = @b ORDER BY id',
          { a: 'big', b: 'neg' },
        ),
      { mustIncludeTxId: txId ?? 0n },
    );
    expect(rows).toEqual([
      { id: 'big', n: 9007199254740993n },
      { id: 'neg', n: -1n },
    ]);
  });

  it('returns no tx id when the work wrote nothing', async () => {
    await expect(
      client.readWrite((tx) => tx.query('SELECT id FROM kv WHERE id = @id', { id: 'none' })),
    ).resolves.toEqual({ result: [], txId: null });
  });

  it('surfaces duplicate-key, not tx-closed, and keeps the session usable', async () => {
    await client.readWrite(insert('dup', 1n));
    const sessionsBefore = opened.length;
    await expect(client.readWrite(insert('dup', 2n))).rejects.toMatchObject({
      kind: 'duplicate-key',
    });
    await expect(
      client.readOnly((tx) => tx.query('SELECT n FROM kv WHERE id = @id', { id: 'dup' })),
    ).resolves.toEqual([{ n: 1n }]);
    expect(opened).toHaveLength(sessionsBefore);
  });

  it('reports tx-closed for a statement after a failed one', async () => {
    await expect(
      client.readWrite(async (tx) => {
        await insert('dup', 3n)(tx).catch(() => undefined);
        await insert('after-failure', 1n)(tx);
      }),
    ).rejects.toMatchObject({ kind: 'tx-closed' });
  });

  it('refuses writes in a read-only transaction', async () => {
    await expect(client.readOnly(insert('ro', 1n))).rejects.toMatchObject({ kind: 'read-only' });
  });

  it('lets exactly one of two racing read-check-insert transactions win', async () => {
    const racePool = new ImmudbSessionPool(
      () => ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS),
      2,
      60_000,
    );
    const racing = new GrpcImmudbClient(racePool);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const post = () =>
      racing.readWrite(async (tx) => {
        const seen = await tx.query('SELECT id FROM kv WHERE id = @id', { id: 'race' });
        if (++arrived === 2) open();
        await gate;
        if (seen.length === 0) await insert('race', 1n)(tx);
      });
    const results = await Promise.allSettled([post(), post()]);
    await racePool.close();
    const reasons = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as ImmudbError] : [],
    );
    expect(reasons).toHaveLength(1);
    expect(['read-conflict', 'duplicate-key']).toContain(reasons[0]?.kind);
  });

  it('pins the raw selectors of a column, an alias and aliased aggregates', async () => {
    const session = await ImmudbSession.open(grpc, ADMIN, TIMEOUT_MS);
    const id = await session.newTx(TxMode.ReadOnly);
    const plain = await session.txQueryRaw(id, 'SELECT id, n AS amount FROM kv WHERE id = @id', {
      id: 'big',
    });
    const grouped = await session.txQueryRaw(
      id,
      'SELECT COUNT(*) AS rows_total, SUM(n) AS n_total FROM kv',
    );
    await session.rollback(id);
    await session.close();
    // If these fail, immudb's selector format differs from 1.11 EncodeSelector: adapt `columnKey`
    // and its unit table to the observed format; never work around it in queries.
    expect(plain[0]?.rows[0]?.columns).toEqual(['(kv.id)', '(kv.amount)']);
    expect(grouped[0]?.rows[0]?.columns).toEqual(['(kv.rows_total)', '(kv.n_total)']);
  });

  it('replaces a session the server forgot and retries the transaction once', async () => {
    const before = opened.length;
    await opened.at(-1)?.close(); // behind the pool's back
    await expect(
      client.readOnly((tx) => tx.query('SELECT id FROM kv WHERE id = @id', { id: 'big' })),
    ).resolves.toEqual([{ id: 'big' }]);
    expect(opened).toHaveLength(before + 1);
  });

  it('serves ImmudbClient and a ready health contributor through ImmudbModule', async () => {
    vi.stubEnv('IMMUDB_ADDRESS', address);
    vi.stubEnv('IMMUDB_DATABASE', 'defaultdb');
    vi.stubEnv('IMMUDB_USERNAME', 'immudb');
    vi.stubEnv('IMMUDB_PASSWORD', 'immudb');
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), ImmudbModule.forRootAsync()],
    }).compile();
    try {
      await expect(moduleRef.get(ImmudbClient).currentState()).resolves.toMatchObject({
        database: 'defaultdb',
      });
      await expect(moduleRef.get(ImmudbHealthIndicator).check()).resolves.toMatchObject({
        immudb: { status: 'up' },
      });
    } finally {
      await moduleRef.close();
      vi.unstubAllEnvs();
    }
  });
});
```

- [ ] **Step 8: Run the int spec (Docker, sandbox off).**
      `INTEGRATION=1 npx vitest run --project immudb:int` — Expected: PASS (9 tests). If the race test
      shows both transactions fulfilled, the MVCC read set is not being tracked: check that `NewTx` used
      `TxMode.ReadWrite` (P8 relied on it). Unverified (Docker was down at review): the 1.11.2 selector
      of an aliased column and of aliased aggregates (`(kv.amount)`, `(kv.rows_total)`; v1.9DOM.1
      `proj_row_reader.go` gives exactly these) and the `no session found` text after a closed
      session; **unverified: the L-9 int spec must confirm it** too (it reads aliased `SUM`s).

- [ ] **Step 9: Wider checks.** `npx biome check --write libs/immudb`, `bun run check` (Expected: PASS;
      `scripts/check-boundaries.mjs` accepts `@platform/immudb/testing` only from test code).

- [ ] **Step 10: Commit.**

```bash
git add libs/immudb
git commit -m "feat(immudb): add the session pool, ImmudbClient transactions, module and health" \
  -m "Pooled immudb sessions with keepalive and discard-on-expiry, ReadWrite/ReadOnly transactions
that never roll back after a failed statement, one retry on a stale session, ImmudbModule
(global) and the immudb readiness contributor. ./testing exports RecordingImmudbClient. Int spec
on codenotary/immudb:1.11.2."
```

### Task L-3: provisioning, versioned SQL migrator and CLI

**Files:**

- Create: `libs/immudb/src/migrations/immudb-migrations.ts`,
  `libs/immudb/test/fixtures/migrations/001_kv.sql`, `libs/immudb/test/fixtures/migrations/002_kv_index.sql`
- Modify: `libs/immudb/src/immudb.module.ts` (pool factory runs migrations first when
  `IMMUDB_RUN_MIGRATIONS=true`), `libs/immudb/src/index.ts`
- Test: `libs/immudb/src/migrations/immudb-migrations.spec.ts`,
  `libs/immudb/test/immudb-migrations.int-spec.ts`

**Interfaces:**

- Consumes: L-2b `ImmudbSession`, `createImmudbGrpcClient`; L-2a `ImmudbConfig`, `toImmudbError`,
  `ImmudbMigrationSource`.
- Produces (barrel):

```ts
export const IMMUDB_MIGRATIONS_TABLE = 'immudb_migrations';
export const IMMUDB_REVOKED_PRIVILEGES: readonly ['UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE'];
export interface ImmudbMigrationFile {
  readonly id: string; // `${source.name}/${file}`
  readonly sql: string;
  readonly statements: readonly string[];
  readonly checksum: string; // sha256 hex of the file
}
export interface ImmudbMigrationSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}
export function splitImmudbSql(sql: string): string[];
export function loadImmudbMigrations(
  sources: readonly ImmudbMigrationSource[],
): Promise<ImmudbMigrationFile[]>;
export function runImmudbMigrations(
  cfg: ImmudbConfig,
  sources: readonly ImmudbMigrationSource[],
  options?: { grpc?: ImmuServiceClient; logger?: Pick<Logger, 'log'>; now?: () => Date },
): Promise<ImmudbMigrationSummary>;
export function runImmudbMigrationsCli(sources: readonly ImmudbMigrationSource[]): Promise<void>;
```

Rules: files `NNN_name.sql` (`^\d{3}_[a-z0-9_]+\.sql$`), statements separated by `;`, `--` comments,
**only** `CREATE TABLE|INDEX|UNIQUE INDEX … IF NOT EXISTS` (so a concurrent or repeated run is harmless).
Provisioning (as admin on `defaultdb`): `CreateDatabaseV2(ifNotExists)`, `CreateUser` (read-write; an
existing user is kept as is), then `ChangeSQLPrivileges REVOKE UPDATE, DELETE, DROP, ALTER, CREATE`
(gRPC only: pg-wire `GRANT`/`REVOKE` are silent no-ops, spec P4). Bookkeeping table
`immudb_migrations (id VARCHAR[160], checksum VARCHAR[64], applied_at_us INTEGER, PRIMARY KEY id)` in
the target database; an applied file whose checksum changed fails the run.

**Wave:** after L-2b.

- [ ] **Step 1: Write the failing tests.** `libs/immudb/src/migrations/immudb-migrations.spec.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { immudbConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { loadImmudbMigrations, runImmudbMigrations, splitImmudbSql } from './immudb-migrations.js';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'immudb-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('immudb migrations', () => {
  it('splits statements and drops comments', () => {
    expect(
      splitImmudbSql(
        '-- header\nCREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);\n\n' +
          'CREATE INDEX IF NOT EXISTS ON a(id); -- trailing\n',
      ),
    ).toEqual([
      'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id)',
      'CREATE INDEX IF NOT EXISTS ON a(id)',
    ]);
  });

  it('loads files in version order with ids and checksums', async () => {
    const dir = dirWith({
      '002_b.sql': 'CREATE INDEX IF NOT EXISTS ON a(id);',
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);',
    });
    const files = await loadImmudbMigrations([{ name: 'src', dir }]);
    expect(files.map((f) => f.id)).toEqual(['src/001_a.sql', 'src/002_b.sql']);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      { 'one.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);' },
      /NNN_name\.sql/,
    ],
    [
      {
        '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id VARCHAR[8], PRIMARY KEY id);',
        '001_b.sql': '',
      },
      /version 001 is used twice/,
    ],
    [{ '001_a.sql': 'CREATE TABLE a (id VARCHAR[8], PRIMARY KEY id);' }, /IF NOT EXISTS/],
    [{ '001_a.sql': "INSERT INTO a (id) VALUES ('x');" }, /IF NOT EXISTS/],
  ])('rejects %o', async (files, message) => {
    await expect(loadImmudbMigrations([{ name: 'src', dir: dirWith(files) }])).rejects.toThrow(
      message,
    );
  });

  it('rejects a source listed twice', async () => {
    const dir = dirWith({});
    await expect(
      loadImmudbMigrations([
        { name: 'src', dir },
        { name: 'src', dir },
      ]),
    ).rejects.toThrow(/listed twice/);
  });

  it('needs the admin password before touching the server', async () => {
    await expect(runImmudbMigrations(immudbConfig.parse({}), [])).rejects.toThrow(
      /IMMUDB_ADMIN_PASSWORD/,
    );
  });
});
```

`libs/immudb/test/fixtures/migrations/001_kv.sql`:

```sql
-- Fixture for the migrator int spec.
CREATE TABLE IF NOT EXISTS kv (id VARCHAR[64], n INTEGER, PRIMARY KEY id);
```

`libs/immudb/test/fixtures/migrations/002_kv_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS ON kv(n);
```

`libs/immudb/test/immudb-migrations.int-spec.ts`:

```ts
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppConfigModule, immudbConfig } from '@platform/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbClient } from '../src/client/immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import { ImmudbModule } from '../src/immudb.module.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';
import { runImmudbMigrations } from '../src/migrations/immudb-migrations.js';

const FIXTURES = join(import.meta.dirname, 'fixtures/migrations');

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb provisioning and migrations', () => {
  let container: StartedTestContainer | undefined;
  let address: string;

  const configFor = (database: string, extra: Record<string, string> = {}) =>
    immudbConfig.parse({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: database,
      IMMUDB_ADMIN_PASSWORD: 'immudb',
      ...extra,
    });

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    address = `${container.getHost()}:${container.getMappedPort(3322)}`;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('provisions, applies once, then skips', async () => {
    const cfg = configFor('mig_once');
    const sources = [{ name: 'fixture', dir: FIXTURES }];
    await expect(runImmudbMigrations(cfg, sources)).resolves.toEqual({
      applied: ['fixture/001_kv.sql', 'fixture/002_kv_index.sql'],
      skipped: [],
    });
    await expect(runImmudbMigrations(cfg, sources)).resolves.toEqual({
      applied: [],
      skipped: ['fixture/001_kv.sql', 'fixture/002_kv_index.sql'],
    });
  });

  it('gives the application user SELECT and INSERT only', async () => {
    const cfg = configFor('mig_privileges');
    await runImmudbMigrations(cfg, [{ name: 'fixture', dir: FIXTURES }]);
    const grpc = createImmudbGrpcClient(cfg);
    const pool = new ImmudbSessionPool(
      () => ImmudbSession.open(grpc, { ...cfg.credentials, database: cfg.database }, 5_000),
      1,
      60_000,
    );
    const app = new GrpcImmudbClient(pool);
    try {
      await app.readWrite((tx) => tx.exec("INSERT INTO kv (id, n) VALUES ('a', 1)"));
      await expect(
        app.readOnly((tx) => tx.query("SELECT n FROM kv WHERE id = 'a'")),
      ).resolves.toEqual([{ n: 1n }]);
      for (const sql of [
        "UPDATE kv SET n = 2 WHERE id = 'a'",
        "DELETE FROM kv WHERE id = 'a'",
        "UPSERT INTO kv (id, n) VALUES ('a', 3)",
        'CREATE TABLE IF NOT EXISTS other (id VARCHAR[8], PRIMARY KEY id)',
      ]) {
        await expect(app.readWrite((tx) => tx.exec(sql))).rejects.toMatchObject({
          kind: 'access-denied',
        });
      }
    } finally {
      await pool.close();
      grpc.close();
    }
  });

  it('fails when an applied file changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'immudb-mig-'));
    cpSync(FIXTURES, dir, { recursive: true });
    const cfg = configFor('mig_changed');
    await runImmudbMigrations(cfg, [{ name: 'fixture', dir }]);
    writeFileSync(join(dir, '002_kv_index.sql'), 'CREATE INDEX IF NOT EXISTS ON kv(id, n);\n');
    await expect(runImmudbMigrations(cfg, [{ name: 'fixture', dir }])).rejects.toThrow(
      /fixture\/002_kv_index\.sql changed after it was applied/,
    );
  });

  it('survives two concurrent runs (replicas booting together)', async () => {
    const cfg = configFor('mig_race');
    const sources = [{ name: 'fixture', dir: FIXTURES }];
    const [a, b] = await Promise.all([
      runImmudbMigrations(cfg, sources),
      runImmudbMigrations(cfg, sources),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual([
      'fixture/001_kv.sql',
      'fixture/002_kv_index.sql',
    ]);
  });

  it('migrates at boot when IMMUDB_RUN_MIGRATIONS=true', async () => {
    vi.stubEnv('IMMUDB_ADDRESS', address);
    vi.stubEnv('IMMUDB_DATABASE', 'mig_boot');
    vi.stubEnv('IMMUDB_ADMIN_PASSWORD', 'immudb');
    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        ImmudbModule.forRootAsync({ migrations: [{ name: 'fixture', dir: FIXTURES }] }),
      ],
    }).compile();
    try {
      await expect(
        moduleRef.get(ImmudbClient).readOnly((tx) => tx.query('SELECT id FROM kv')),
      ).resolves.toEqual([]);
    } finally {
      await moduleRef.close();
      vi.unstubAllEnvs();
    }
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project immudb src/migrations` — Expected: FAIL
      (`Cannot find module './immudb-migrations.js'`).

- [ ] **Step 3: Implement.** `libs/immudb/src/migrations/immudb-migrations.ts`:

```ts
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { type ImmudbConfig, immudbConfig } from '@platform/config';
import { createImmudbGrpcClient } from '../client/create-immudb-grpc-client.js';
import { ImmudbSession } from '../client/immudb-session.js';
import { toImmudbError } from '../errors/immudb.error.js';
import { type ImmuServiceClient, TxMode } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbMigrationSource } from '../immudb.types.js';

export const IMMUDB_MIGRATIONS_TABLE = 'immudb_migrations';
/** Taken from the application user: it may only SELECT and INSERT (append-only by privilege). */
export const IMMUDB_REVOKED_PRIVILEGES = ['UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE'] as const;
/** immudb's system database: provisioning sessions open here. */
const SYSTEM_DATABASE = 'defaultdb';
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
const IDEMPOTENT = /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i;

export interface ImmudbMigrationFile {
  readonly id: string;
  readonly sql: string;
  readonly statements: readonly string[];
  readonly checksum: string;
}

export interface ImmudbMigrationSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface RunImmudbMigrationsOptions {
  readonly grpc?: ImmuServiceClient;
  readonly logger?: Pick<Logger, 'log'>;
  readonly now?: () => Date;
}

async function mapped<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toImmudbError(error) ?? error;
  }
}

/** Statements of a migration file (`;`-separated, `--` comments; no string literals with `;`). */
export function splitImmudbSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

export async function loadImmudbMigrations(
  sources: readonly ImmudbMigrationSource[],
): Promise<ImmudbMigrationFile[]> {
  const names = new Set<string>();
  const files: ImmudbMigrationFile[] = [];
  for (const source of sources) {
    if (names.has(source.name)) {
      throw new Error(`immudb migration source "${source.name}" is listed twice`);
    }
    names.add(source.name);
    const versions = new Set<string>();
    const entries = (await readdir(source.dir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of entries) {
      const version = FILE_NAME.exec(file)?.[1];
      if (version === undefined) throw new Error(`${source.name}/${file}: expected NNN_name.sql`);
      if (versions.has(version)) {
        throw new Error(`${source.name}: version ${version} is used twice`);
      }
      versions.add(version);
      const sql = await readFile(join(source.dir, file), 'utf8');
      const statements = splitImmudbSql(sql);
      const unsafe = statements.find((statement) => !IDEMPOTENT.test(statement));
      if (unsafe !== undefined) {
        throw new Error(
          `${source.name}/${file}: only CREATE TABLE|INDEX ... IF NOT EXISTS statements are allowed (got "${unsafe.slice(0, 60)}")`,
        );
      }
      files.push({
        id: `${source.name}/${file}`,
        sql,
        statements,
        checksum: createHash('sha256').update(sql).digest('hex'),
      });
    }
  }
  return files;
}

/** The object exists already, or a runner booting at the same time just created it (MVCC loser). */
function createdElsewhere(error: unknown): boolean {
  if (error instanceof Error && /already exists/.test(error.message)) return true;
  return toImmudbError(error)?.kind === 'read-conflict';
}

/** Runs an idempotent statement; a concurrent runner's catalog change surfaces as a read conflict. */
async function execIdempotent(session: ImmudbSession, sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await mapped(session.exec(sql));
      return;
    } catch (error) {
      if (toImmudbError(error)?.kind !== 'read-conflict' || attempt >= 5) throw error;
    }
  }
}

/** Database, application user (read-write), then its SQL privileges narrowed to SELECT + INSERT. */
async function provision(
  system: ImmudbSession,
  target: { database: string; username: string; password: string },
): Promise<void> {
  try {
    await system.createDatabase(target.database);
  } catch (error) {
    if (!createdElsewhere(error)) throw toImmudbError(error) ?? error;
  }
  try {
    await system.createUser(target.username, target.password, target.database);
  } catch (error) {
    // An existing user keeps its password and permissions (rotate with immuadmin).
    if (!createdElsewhere(error)) throw toImmudbError(error) ?? error;
  }
  // Re-applied on every run, so a run that died after CreateUser never leaves a read-write user.
  // The server then ends that user's open sessions (pkg/server/user.go ChangeSQLPrivileges): pools
  // recover through the "no session found" retry, but in production run migrations from one
  // process (the migrate step), not from every replica at boot.
  await mapped(
    system.revokeSqlPrivileges(target.username, target.database, IMMUDB_REVOKED_PRIVILEGES),
  );
}

type RecordedRow = { id: string; checksum: string };

async function recorded(session: ImmudbSession): Promise<Map<string, string>> {
  const tx = await mapped(session.newTx(TxMode.ReadOnly));
  try {
    const rows = (await mapped(
      session.txQuery(tx, `SELECT id, checksum FROM ${IMMUDB_MIGRATIONS_TABLE}`),
    )) as RecordedRow[];
    return new Map(rows.map((row) => [row.id, row.checksum]));
  } finally {
    await session.rollback(tx).catch(() => undefined);
  }
}

function assertUnchanged(file: ImmudbMigrationFile, checksum: string): void {
  if (checksum !== file.checksum) {
    throw new Error(`immudb migration ${file.id} changed after it was applied (never edit one)`);
  }
}

/** Records `file` as applied; `false` when another runner recorded it first. */
async function record(
  session: ImmudbSession,
  file: ImmudbMigrationFile,
  at: Date,
): Promise<boolean> {
  const tx = await mapped(session.newTx(TxMode.ReadWrite));
  try {
    const [existing] = (await mapped(
      session.txQuery(tx, `SELECT id, checksum FROM ${IMMUDB_MIGRATIONS_TABLE} WHERE id = @id`, {
        id: file.id,
      }),
    )) as RecordedRow[];
    if (existing !== undefined) {
      assertUnchanged(file, existing.checksum);
      await session.rollback(tx);
      return false;
    }
    await mapped(
      session.txExec(
        tx,
        `INSERT INTO ${IMMUDB_MIGRATIONS_TABLE} (id, checksum, applied_at_us) VALUES (@id, @checksum, @at)`,
        { id: file.id, checksum: file.checksum, at: BigInt(at.getTime()) * 1_000n },
      ),
    );
    await mapped(session.commit(tx));
    return true;
  } catch (error) {
    const kind = toImmudbError(error)?.kind;
    if (kind !== 'duplicate-key' && kind !== 'read-conflict') throw error;
    // A concurrent runner recorded it first (the server already ended this tx).
    const checksum = (await recorded(session)).get(file.id);
    if (checksum === undefined) throw error;
    assertUnchanged(file, checksum);
    return false;
  }
}

/**
 * Provisions `cfg.database` and the INSERT/SELECT-only `cfg.credentials` user (as `cfg.admin` on
 * `defaultdb`), then applies every pending file of `sources` in order as admin on `cfg.database`.
 * Idempotent and safe to run from several replicas at once.
 */
export async function runImmudbMigrations(
  cfg: ImmudbConfig,
  sources: readonly ImmudbMigrationSource[],
  options: RunImmudbMigrationsOptions = {},
): Promise<ImmudbMigrationSummary> {
  const admin = cfg.admin;
  if (admin === undefined) {
    throw new Error('IMMUDB_ADMIN_PASSWORD is required to provision and migrate immudb');
  }
  const files = await loadImmudbMigrations(sources);
  const logger = options.logger ?? new Logger('ImmudbMigrations');
  const now = options.now ?? (() => new Date());
  const grpc = options.grpc ?? createImmudbGrpcClient(cfg);
  try {
    const system = await mapped(
      ImmudbSession.open(grpc, { ...admin, database: SYSTEM_DATABASE }, cfg.timeoutMs),
    );
    try {
      await provision(system, { database: cfg.database, ...cfg.credentials });
    } finally {
      await system.close().catch(() => undefined);
    }
    const session = await mapped(
      ImmudbSession.open(grpc, { ...admin, database: cfg.database }, cfg.timeoutMs),
    );
    try {
      await execIdempotent(
        session,
        `CREATE TABLE IF NOT EXISTS ${IMMUDB_MIGRATIONS_TABLE} (id VARCHAR[160], checksum VARCHAR[64], applied_at_us INTEGER, PRIMARY KEY id)`,
      );
      const done = await recorded(session);
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const checksum = done.get(file.id);
        if (checksum !== undefined) {
          assertUnchanged(file, checksum);
          skipped.push(file.id);
          continue;
        }
        for (const statement of file.statements) await execIdempotent(session, statement);
        if (await record(session, file, now())) {
          applied.push(file.id);
          logger.log(`applied immudb migration ${file.id}`);
        } else {
          skipped.push(file.id);
        }
      }
      return { applied, skipped };
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    if (options.grpc === undefined) grpc.close();
  }
}

/** `src/migrate.ts` entry: `await runImmudbMigrationsCli([billingLedgerMigrations]);` */
export async function runImmudbMigrationsCli(
  sources: readonly ImmudbMigrationSource[],
): Promise<void> {
  const logger = new Logger('ImmudbMigrations');
  const summary = await runImmudbMigrations(immudbConfig.parse(), sources, { logger });
  logger.log(
    `immudb migrations: ${summary.applied.length} applied, ${summary.skipped.length} already applied`,
  );
}
```

`libs/immudb/src/immudb.module.ts`: replace the `ImmudbSessionPool` provider with

```ts
        {
          provide: ImmudbSessionPool,
          inject: [IMMUDB_GRPC_CLIENT, immudbConfig.KEY, IMMUDB_MODULE_OPTIONS],
          useFactory: async (
            grpc: ImmuServiceClient,
            cfg: ImmudbConfig,
            opts: ImmudbModuleOptions,
          ): Promise<ImmudbSessionPool> => {
            // Before any provider can inject the client (like CassandraModule's boot migrations).
            if (cfg.runMigrations) await runImmudbMigrations(cfg, opts.migrations ?? [], { grpc });
            return new ImmudbSessionPool(
              () =>
                ImmudbSession.open(
                  grpc,
                  { ...cfg.credentials, database: cfg.database },
                  cfg.timeoutMs,
                ),
              cfg.sessionPoolSize,
              cfg.keepAliveIntervalMs,
            );
          },
        },
```

and add `import { runImmudbMigrations } from './migrations/immudb-migrations.js';`.
`libs/immudb/src/index.ts`: append `export * from './migrations/immudb-migrations.js';`.

- [ ] **Step 4: Run the unit tests.** `npx vitest run --project immudb` — Expected: PASS.

- [ ] **Step 5: Run the int spec (Docker, sandbox off).**
      `INTEGRATION=1 npx vitest run --project immudb:int immudb-migrations` — Expected: PASS (5 tests). If
      `UPSERT` is refused with a message other than `access denied` (spec P7: `[INSERT UPDATE]`), keep the
      assertion on `kind: 'access-denied'` and check the message map in L-2a. Unverified (Docker was
      down at review): the error a losing concurrent `CreateUser`/`CreateDatabaseV2` returns; if the
      concurrent-runs test fails, add that exact message to `createdElsewhere` (never a broad match).

- [ ] **Step 6: Wider checks.** `npx biome check --write libs/immudb`, `bun run check` — Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add libs/immudb
git commit -m "feat(immudb): provision an insert-only user and run versioned SQL migrations" \
  -m "runImmudbMigrations creates the database and the SELECT/INSERT-only application user over gRPC
(ChangeSQLPrivileges), then applies NNN_name.sql files (CREATE ... IF NOT EXISTS only) with
checksummed bookkeeping in immudb_migrations; concurrent runners are safe. ImmudbModule migrates
at boot when IMMUDB_RUN_MIGRATIONS=true; runImmudbMigrationsCli serves src/migrate.ts."
```

### Task L-4: proof verification primitives with container-captured vectors

**Files:**

- Create: `libs/immudb/src/verification/bytes.ts`, `libs/immudb/src/verification/htree.ts`,
  `libs/immudb/src/verification/ahtree.ts`, `libs/immudb/src/verification/tx-header.ts`,
  `libs/immudb/src/verification/linear.ts`, `libs/immudb/src/verification/dual-proof.ts`,
  `libs/immudb/src/verification/entry-digest.ts`, `libs/immudb/scripts/capture-vectors.mjs`,
  `libs/immudb/test/vectors/immudb-1.11.2.json` (written by the script)
- Modify: `libs/immudb/THIRD_PARTY_NOTICES.md` (ported-code table rows)
- Test: `libs/immudb/src/verification/primitives.spec.ts`,
  `libs/immudb/src/verification/dual-proof.vectors.spec.ts`

**Interfaces:**

- Consumes: L-1 generated `TxHeader`, `DualProof`, `VerifiableTx` (types and `fromJSON`).
- Produces (internal to `libs/immudb`, used by L-5):

```ts
export function sha256(...parts: readonly Uint8Array[]): Uint8Array;
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean;
export function u16(n: number): Uint8Array;
export function u32(n: number): Uint8Array;
export function u64(n: bigint): Uint8Array; // two's complement for negatives
export function leafFor(digest: Uint8Array): Uint8Array;
export interface InclusionProofData {
  readonly leaf: number;
  readonly width: number;
  readonly terms: readonly Uint8Array[];
}
export function verifyHtreeInclusion(
  proof: InclusionProofData | null,
  digest: Uint8Array,
  root: Uint8Array,
): boolean;
export function verifyAhtreeInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean;
export function verifyAhtreeConsistency(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  iRoot: Uint8Array,
  jRoot: Uint8Array,
): boolean;
export function verifyAhtreeLastInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean;
export interface TxHeaderData {
  readonly id: bigint;
  readonly prevAlh: Uint8Array;
  readonly ts: bigint;
  readonly version: number;
  readonly metadata: { readonly truncatedTxId: bigint; readonly extra: Uint8Array } | null;
  readonly nEntries: number;
  readonly eh: Uint8Array;
  readonly blTxId: bigint;
  readonly blRoot: Uint8Array;
}
export function fromProtoTxHeader(header: TxHeader): TxHeaderData;
export function txHeaderAlh(header: TxHeaderData): Uint8Array;
export interface LinearProofData {
  readonly sourceTxId: bigint;
  readonly targetTxId: bigint;
  readonly terms: readonly Uint8Array[];
}
export interface LinearAdvanceProofData {
  readonly linearProofTerms: readonly Uint8Array[];
  readonly inclusionProofs: readonly (readonly Uint8Array[])[];
}
export function verifyLinearProof(
  proof: LinearProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean;
export function verifyLinearAdvanceProof(
  proof: LinearAdvanceProofData | null,
  startTxId: bigint,
  endTxId: bigint,
  endAlh: Uint8Array,
  treeRoot: Uint8Array,
  treeSize: bigint,
): boolean;
export interface DualProofData {
  readonly sourceTxHeader: TxHeaderData;
  readonly targetTxHeader: TxHeaderData;
  readonly inclusionProof: readonly Uint8Array[];
  readonly consistencyProof: readonly Uint8Array[];
  readonly targetBlTxAlh: Uint8Array;
  readonly lastInclusionProof: readonly Uint8Array[];
  readonly linearProof: LinearProofData | null;
  readonly linearAdvanceProof: LinearAdvanceProofData | null;
}
export function fromProtoDualProof(proof: DualProof | undefined): DualProofData | null;
export function verifyDualProof(
  proof: DualProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean;
export function entrySpecDigestFor(
  version: number,
): (key: Uint8Array, value: Uint8Array) => Uint8Array;
```

**Wave:** after L-1 (independent of L-2a/L-2b). Port **only** from immudb tag `v1.9DOM.1` (Apache-2.0):
`embedded/htree/htree.go` (`VerifyInclusion`), `embedded/ahtree/verification.go` (all six functions),
`embedded/store/verification.go` (`advanceLinearHash`, `VerifyLinearProof`, `VerifyLinearAdvanceProof`,
`VerifyDualProof`, `leafFor`, `EntrySpecDigest_v0/_v1`), `embedded/store/tx.go` (`TxHeader.innerHash`,
`TxHeader.Alh`), `embedded/store/tx_metadata.go` (`TxMetadata.Bytes`). These were verified identical to
`v1.11.2` (below the licence header) on 2026-11-09. The code below is that port; if a vector fails,
compare with the `v1.9DOM.1` source at `https://raw.githubusercontent.com/codenotary/immudb/v1.9DOM.1/<path>`.
`entrySpecDigestFor` covers SQL rows only (no KV metadata, exactly as `pkg/client/sql.go` `VerifyRow`).

- [ ] **Step 1: Capture the vectors (Docker, sandbox off).** `libs/immudb/scripts/capture-vectors.mjs`:

```js
// Captures proof vectors from a real immudb 1.11.2 for the verification unit specs. Run once (and
// again when the immudb version changes) after building the package:
//   bun run --filter @platform/immudb build && node libs/immudb/scripts/capture-vectors.mjs
// Uses only the generated client (dist), so it needs no Go toolchain and copies no immudb code.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentials, Metadata } from '@grpc/grpc-js';
import { GenericContainer, Wait } from 'testcontainers';
import {
  ImmutableState,
  ImmuServiceClient,
  OpenSessionRequest,
  SQLExecRequest,
  VerifiableSQLEntry,
  VerifiableSQLGetRequest,
  VerifiableTx,
  VerifiableTxRequest,
} from '../dist/generated/immudb/schema/schema.pb.js';

const IMAGE = 'codenotary/immudb:1.11.2';
const OUT = join(import.meta.dirname, '../test/vectors/immudb-1.11.2.json');

const container = await new GenericContainer(IMAGE)
  .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
  .withExposedPorts(3322, 9497)
  .withWaitStrategy(Wait.forHttp('/readyz', 9497))
  .start();
const client = new ImmuServiceClient(
  `${container.getHost()}:${container.getMappedPort(3322)}`,
  credentials.createInsecure(),
);
try {
  const call = (method, request, metadata = new Metadata()) =>
    new Promise((resolve, reject) =>
      client[method](request, metadata, (error, response) =>
        error ? reject(error) : resolve(response),
      ),
    );
  const { sessionID } = await call(
    'openSession',
    OpenSessionRequest.fromPartial({
      username: Buffer.from('immudb'),
      password: Buffer.from('immudb'),
      databaseName: 'defaultdb',
    }),
  );
  const md = () => {
    const metadata = new Metadata();
    metadata.set('sessionid', sessionID);
    return metadata;
  };
  const states = [];
  const snapshot = async () => {
    const state = await call('currentState', {}, md());
    states.push({ txId: state.txId, txHash: state.txHash.toString('base64') });
    return BigInt(state.txId);
  };
  const exec = async (sql) => {
    await call('sqlExec', SQLExecRequest.fromPartial({ sql }), md());
    return snapshot();
  };
  await snapshot();
  await exec('CREATE TABLE vec (id VARCHAR[36], amount INTEGER, note VARCHAR[16], PRIMARY KEY id)');
  const rowTx = {};
  for (let i = 1; i <= 8; i++) {
    rowTx[`row-${i}`] = await exec(
      `INSERT INTO vec (id, amount, note) VALUES ('row-${i}', ${i * 100 - 450}, 'n${i}')`,
    );
  }
  const finalState = ImmutableState.toJSON(await call('currentState', {}, md()));
  const target = BigInt(finalState.txId);
  // states[1] is the CREATE TABLE tx (>= 1). Never prove since tx 0: a fresh database reports tx 0,
  // and VerifiableTxById treats proveSinceTx 0 as "the tx itself" (pkg/database VerifiableTxByID).
  const first = BigInt(states[1].txId);
  const headerOnly = (vt) => ({
    ...vt,
    tx: vt.tx ? { ...vt.tx, entries: [], kvEntries: [], zEntries: [] } : undefined,
  });
  const dualProofs = [];
  for (const source of [target, target - 1n, target - 2n, target - 5n, first]) {
    const vt = await call(
      'verifiableTxById',
      VerifiableTxRequest.fromPartial({ tx: target.toString(), proveSinceTx: source.toString() }),
      md(),
    );
    dualProofs.push({
      sourceTxId: source.toString(),
      targetTxId: target.toString(),
      verifiableTx: VerifiableTx.toJSON(headerOnly(vt)),
    });
  }
  const sqlEntries = [];
  for (const proveSinceTx of [rowTx['row-2'], rowTx['row-3'], target]) {
    const entry = await call(
      'verifiableSqlGet',
      VerifiableSQLGetRequest.fromPartial({
        sqlGetRequest: { table: 'vec', pkValues: [{ value: { $case: 's', value: 'row-3' } }] },
        proveSinceTx: proveSinceTx.toString(),
      }),
      md(),
    );
    sqlEntries.push({
      table: 'vec',
      pk: ['row-3'],
      rowTxId: rowTx['row-3'].toString(),
      proveSinceTx: proveSinceTx.toString(),
      expectedRow: { id: 'row-3', amount: '-150', note: 'n3' },
      verifiableSqlEntry: VerifiableSQLEntry.toJSON({
        ...entry,
        verifiableTx: entry.verifiableTx ? headerOnly(entry.verifiableTx) : undefined,
      }),
    });
  }
  await mkdir(join(import.meta.dirname, '../test/vectors'), { recursive: true });
  await writeFile(
    OUT,
    `${JSON.stringify({ image: IMAGE, states, finalState, dualProofs, sqlEntries }, null, 2)}\n`,
  );
  console.info(`wrote ${OUT}: ${states.length} states, ${dualProofs.length} dual proofs`);
} finally {
  client.close();
  await container.stop();
}
```

Run: `bun run --filter @platform/immudb build && node libs/immudb/scripts/capture-vectors.mjs && npx biome format --write libs/immudb/test/vectors`
(Biome formats every `*.json` outside `generated`; without it `biome ci .` fails on the expanded arrays).
Expected: `wrote …/immudb-1.11.2.json: 10 states, 5 dual proofs` (one state before `CREATE TABLE`,
then one per statement: each `SQLExec` is one transaction, so the captured tx ids are consecutive). The vectors are data, not immudb code.

- [ ] **Step 2: Write the failing tests.** `libs/immudb/src/verification/primitives.spec.ts`
      (expected values computed independently with `node:crypto`):

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyAhtreeConsistency,
  verifyAhtreeInclusion,
  verifyAhtreeLastInclusion,
} from './ahtree.js';
import { equalBytes, leafFor, sha256, u64 } from './bytes.js';
import { entrySpecDigestFor } from './entry-digest.js';
import { verifyHtreeInclusion } from './htree.js';
import { verifyLinearProof } from './linear.js';
import { txHeaderAlh, type TxHeaderData } from './tx-header.js';

const h = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Uint8Array.from(part));
  return new Uint8Array(hash.digest());
};
const d = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('verification primitives', () => {
  it('encodes integers big-endian, negatives as two’s complement', () => {
    expect([...u64(1n)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...u64(-1n)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it('hashes leaves with prefix 0 and nodes with prefix 1', () => {
    expect(equalBytes(leafFor(d(7)), h([0], d(7)))).toBe(true);
    expect(equalBytes(sha256(d(1), d(2)), h(d(1), d(2)))).toBe(true);
  });

  it('verifies htree inclusion in a two-leaf tree and rejects the wrong side', () => {
    const l0 = h([0], d(1));
    const l1 = h([0], d(2));
    const root = h([1], l0, l1);
    expect(verifyHtreeInclusion({ leaf: 0, width: 2, terms: [l1] }, d(1), root)).toBe(true);
    expect(verifyHtreeInclusion({ leaf: 1, width: 2, terms: [l0] }, d(2), root)).toBe(true);
    expect(verifyHtreeInclusion({ leaf: 1, width: 2, terms: [l1] }, d(1), root)).toBe(false);
    expect(verifyHtreeInclusion(null, d(1), root)).toBe(false);
  });

  it('verifies ahtree inclusion, consistency and last inclusion for sizes 1..2', () => {
    const a = leafFor(d(1));
    const b = leafFor(d(2));
    const root2 = h([1], a, b);
    expect(verifyAhtreeInclusion([], 1n, 1n, a, a)).toBe(true);
    expect(verifyAhtreeInclusion([b], 1n, 2n, a, root2)).toBe(true);
    expect(verifyAhtreeInclusion([a], 2n, 2n, b, root2)).toBe(true);
    expect(verifyAhtreeInclusion([], 1n, 2n, a, root2)).toBe(false);
    expect(verifyAhtreeInclusion([b], 0n, 2n, a, root2)).toBe(false);
    expect(verifyAhtreeConsistency([], 2n, 2n, root2, root2)).toBe(true);
    expect(verifyAhtreeConsistency([a, b], 1n, 2n, a, root2)).toBe(true);
    expect(verifyAhtreeConsistency([a, b], 2n, 1n, a, root2)).toBe(false);
    expect(verifyAhtreeLastInclusion([a], 2n, b, root2)).toBe(true);
    expect(verifyAhtreeLastInclusion([a], 0n, b, root2)).toBe(false);
  });

  it('computes Alh = sha256(id ‖ prevAlh ‖ innerHash) for header versions 0 and 1', () => {
    const base: TxHeaderData = {
      id: 5n,
      prevAlh: d(9),
      ts: 1_794_182_400n,
      version: 1,
      metadata: null,
      nEntries: 2,
      eh: d(3),
      blTxId: 4n,
      blRoot: d(4),
    };
    const v1Inner = h(u64(base.ts), [0, 1], [0, 0], [0, 0, 0, 2], d(3), u64(4n), d(4));
    expect(equalBytes(txHeaderAlh(base), h(u64(5n), d(9), v1Inner))).toBe(true);
    const v0Inner = h(u64(base.ts), [0, 0], [0, 2], d(3), u64(4n), d(4));
    expect(equalBytes(txHeaderAlh({ ...base, version: 0 }), h(u64(5n), d(9), v0Inner))).toBe(true);
    const md = { truncatedTxId: 3n, extra: Uint8Array.from([7]) };
    const mdBytes = [0, ...u64(3n), 1, 0, 1, 7];
    const mdInner = h(
      u64(base.ts),
      [0, 1],
      [0, mdBytes.length],
      mdBytes,
      [0, 0, 0, 2],
      d(3),
      u64(4n),
      d(4),
    );
    expect(equalBytes(txHeaderAlh({ ...base, metadata: md }), h(u64(5n), d(9), mdInner))).toBe(
      true,
    );
    expect(() => txHeaderAlh({ ...base, version: 2 })).toThrow(/version 2/);
  });

  it('verifies a linear proof by advancing Alh with each inner hash', () => {
    const term = d(8);
    const target = h(u64(2n), d(1), term);
    const proof = { sourceTxId: 1n, targetTxId: 2n, terms: [d(1), term] };
    expect(verifyLinearProof(proof, 1n, 2n, d(1), target)).toBe(true);
    expect(verifyLinearProof(proof, 1n, 2n, d(2), target)).toBe(false);
    expect(verifyLinearProof({ ...proof, terms: [d(1)] }, 1n, 2n, d(1), target)).toBe(false);
  });

  it('digests SQL entries per tx version', () => {
    const key = Uint8Array.from([1, 2]);
    const value = Uint8Array.from([3]);
    expect(equalBytes(entrySpecDigestFor(0)(key, value), h(key, h(value)))).toBe(true);
    expect(equalBytes(entrySpecDigestFor(1)(key, value), h([0, 0], [0, 2], key, h(value)))).toBe(
      true,
    );
    expect(() => entrySpecDigestFor(9)).toThrow(/version 9/);
  });
});
```

`libs/immudb/src/verification/dual-proof.vectors.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerifiableTx } from '../generated/immudb/schema/schema.pb.js';
import { equalBytes } from './bytes.js';
import { type DualProofData, fromProtoDualProof, verifyDualProof } from './dual-proof.js';
import { txHeaderAlh } from './tx-header.js';

interface Vectors {
  states: { txId: string; txHash: string }[];
  dualProofs: { sourceTxId: string; targetTxId: string; verifiableTx: unknown }[];
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../test/vectors/immudb-1.11.2.json'), 'utf8'),
) as Vectors;
const hashOf = (txId: bigint): Uint8Array => {
  const state = vectors.states.find((s) => BigInt(s.txId) === txId);
  if (state === undefined) throw new Error(`no captured state for tx ${txId}`);
  return new Uint8Array(Buffer.from(state.txHash, 'base64'));
};

/** Every non-empty byte array of the proof, depth-first, with its path. */
function byteLeaves(
  value: unknown,
  path: string,
  out: [string, Uint8Array][] = [],
): [string, Uint8Array][] {
  if (value instanceof Uint8Array) {
    if (value.length > 0) out.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      byteLeaves(item, `${path}[${i}]`, out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      byteLeaves(item, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/** Whether VerifyDualProof reads the component at `path` for this pair (same branches as the Go code). */
function isRead(path: string, proof: DualProofData, source: bigint): boolean {
  const s = proof.sourceTxHeader;
  const t = proof.targetTxHeader;
  if (path.startsWith('inclusionProof')) return source < t.blTxId;
  if (path.startsWith('consistencyProof')) return s.blTxId > 0n;
  if (path.startsWith('lastInclusionProof') || path === 'targetBlTxAlh') return t.blTxId > 0n;
  if (path.startsWith('linearAdvanceProof')) {
    return source < t.blTxId ? source > s.blTxId + 1n : t.blTxId > s.blTxId + 1n;
  }
  return true; // headers (all bytes feed the Alh) and the linear proof
}

describe('VerifyDualProof against immudb 1.11.2 vectors', () => {
  const cases = vectors.dualProofs.map((v) => ({
    source: BigInt(v.sourceTxId),
    target: BigInt(v.targetTxId),
    raw: VerifiableTx.fromJSON(v.verifiableTx),
  }));

  it('captured at least one same-tx, one adjacent and one distant pair', () => {
    expect(cases.some((c) => c.source === c.target)).toBe(true);
    expect(cases.some((c) => c.source === c.target - 1n)).toBe(true);
    expect(cases.some((c) => c.source < c.target - 2n)).toBe(true);
  });

  it.each(vectors.dualProofs.map((v) => [v.sourceTxId, v.targetTxId]))(
    'oracle: Alh of the headers %s → %s equals the states the server reported',
    (source, target) => {
      const c = cases.find((x) => x.source === BigInt(source) && x.target === BigInt(target));
      const proof = fromProtoDualProof(c?.raw.dualProof);
      expect(proof).not.toBeNull();
      if (proof === null) return;
      expect(equalBytes(txHeaderAlh(proof.targetTxHeader), hashOf(BigInt(target)))).toBe(true);
      expect(equalBytes(txHeaderAlh(proof.sourceTxHeader), hashOf(BigInt(source)))).toBe(true);
    },
  );

  it('accepts every captured proof', () => {
    for (const c of cases) {
      const proof = fromProtoDualProof(c.raw.dualProof);
      expect(verifyDualProof(proof, c.source, c.target, hashOf(c.source), hashOf(c.target))).toBe(
        true,
      );
    }
  });

  it('rejects a flipped byte in every component the verifier reads', () => {
    for (const c of cases) {
      const proof = fromProtoDualProof(c.raw.dualProof);
      if (proof === null) throw new Error('missing dual proof');
      const leaves = byteLeaves(proof, '');
      expect(leaves.length).toBeGreaterThan(0);
      leaves.forEach(([path], index) => {
        if (!isRead(path, proof, c.source)) return;
        const tampered = structuredClone(proof);
        const leaf = byteLeaves(tampered, '')[index]?.[1];
        if (leaf === undefined) throw new Error(`lost leaf ${path}`);
        leaf[0] = (leaf[0] ?? 0) ^ 1;
        const ok = verifyDualProof(
          tampered,
          c.source,
          c.target,
          hashOf(c.source),
          hashOf(c.target),
        );
        expect.soft(ok, `${c.source}→${c.target} ${path}`).toBe(false);
      });
    }
  });

  it('rejects wrong ids, swapped direction, tx 0 and a missing proof', () => {
    const c = cases.find((x) => x.source < x.target - 2n);
    if (c === undefined) throw new Error('no distant pair');
    const proof = fromProtoDualProof(c.raw.dualProof);
    const ok = (s: bigint, t: bigint, p = proof) =>
      verifyDualProof(p, s, t, hashOf(c.source), hashOf(c.target));
    expect(ok(c.source + 1n, c.target)).toBe(false);
    expect(ok(c.target, c.source)).toBe(false);
    expect(verifyDualProof(proof, 0n, c.target, hashOf(c.source), hashOf(c.target))).toBe(false);
    expect(ok(c.source, c.target, null)).toBe(false);
    expect(verifyDualProof(proof, c.source, c.target, hashOf(c.target), hashOf(c.target))).toBe(
      false,
    );
  });
});
```

- [ ] **Step 3: Run them.** `npx vitest run --project immudb src/verification` — Expected: FAIL (modules
      `./bytes.js`, `./dual-proof.js`, … not found).

- [ ] **Step 4: Implement the port.** `libs/immudb/src/verification/bytes.ts`:

```ts
import { createHash } from 'node:crypto';

/** Prefixes of immudb's Merkle trees (htree and ahtree): leaf 0, inner node 1. */
export const LEAF_PREFIX = 0;
export const NODE_PREFIX = 1;

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u16(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n);
  return out;
}

export function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** 8 bytes big-endian; negative values as two's complement (Go `uint64(int64)`). */
export function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, n));
  return out;
}

/** `leafFor` (store/verification.go): an ahtree leaf over an Alh. */
export function leafFor(digest: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(LEAF_PREFIX), digest);
}

export function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(NODE_PREFIX), left, right);
}
```

`libs/immudb/src/verification/htree.ts`:

```ts
import { equalBytes, LEAF_PREFIX, node, sha256 } from './bytes.js';

export interface InclusionProofData {
  readonly leaf: number;
  readonly width: number;
  readonly terms: readonly Uint8Array[];
}

/** Port of htree.VerifyInclusion (immudb v1.9DOM.1 embedded/htree/htree.go). */
export function verifyHtreeInclusion(
  proof: InclusionProofData | null,
  digest: Uint8Array,
  root: Uint8Array,
): boolean {
  if (proof === null) return false;
  let calc = sha256(Uint8Array.of(LEAF_PREFIX), digest);
  let i = proof.leaf;
  let r = proof.width - 1;
  for (const term of proof.terms) {
    calc = i % 2 === 0 && i !== r ? node(calc, term) : node(term, calc);
    i = Math.trunc(i / 2);
    r = Math.trunc(r / 2);
  }
  return i === r && equalBytes(root, calc);
}
```

`libs/immudb/src/verification/ahtree.ts`:

```ts
import { equalBytes, node } from './bytes.js';

/** Ports of immudb v1.9DOM.1 embedded/ahtree/verification.go (tx ids are uint64 → bigint). */
export function evalAhtreeInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  leaf: Uint8Array,
): Uint8Array {
  let i1 = i - 1n;
  let j1 = j - 1n;
  let root = leaf;
  for (const h of proof) {
    root = i1 % 2n === 0n && i1 !== j1 ? node(root, h) : node(h, root);
    i1 >>= 1n;
    j1 >>= 1n;
  }
  return root;
}

export function verifyAhtreeInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean {
  if (i > j || i === 0n || (i < j && proof.length === 0)) return false;
  return equalBytes(root, evalAhtreeInclusion(proof, i, j, leaf));
}

export function evalAhtreeConsistency(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
): [Uint8Array, Uint8Array] {
  let fn = i - 1n;
  let sn = j - 1n;
  while (fn % 2n === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  const [first, ...rest] = proof;
  if (first === undefined) return [new Uint8Array(0), new Uint8Array(0)];
  let ciRoot = first;
  let cjRoot = first;
  for (const h of rest) {
    if (fn % 2n === 1n || fn === sn) {
      ciRoot = node(h, ciRoot);
      cjRoot = node(h, cjRoot);
      while (fn % 2n === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      cjRoot = node(cjRoot, h);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return [ciRoot, cjRoot];
}

export function verifyAhtreeConsistency(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  iRoot: Uint8Array,
  jRoot: Uint8Array,
): boolean {
  if (i > j || i === 0n || (i < j && proof.length === 0)) return false;
  if (i === j && proof.length === 0) return equalBytes(iRoot, jRoot);
  const [ciRoot, cjRoot] = evalAhtreeConsistency(proof, i, j);
  return equalBytes(iRoot, ciRoot) && equalBytes(jRoot, cjRoot);
}

export function evalAhtreeLastInclusion(
  proof: readonly Uint8Array[],
  leaf: Uint8Array,
): Uint8Array {
  let root = leaf;
  for (const h of proof) root = node(h, root);
  return root;
}

export function verifyAhtreeLastInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean {
  if (i === 0n) return false;
  return equalBytes(root, evalAhtreeLastInclusion(proof, leaf));
}
```

`libs/immudb/src/verification/tx-header.ts`:

```ts
import { ImmudbError } from '../errors/immudb.error.js';
import type { TxHeader } from '../generated/immudb/schema/schema.pb.js';
import { concat, sha256, u16, u32, u64 } from './bytes.js';

export interface TxHeaderData {
  readonly id: bigint;
  readonly prevAlh: Uint8Array;
  readonly ts: bigint;
  readonly version: number;
  readonly metadata: { readonly truncatedTxId: bigint; readonly extra: Uint8Array } | null;
  readonly nEntries: number;
  readonly eh: Uint8Array;
  readonly blTxId: bigint;
  readonly blRoot: Uint8Array;
}

/** `TxMetadataFromProto` + `TxMetadata.Bytes()`: attribute 0 truncatedTxId, 1 extra. */
function txMetadataBytes(metadata: TxHeaderData['metadata']): Uint8Array {
  if (metadata === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  if (metadata.truncatedTxId > 0n) parts.push(Uint8Array.of(0), u64(metadata.truncatedTxId));
  if (metadata.extra.length > 0) {
    parts.push(Uint8Array.of(1), u16(metadata.extra.length), metadata.extra);
  }
  return concat(parts);
}

export function fromProtoTxHeader(header: TxHeader): TxHeaderData {
  return {
    id: BigInt(header.id),
    prevAlh: new Uint8Array(header.prevAlh),
    ts: BigInt(header.ts),
    version: header.version,
    metadata:
      header.metadata === undefined
        ? null
        : {
            truncatedTxId: BigInt(header.metadata.truncatedTxID),
            extra: new Uint8Array(header.metadata.extra),
          },
    nEntries: header.nentries,
    eh: new Uint8Array(header.eH),
    blTxId: BigInt(header.blTxId),
    blRoot: new Uint8Array(header.blRoot),
  };
}

/** `TxHeader.innerHash` (embedded/store/tx.go). */
function innerHash(header: TxHeaderData): Uint8Array {
  const parts: Uint8Array[] = [u64(header.ts), u16(header.version)];
  switch (header.version) {
    case 0:
      parts.push(u16(header.nEntries));
      break;
    case 1: {
      const metadata = txMetadataBytes(header.metadata);
      parts.push(u16(metadata.length), metadata, u32(header.nEntries));
      break;
    }
    default:
      throw new ImmudbError(
        'verification-failed',
        `unsupported immudb tx header version ${header.version}`,
      );
  }
  parts.push(header.eh, u64(header.blTxId), header.blRoot);
  return sha256(...parts);
}

/** `TxHeader.Alh`: sha256(id ‖ prevAlh ‖ innerHash). */
export function txHeaderAlh(header: TxHeaderData): Uint8Array {
  return sha256(u64(header.id), header.prevAlh, innerHash(header));
}
```

`libs/immudb/src/verification/linear.ts`:

```ts
import { verifyAhtreeInclusion } from './ahtree.js';
import { equalBytes, leafFor, sha256, u64 } from './bytes.js';

export interface LinearProofData {
  readonly sourceTxId: bigint;
  readonly targetTxId: bigint;
  readonly terms: readonly Uint8Array[];
}

export interface LinearAdvanceProofData {
  readonly linearProofTerms: readonly Uint8Array[];
  readonly inclusionProofs: readonly (readonly Uint8Array[])[];
}

/** hash(txId ‖ alh ‖ innerHash). */
export function advanceLinearHash(alh: Uint8Array, txId: bigint, term: Uint8Array): Uint8Array {
  return sha256(u64(txId), alh, term);
}

export function verifyLinearProof(
  proof: LinearProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean {
  if (proof === null || proof.sourceTxId !== sourceTxId || proof.targetTxId !== targetTxId) {
    return false;
  }
  const [first, ...rest] = proof.terms;
  if (
    proof.sourceTxId === 0n ||
    proof.sourceTxId > proof.targetTxId ||
    first === undefined ||
    !equalBytes(sourceAlh, first)
  ) {
    return false;
  }
  if (BigInt(proof.terms.length) !== targetTxId - sourceTxId + 1n) return false;
  let calculated = first;
  rest.forEach((term, i) => {
    calculated = advanceLinearHash(calculated, proof.sourceTxId + BigInt(i + 1), term);
  });
  return equalBytes(targetAlh, calculated);
}

export function verifyLinearAdvanceProof(
  proof: LinearAdvanceProofData | null,
  startTxId: bigint,
  endTxId: bigint,
  endAlh: Uint8Array,
  treeRoot: Uint8Array,
  treeSize: bigint,
): boolean {
  if (endTxId < startTxId) return false;
  if (endTxId <= startTxId + 1n) return true;
  if (
    proof === null ||
    BigInt(proof.linearProofTerms.length) !== endTxId - startTxId ||
    BigInt(proof.inclusionProofs.length) !== endTxId - startTxId - 1n
  ) {
    return false;
  }
  let calculated = proof.linearProofTerms[0];
  for (let txId = startTxId + 1n; txId < endTxId; txId++) {
    const k = Number(txId - startTxId);
    const inclusion = proof.inclusionProofs[k - 1];
    const term = proof.linearProofTerms[k];
    if (calculated === undefined || inclusion === undefined || term === undefined) return false;
    if (!verifyAhtreeInclusion(inclusion, txId, treeSize, leafFor(calculated), treeRoot)) {
      return false;
    }
    calculated = advanceLinearHash(calculated, txId + 1n, term);
  }
  return calculated !== undefined && equalBytes(calculated, endAlh);
}
```

`libs/immudb/src/verification/dual-proof.ts`:

```ts
import type { DualProof } from '../generated/immudb/schema/schema.pb.js';
import {
  verifyAhtreeConsistency,
  verifyAhtreeInclusion,
  verifyAhtreeLastInclusion,
} from './ahtree.js';
import { equalBytes, leafFor } from './bytes.js';
import {
  type LinearAdvanceProofData,
  type LinearProofData,
  verifyLinearAdvanceProof,
  verifyLinearProof,
} from './linear.js';
import { fromProtoTxHeader, type TxHeaderData, txHeaderAlh } from './tx-header.js';

export interface DualProofData {
  readonly sourceTxHeader: TxHeaderData;
  readonly targetTxHeader: TxHeaderData;
  readonly inclusionProof: readonly Uint8Array[];
  readonly consistencyProof: readonly Uint8Array[];
  readonly targetBlTxAlh: Uint8Array;
  readonly lastInclusionProof: readonly Uint8Array[];
  readonly linearProof: LinearProofData | null;
  readonly linearAdvanceProof: LinearAdvanceProofData | null;
}

const bytes = (list: readonly Uint8Array[]): Uint8Array[] => list.map((b) => new Uint8Array(b));

export function fromProtoDualProof(proof: DualProof | undefined): DualProofData | null {
  if (proof?.sourceTxHeader === undefined || proof.targetTxHeader === undefined) return null;
  const linear = proof.linearProof;
  const advance = proof.LinearAdvanceProof;
  return {
    sourceTxHeader: fromProtoTxHeader(proof.sourceTxHeader),
    targetTxHeader: fromProtoTxHeader(proof.targetTxHeader),
    inclusionProof: bytes(proof.inclusionProof),
    consistencyProof: bytes(proof.consistencyProof),
    targetBlTxAlh: new Uint8Array(proof.targetBlTxAlh),
    lastInclusionProof: bytes(proof.lastInclusionProof),
    linearProof:
      linear === undefined
        ? null
        : {
            sourceTxId: BigInt(linear.sourceTxId),
            targetTxId: BigInt(linear.TargetTxId),
            terms: bytes(linear.terms),
          },
    linearAdvanceProof:
      advance === undefined
        ? null
        : {
            linearProofTerms: bytes(advance.linearProofTerms),
            inclusionProofs: advance.inclusionProofs.map((p) => bytes(p.terms)),
          },
  };
}

/** Port of store.VerifyDualProof (immudb v1.9DOM.1 embedded/store/verification.go). */
export function verifyDualProof(
  proof: DualProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean {
  if (
    proof === null ||
    proof.sourceTxHeader.id !== sourceTxId ||
    proof.targetTxHeader.id !== targetTxId
  ) {
    return false;
  }
  const source = proof.sourceTxHeader;
  const target = proof.targetTxHeader;
  if (source.id === 0n || source.id > target.id) return false;
  if (!equalBytes(sourceAlh, txHeaderAlh(source))) return false;
  if (!equalBytes(targetAlh, txHeaderAlh(target))) return false;

  if (
    sourceTxId < target.blTxId &&
    !verifyAhtreeInclusion(
      proof.inclusionProof,
      sourceTxId,
      target.blTxId,
      leafFor(sourceAlh),
      target.blRoot,
    )
  ) {
    return false;
  }
  if (
    source.blTxId > 0n &&
    !verifyAhtreeConsistency(
      proof.consistencyProof,
      source.blTxId,
      target.blTxId,
      source.blRoot,
      target.blRoot,
    )
  ) {
    return false;
  }
  if (
    target.blTxId > 0n &&
    !verifyAhtreeLastInclusion(
      proof.lastInclusionProof,
      target.blTxId,
      leafFor(proof.targetBlTxAlh),
      target.blRoot,
    )
  ) {
    return false;
  }
  if (sourceTxId < target.blTxId) {
    return (
      verifyLinearProof(
        proof.linearProof,
        target.blTxId,
        targetTxId,
        proof.targetBlTxAlh,
        targetAlh,
      ) &&
      verifyLinearAdvanceProof(
        proof.linearAdvanceProof,
        source.blTxId,
        sourceTxId,
        sourceAlh,
        target.blRoot,
        target.blTxId,
      )
    );
  }
  return (
    verifyLinearProof(proof.linearProof, sourceTxId, targetTxId, sourceAlh, targetAlh) &&
    verifyLinearAdvanceProof(
      proof.linearAdvanceProof,
      source.blTxId,
      target.blTxId,
      proof.targetBlTxAlh,
      target.blRoot,
      target.blTxId,
    )
  );
}
```

`libs/immudb/src/verification/entry-digest.ts`:

```ts
import { ImmudbError } from '../errors/immudb.error.js';
import { sha256, u16 } from './bytes.js';

/**
 * `EntrySpecDigest_v0/_v1` for SQL rows, which carry no KV metadata (`pkg/client/sql.go` VerifyRow
 * builds the EntrySpec from key and value only).
 */
export function entrySpecDigestFor(
  version: number,
): (key: Uint8Array, value: Uint8Array) => Uint8Array {
  switch (version) {
    case 0:
      return (key, value) => sha256(key, sha256(value));
    case 1:
      return (key, value) => sha256(u16(0), u16(key.length), key, sha256(value));
    default:
      throw new ImmudbError('verification-failed', `unsupported immudb tx version ${version}`);
  }
}
```

- [ ] **Step 5: Run the tests.** `npx vitest run --project immudb src/verification` — Expected: PASS. A
      failing oracle test means the header decoding is wrong (fix `fromProtoTxHeader`/`innerHash`); a
      failing flip means a component is not checked (compare with the Go branch named in `isRead`).

- [ ] **Step 6: Notices.** Append to the table in `libs/immudb/THIRD_PARTY_NOTICES.md`:

```markdown
| `verifyHtreeInclusion` (`src/verification/htree.ts`) | `embedded/htree/htree.go` `VerifyInclusion` |
| `evalAhtreeInclusion`, `verifyAhtreeInclusion`, `evalAhtreeConsistency`, `verifyAhtreeConsistency`, `evalAhtreeLastInclusion`, `verifyAhtreeLastInclusion` (`src/verification/ahtree.ts`) | `embedded/ahtree/verification.go` |
| `leafFor`, `advanceLinearHash`, `verifyLinearProof`, `verifyLinearAdvanceProof`, `verifyDualProof`, `entrySpecDigestFor` (`src/verification/*.ts`) | `embedded/store/verification.go` |
| `txHeaderAlh` + inner hash, tx metadata bytes (`src/verification/tx-header.ts`) | `embedded/store/tx.go` `TxHeader.innerHash`/`Alh`, `embedded/store/tx_metadata.go` `TxMetadata.Bytes` |
```

- [ ] **Step 7: Wider checks.** `npx biome check --write libs/immudb/src/verification libs/immudb/scripts libs/immudb/test/vectors`,
      `npx prettier --write libs/immudb/THIRD_PARTY_NOTICES.md`, `bun run check` — Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add libs/immudb
git commit -m "feat(immudb): port immudb proof verification with captured server vectors" \
  -m "TypeScript port (from Apache-2.0 immudb v1.9DOM.1) of htree/ahtree inclusion and consistency,
linear and linear-advance proofs, dual proofs, tx header Alh and SQL entry digests. Vectors
captured from codenotary/immudb:1.11.2 by a committed script; every proof component read by the
verifier is byte-flipped in the spec."
```

### Task L-5: SQL row verification, state signatures, `verifyConsistency` and `verifiedRow`

**Files:**

- Create: `libs/immudb/src/verification/sql-row.ts`, `libs/immudb/src/verification/state-signature.ts`
- Modify: `libs/immudb/src/client/immudb.client.ts`, `libs/immudb/src/client/grpc-immudb.client.ts`,
  `libs/immudb/src/immudb.module.ts` (pass the signing key), `libs/immudb/src/testing/recording-immudb.client.ts`,
  `libs/immudb/THIRD_PARTY_NOTICES.md`
- Test: `libs/immudb/src/verification/sql-row.spec.ts`, `libs/immudb/src/verification/state-signature.spec.ts`,
  `libs/immudb/test/immudb-verification.int-spec.ts`

**Interfaces:**

- Consumes: L-4 primitives; L-2b `ImmudbSession.verifiableTxById/verifiableSqlGet`, `ImmudbSessionPool`.
- Produces (spec contract, now complete):

```ts
export abstract class ImmudbClient {
  // …readWrite, readOnly, currentState (L-2b)
  /** Dual proof from `trusted` to `target` (and the target's signature when a key is pinned). */
  abstract verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void>;
  /** Row by primary key, proven included in a tx consistent with `trusted`; `state` is the new trusted state. */
  abstract verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }>;
}
export class GrpcImmudbClient extends ImmudbClient {
  constructor(pool: ImmudbSessionPool, options?: { serverSigningPublicKeyPem?: string });
}
// internal
export function encodeKeyValue(value: ImmudbValue, type: string, maxLen: number): Uint8Array;
export function decodeRowValue(
  encoded: Uint8Array,
  colTypes: Readonly<Record<number, string>>,
  colNames: Readonly<Record<number, string>>,
  maxColId: number,
): ImmudbRow;
export function verifySqlEntry(
  entry: VerifiableSQLEntry,
  pk: readonly ImmudbValue[],
  trusted: ImmudbState,
  verifySignature?: (state: ImmudbState) => boolean,
): { row: ImmudbRow; txId: bigint; state: ImmudbState };
export function stateSignedBytes(state: ImmudbState): Uint8Array;
export function verifyStateSignature(state: ImmudbState, publicKeyPem: string): boolean;
// @platform/immudb/testing: RecordedStatement.kind gains 'verify'
```

Every failure throws `ImmudbError` with kind `verification-failed`. Supported primary-key types: `VARCHAR`,
`INTEGER` (`EncodeRawValueAsKey`); decoded column types: `VARCHAR`, `INTEGER`, `BOOLEAN`, `BLOB`,
`TIMESTAMP`, `UUID` (`DecodeValue`; `v1.11.2` only adds JSON and NULL handling to it, unused here).

**Wave:** after L-2b and L-4. Port sources (`v1.9DOM.1`, Apache-2.0): `pkg/client/sql.go` (`VerifyRow`,
`decodeRow`), `embedded/sql/catalog.go` (`EncodeRawValueAsKey`, `DecodeValue`, `MapKey`, `EncodeID`),
`embedded/sql/stmt.go` (`RowPrefix = "R."`, `PKIndexID = 0`), `pkg/api/schema/state.go` (`ToBytes`,
`CheckSignature`), `pkg/signer/ecdsa.go` (`Verify`: ECDSA P-256 over sha256, ASN.1 DER).

- [ ] **Step 1: Write the failing unit tests.** `libs/immudb/src/verification/sql-row.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerifiableSQLEntry } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbState } from '../immudb.types.js';
import { decodeRowValue, encodeKeyValue, verifySqlEntry } from './sql-row.js';

interface Vectors {
  states: { txId: string; txHash: string }[];
  sqlEntries: {
    pk: string[];
    rowTxId: string;
    proveSinceTx: string;
    expectedRow: { id: string; amount: string; note: string };
    verifiableSqlEntry: unknown;
  }[];
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../test/vectors/immudb-1.11.2.json'), 'utf8'),
) as Vectors;
const stateAt = (txId: string): ImmudbState => {
  const state = vectors.states.find((s) => s.txId === txId);
  if (state === undefined) throw new Error(`no captured state for tx ${txId}`);
  return {
    database: 'defaultdb',
    txId: BigInt(txId),
    txHash: new Uint8Array(Buffer.from(state.txHash, 'base64')),
    signature: null,
  };
};

describe('SQL row encoding', () => {
  it('encodes VARCHAR, INTEGER and NULL primary keys like EncodeRawValueAsKey', () => {
    expect([...encodeKeyValue('ab', 'VARCHAR', 4)]).toEqual([0x80, 97, 98, 0, 0, 0, 0, 0, 2]);
    expect([...encodeKeyValue(-1n, 'INTEGER', 8)]).toEqual([
      0x80, 0x7f, 255, 255, 255, 255, 255, 255, 255,
    ]);
    expect([...encodeKeyValue(1n, 'INTEGER', 8)]).toEqual([0x80, 0x80, 0, 0, 0, 0, 0, 0, 1]);
    expect([...encodeKeyValue(null, 'VARCHAR', 4)]).toEqual([0x20]);
    expect(() => encodeKeyValue('abcde', 'VARCHAR', 4)).toThrow(/longer/);
    expect(() => encodeKeyValue(true, 'BOOLEAN', 1)).toThrow(/unsupported/);
  });

  it('decodes a row value and skips dropped columns', () => {
    const value = Uint8Array.from([
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      2,
      104,
      105, // col 1 VARCHAR "hi"
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      8,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      254, // col 2 INTEGER -2
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      1,
      1, // col 3 dropped (not in colTypes, <= maxColId)
    ]);
    expect(
      decodeRowValue(value, { 1: 'VARCHAR', 2: 'INTEGER' }, { 1: 'id', 2: 'amount' }, 3),
    ).toEqual({ id: 'hi', amount: -2n });
    expect(() =>
      decodeRowValue(value, { 1: 'VARCHAR', 2: 'INTEGER' }, { 1: 'id', 2: 'amount' }, 2),
    ).toThrow(/corrupted/);
    expect(() => decodeRowValue(value.subarray(0, 10), {}, {}, 3)).toThrow(/corrupted/);
  });
});

describe('verifySqlEntry against immudb 1.11.2 vectors', () => {
  it.each(vectors.sqlEntries.map((v) => [v.proveSinceTx, v.rowTxId, v] as const))(
    'verifies row-3 with a trusted state at tx %s (row tx %s)',
    (proveSinceTx, rowTxId, v) => {
      const entry = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
      const result = verifySqlEntry(entry, v.pk, stateAt(proveSinceTx));
      expect(result.row).toEqual({ id: 'row-3', amount: -150n, note: 'n3' });
      expect(result.txId).toBe(BigInt(rowTxId));
      const newest = BigInt(proveSinceTx) > BigInt(rowTxId) ? proveSinceTx : rowTxId;
      expect(result.state.txId).toBe(BigInt(newest));
      expect(Buffer.from(result.state.txHash).toString('base64')).toBe(
        vectors.states.find((s) => s.txId === newest)?.txHash,
      );
    },
  );

  it('rejects a tampered value, another key and a wrong trusted hash', () => {
    const v = vectors.sqlEntries[0];
    if (v === undefined) throw new Error('no SQL vectors');
    const trusted = stateAt(v.proveSinceTx);
    const tampered = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
    const value = tampered.sqlEntry?.value;
    if (value === undefined) throw new Error('no value');
    value[value.length - 1] = (value[value.length - 1] ?? 0) ^ 1;
    expect(() => verifySqlEntry(tampered, v.pk, trusted)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
    const entry = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
    expect(() => verifySqlEntry(entry, ['row-4'], trusted)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
    const wrongHash = { ...trusted, txHash: new Uint8Array(32) };
    expect(() => verifySqlEntry(entry, v.pk, wrongHash)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
  });
});
```

`libs/immudb/src/verification/state-signature.spec.ts`:

```ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ImmudbState } from '../immudb.types.js';
import { stateSignedBytes, verifyStateSignature } from './state-signature.js';

const state: ImmudbState = {
  database: 'ab',
  txId: 1n,
  txHash: new Uint8Array(32).fill(1),
  signature: null,
};

describe('state signatures', () => {
  it('serialises like ImmutableState.ToBytes', () => {
    expect([...stateSignedBytes(state)]).toEqual([
      0,
      0,
      0,
      2,
      97,
      98,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      ...new Uint8Array(32).fill(1),
    ]);
  });

  it('verifies an ECDSA P-256 DER signature and rejects changes, other keys and no signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signature = new Uint8Array(
      sign('sha256', stateSignedBytes(state), { key: privateKey, dsaEncoding: 'der' }),
    );
    const signed = { ...state, signature };
    expect(verifyStateSignature(signed, pem)).toBe(true);
    expect(verifyStateSignature({ ...signed, txId: 2n }, pem)).toBe(false);
    expect(
      verifyStateSignature(signed, other.export({ type: 'spki', format: 'pem' }).toString()),
    ).toBe(false);
    expect(verifyStateSignature(state, pem)).toBe(false);
    expect(verifyStateSignature(signed, 'not a key')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project immudb src/verification` — Expected: FAIL
      (`./sql-row.js`, `./state-signature.js` not found).

- [ ] **Step 3: Implement.** `libs/immudb/src/verification/state-signature.ts`:

```ts
import { verify } from 'node:crypto';
import type { ImmudbState } from '../immudb.types.js';
import { concat, u32, u64 } from './bytes.js';

/** `ImmutableState.ToBytes` (pkg/api/schema/state.go): u32 len(db) ‖ db ‖ u64 txId ‖ txHash. */
export function stateSignedBytes(state: ImmudbState): Uint8Array {
  const db = new TextEncoder().encode(state.database);
  return concat([u32(db.length), db, u64(state.txId), state.txHash]);
}

/** ECDSA P-256 over sha256(stateSignedBytes), ASN.1 DER (pkg/signer/ecdsa.go `Verify`). */
export function verifyStateSignature(state: ImmudbState, publicKeyPem: string): boolean {
  if (state.signature === null) return false;
  try {
    return verify(
      'sha256',
      stateSignedBytes(state),
      { key: publicKeyPem, dsaEncoding: 'der' },
      state.signature,
    );
  } catch {
    return false;
  }
}
```

`libs/immudb/src/verification/sql-row.ts`:

```ts
import { ImmudbError } from '../errors/immudb.error.js';
import type { VerifiableSQLEntry } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbRow, ImmudbState, ImmudbValue } from '../immudb.types.js';
import { concat, u32, u64 } from './bytes.js';
import { fromProtoDualProof, verifyDualProof } from './dual-proof.js';
import { entrySpecDigestFor } from './entry-digest.js';
import { verifyHtreeInclusion } from './htree.js';
import { txHeaderAlh } from './tx-header.js';

/** pkg/client/sql.go `SQLPrefix`; embedded/sql/stmt.go `RowPrefix`, `PKIndexID`. */
const SQL_PREFIX = 2;
const ROW_PREFIX = new TextEncoder().encode('R.');
const PK_INDEX_ID = 0;
const KEY_NULL = 0x20;
const KEY_NOT_NULL = 0x80;

function fail(message: string): never {
  throw new ImmudbError('verification-failed', message);
}

/** `EncodeRawValueAsKey` (embedded/sql/catalog.go) for VARCHAR and INTEGER keys. */
export function encodeKeyValue(value: ImmudbValue, type: string, maxLen: number): Uint8Array {
  if (value === null) return Uint8Array.of(KEY_NULL);
  switch (type) {
    case 'VARCHAR': {
      if (typeof value !== 'string') fail('a VARCHAR primary key needs a string');
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > maxLen) fail('primary key value is longer than its column');
      const out = new Uint8Array(1 + maxLen + 4);
      out[0] = KEY_NOT_NULL;
      out.set(bytes, 1);
      out.set(u32(bytes.length), 1 + maxLen);
      return out;
    }
    case 'INTEGER': {
      if (typeof value !== 'bigint' || maxLen !== 8) fail('an INTEGER primary key needs a bigint');
      const out = concat([Uint8Array.of(KEY_NOT_NULL), u64(value)]);
      out[1] = (out[1] ?? 0) ^ 0x80; // lexical order of signed values
      return out;
    }
    default:
      return fail(`unsupported primary key type ${type}`);
  }
}

function decodeValue(raw: Uint8Array, type: string): ImmudbValue {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  switch (type) {
    case 'VARCHAR':
      return new TextDecoder().decode(raw);
    case 'INTEGER':
      return raw.length === 8 ? view.getBigInt64(0) : fail('corrupted INTEGER value');
    case 'BOOLEAN':
      return raw.length === 1 ? raw[0] === 1 : fail('corrupted BOOLEAN value');
    case 'BLOB':
      return new Uint8Array(raw);
    case 'TIMESTAMP':
      return raw.length === 8
        ? new Date(Number(view.getBigInt64(0) / 1_000n))
        : fail('corrupted TIMESTAMP value');
    case 'UUID': {
      if (raw.length !== 16) fail('corrupted UUID value');
      const hex = Buffer.from(raw).toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    default:
      return fail(`unsupported column type ${type}`);
  }
}

/** `decodeRow` (pkg/client/sql.go): u32 count, then (u32 colId, u32 length, value) per column. */
export function decodeRowValue(
  encoded: Uint8Array,
  colTypes: Readonly<Record<number, string>>,
  colNames: Readonly<Record<number, string>>,
  maxColId: number,
): ImmudbRow {
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  let offset = 0;
  const take = (n: number): void => {
    if (offset + n > encoded.length) fail('corrupted row value');
  };
  take(4);
  const count = view.getUint32(offset);
  offset += 4;
  const row: ImmudbRow = {};
  for (let i = 0; i < count; i++) {
    take(8);
    const colId = view.getUint32(offset);
    const length = view.getUint32(offset + 4);
    offset += 8;
    take(length);
    const raw = encoded.subarray(offset, offset + length);
    offset += length;
    const type = colTypes[colId];
    if (type === undefined) {
      if (colId > maxColId) fail('corrupted row value: unknown column');
      continue; // a dropped column
    }
    row[colNames[colId] ?? fail('corrupted row value: unnamed column')] = decodeValue(raw, type);
  }
  return row;
}

/** Port of `immuClient.VerifyRow` (pkg/client/sql.go), returning the proven row instead of comparing. */
export function verifySqlEntry(
  entry: VerifiableSQLEntry,
  pk: readonly ImmudbValue[],
  trusted: ImmudbState,
  verifySignature?: (state: ImmudbState) => boolean,
): { row: ImmudbRow; txId: bigint; state: ImmudbState } {
  const sqlEntry = entry.sqlEntry ?? fail('the server sent no SQL entry');
  const verifiableTx = entry.verifiableTx ?? fail('the server sent no verifiable tx');
  const header = verifiableTx.tx?.header ?? fail('the server sent no tx header');
  const proof = fromProtoDualProof(verifiableTx.dualProof) ?? fail('the server sent no dual proof');
  if (pk.length === 0 || entry.PKIDs.length !== pk.length) fail('primary key arity mismatch');

  const keyParts = pk.map((value, i) => {
    const id = entry.PKIDs[i] ?? fail('missing primary key column');
    const type = entry.ColTypesById[id] ?? fail('missing primary key type');
    const maxLen = entry.ColLenById[id] ?? fail('missing primary key length');
    return encodeKeyValue(value, type, maxLen);
  });
  const key = concat([
    Uint8Array.of(SQL_PREFIX),
    ROW_PREFIX,
    u32(entry.DatabaseId),
    u32(entry.TableId),
    u32(PK_INDEX_ID),
    ...keyParts,
  ]);
  const value = new Uint8Array(sqlEntry.value);
  const row = decodeRowValue(value, entry.ColTypesById, entry.ColNamesById, entry.MaxColId);

  const rowTx = BigInt(sqlEntry.tx);
  const forward = trusted.txId <= rowTx;
  const eh = forward ? proof.targetTxHeader.eh : proof.sourceTxHeader.eh;
  const sourceId = forward ? trusted.txId : rowTx;
  const sourceAlh = forward ? trusted.txHash : txHeaderAlh(proof.sourceTxHeader);
  const targetId = forward ? rowTx : trusted.txId;
  const targetAlh = forward ? txHeaderAlh(proof.targetTxHeader) : trusted.txHash;

  const inclusion = entry.inclusionProof;
  const included = verifyHtreeInclusion(
    inclusion === undefined
      ? null
      : {
          leaf: inclusion.leaf,
          width: inclusion.width,
          terms: inclusion.terms.map((term) => new Uint8Array(term)),
        },
    entrySpecDigestFor(header.version)(key, value),
    eh,
  );
  if (!included) fail(`row is not included in tx ${rowTx}`);
  if (trusted.txId > 0n && !verifyDualProof(proof, sourceId, targetId, sourceAlh, targetAlh)) {
    fail(`no valid dual proof between tx ${sourceId} and tx ${targetId}`);
  }
  const signature = verifiableTx.signature?.signature;
  const state: ImmudbState = {
    database: trusted.database,
    txId: targetId,
    txHash: targetAlh,
    signature: signature !== undefined && signature.length > 0 ? new Uint8Array(signature) : null,
  };
  if (verifySignature !== undefined && !verifySignature(state)) {
    fail(`state signature of tx ${targetId} does not verify`);
  }
  return { row, txId: rowTx, state };
}
```

`libs/immudb/src/client/immudb.client.ts`: add to the abstract class (and import `ImmudbValue`):

```ts
  /** Dual proof from `trusted` to `target` (and the target's signature when a key is pinned). */
  abstract verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void>;

  /** Row by primary key, proven included in a tx consistent with `trusted`. */
  abstract verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }>;
```

`libs/immudb/src/client/grpc-immudb.client.ts`: change the constructor and add the two methods (imports:
`equalBytes` from `../verification/bytes.js`, `fromProtoDualProof`, `verifyDualProof` from
`../verification/dual-proof.js`, `verifySqlEntry` from `../verification/sql-row.js`,
`verifyStateSignature` from `../verification/state-signature.js`):

```ts
  constructor(
    private readonly pool: ImmudbSessionPool,
    private readonly options: { serverSigningPublicKeyPem?: string } = {},
  ) {
    super();
  }

  override async verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void> {
    const failed = (message: string): never => {
      throw new ImmudbError('verification-failed', message);
    };
    if (trusted.database !== target.database) failed('states of different databases');
    if (trusted.txId > target.txId) {
      failed(`trusted tx ${trusted.txId} is newer than target tx ${target.txId}`);
    }
    const key = this.options.serverSigningPublicKeyPem;
    if (key !== undefined && !verifyStateSignature(target, key)) {
      failed(`state signature of tx ${target.txId} does not verify`);
    }
    if (trusted.txId === 0n) return;
    if (trusted.txId === target.txId) {
      if (!equalBytes(trusted.txHash, target.txHash)) failed(`tx ${target.txId} hash changed`);
      return;
    }
    const proven = await this.pool.use((session) =>
      mapped(session.verifiableTxById(target.txId, trusted.txId)),
    );
    const proof = fromProtoDualProof(proven.dualProof);
    if (!verifyDualProof(proof, trusted.txId, target.txId, trusted.txHash, target.txHash)) {
      failed(`no valid consistency proof from tx ${trusted.txId} to tx ${target.txId}`);
    }
  }

  override async verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }> {
    // A trusted state the server has not reached means a rolled-back or forked server: fail closed
    // as verification (the server itself would answer with an unmapped "lower than" error).
    const current = await this.currentState();
    if (trusted.txId > current.txId) {
      throw new ImmudbError(
        'verification-failed',
        `trusted tx ${trusted.txId} is ahead of the server (tx ${current.txId})`,
      );
    }
    const entry = await this.pool.use((session) =>
      mapped(session.verifiableSqlGet(table, pk, trusted.txId)),
    );
    const key = this.options.serverSigningPublicKeyPem;
    return verifySqlEntry(
      entry,
      pk,
      trusted,
      key === undefined ? undefined : (state) => verifyStateSignature(state, key),
    );
  }
```

`libs/immudb/src/immudb.module.ts`: the `ImmudbClient` provider becomes

```ts
        {
          provide: ImmudbClient,
          inject: [ImmudbSessionPool, immudbConfig.KEY],
          useFactory: (pool: ImmudbSessionPool, cfg: ImmudbConfig): ImmudbClient =>
            new GrpcImmudbClient(pool, { serverSigningPublicKeyPem: cfg.serverSigningPublicKeyPem }),
        },
```

`libs/immudb/src/testing/recording-immudb.client.ts`: `RecordedStatement.kind` becomes
`'exec' | 'query' | 'verify'`; add (import `ImmudbError` from `../errors/immudb.error.js`):

```ts
  override async verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void> {
    const statement = {
      mode: 'readOnly',
      kind: 'verify',
      sql: 'verifyConsistency',
      params: { trustedTxId: trusted.txId, targetTxId: target.txId },
    } as const;
    this.statements.push(statement);
    this.respond(statement);
  }

  /** Answers with the first row `respond` returns for `verifiedRow <table>` (params `pk0`, `pk1`, …). */
  override async verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }> {
    const statement = {
      mode: 'readOnly',
      kind: 'verify',
      sql: `verifiedRow ${table}`,
      params: Object.fromEntries(pk.map((value, i) => [`pk${i}`, value])),
    } as const;
    this.statements.push(statement);
    const [row] = this.respond(statement);
    if (row === undefined) throw new ImmudbError('verification-failed', `no scripted row in ${table}`);
    return { row, txId: trusted.txId, state: trusted };
  }
```

- [ ] **Step 4: Run the unit tests.** `npx vitest run --project immudb` — Expected: PASS.

- [ ] **Step 5: Write and run the int spec (Docker, sandbox off).**
      `libs/immudb/test/immudb-verification.int-spec.ts`:

```ts
import { generateKeyPairSync } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImmudbGrpcClient } from '../src/client/create-immudb-grpc-client.js';
import { GrpcImmudbClient } from '../src/client/grpc-immudb.client.js';
import { ImmudbSession } from '../src/client/immudb-session.js';
import { ImmudbSessionPool } from '../src/client/session-pool.js';
import type { ImmuServiceClient } from '../src/generated/immudb/schema/schema.pb.js';
import type { ImmudbState } from '../src/immudb.types.js';
import { IMMUDB_TEST_IMAGE } from '../src/index.js';

const ADMIN = { username: 'immudb', password: 'immudb', database: 'defaultdb' } as const;

async function start(signingKeyPem?: string): Promise<StartedTestContainer> {
  let container = new GenericContainer(IMMUDB_TEST_IMAGE)
    .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
    .withExposedPorts(3322, 9497)
    .withWaitStrategy(Wait.forHttp('/readyz', 9497));
  if (signingKeyPem !== undefined) {
    // SEC1 "EC PRIVATE KEY" PEM, as pkg/signer/ecdsa.go NewSigner parses it.
    container = container
      .withCopyContentToContainer([
        { content: signingKeyPem, target: '/keys/signing.key', mode: 0o644 },
      ])
      .withCommand(['--signingKey=/keys/signing.key']);
  }
  return container.start();
}

function clientFor(
  container: StartedTestContainer,
  options: { serverSigningPublicKeyPem?: string } = {},
): { client: GrpcImmudbClient; close: () => Promise<void> } {
  const grpc: ImmuServiceClient = createImmudbGrpcClient({
    address: `${container.getHost()}:${container.getMappedPort(3322)}`,
    tls: false,
  });
  const pool = new ImmudbSessionPool(() => ImmudbSession.open(grpc, ADMIN, 5_000), 2, 60_000);
  return {
    client: new GrpcImmudbClient(pool, options),
    close: async () => {
      await pool.close();
      grpc.close();
    },
  };
}

describe.skipIf(process.env['INTEGRATION'] !== '1')('immudb verification (real server)', () => {
  let plain: StartedTestContainer | undefined;
  let signed: StartedTestContainer | undefined;
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  beforeAll(async () => {
    [plain, signed] = await Promise.all([
      start(),
      start(keys.privateKey.export({ type: 'sec1', format: 'pem' }).toString()),
    ]);
  });

  afterAll(async () => {
    await Promise.all([plain?.stop(), signed?.stop()]);
  });

  it('proves consistency forward, rejects backwards and a tampered trusted hash', async () => {
    if (plain === undefined) throw new Error('container not started');
    const { client, close } = clientFor(plain);
    try {
      await client.readWrite((tx) =>
        tx.exec('CREATE TABLE IF NOT EXISTS vt (id VARCHAR[36], amount INTEGER, PRIMARY KEY id)'),
      );
      const trusted = await client.currentState();
      for (const id of ['a', 'b', 'c']) {
        await client.readWrite((tx) =>
          tx.exec('INSERT INTO vt (id, amount) VALUES (@id, @amount)', { id, amount: -5n }),
        );
      }
      const target = await client.currentState();
      await expect(client.verifyConsistency(trusted, target)).resolves.toBeUndefined();
      await expect(client.verifyConsistency(target, trusted)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      const tampered: ImmudbState = {
        ...trusted,
        txHash: Uint8Array.from(trusted.txHash, (b, i) => (i === 0 ? b ^ 1 : b)),
      };
      await expect(client.verifyConsistency(tampered, target)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
      const fromOld = await client.verifiedRow('vt', ['b'], trusted);
      expect(fromOld.row).toEqual({ id: 'b', amount: -5n });
      expect(fromOld.state.txId).toBe(fromOld.txId);
      const fromNew = await client.verifiedRow('vt', ['b'], target);
      expect(fromNew.state.txId).toBe(target.txId);
      await expect(client.verifiedRow('vt', ['b'], tampered)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
    } finally {
      await close();
    }
  });

  it('verifies signed states with the pinned key and rejects another key', async () => {
    if (signed === undefined) throw new Error('container not started');
    const { client, close } = clientFor(signed, { serverSigningPublicKeyPem: publicPem });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const wrong = clientFor(signed, { serverSigningPublicKeyPem: other });
    try {
      const first = await client.currentState();
      expect(first.signature).not.toBeNull();
      await client.readWrite((tx) =>
        tx.exec('CREATE TABLE IF NOT EXISTS st (id VARCHAR[8], PRIMARY KEY id)'),
      );
      const second = await client.currentState();
      await expect(client.verifyConsistency(first, second)).resolves.toBeUndefined();
      await expect(wrong.client.verifyConsistency(first, second)).rejects.toMatchObject({
        kind: 'verification-failed',
      });
    } finally {
      await Promise.all([close(), wrong.close()]);
    }
  });
});
```

Run: `INTEGRATION=1 npx vitest run --project immudb:int immudb-verification` — Expected: PASS (2 tests).
Unverified (Docker was down at review): the image's `Cmd` and the `--signingKey` flag form; **unverified:
the L-9 int spec must confirm it** for the unsigned path (`verifyEntry`, `advanceTrustedState`).
First check the image's defaults: `docker inspect codenotary/immudb:1.11.2 --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'`.
If `Cmd` is not `null`, `withCommand` would drop it: pass the flag as
`withEnvironment({ IMMUDB_PGSQL_SERVER: 'false', IMMUDB_SIGNINGKEY: '/keys/signing.key' })` instead (immudb
binds every flag to `IMMUDB_<FLAG>`); the int spec decides.
If the signed container exits at start, read `await signed.logs()`: the key must be the SEC1 PEM written
above and readable by the image's user (mode 0644).

- [ ] **Step 6: Notices.** Append to the `THIRD_PARTY_NOTICES.md` table:

```markdown
| `verifySqlEntry`, `decodeRowValue` (`src/verification/sql-row.ts`) | `pkg/client/sql.go` `VerifyRow`, `decodeRow` |
| `encodeKeyValue`, row key layout (`src/verification/sql-row.ts`) | `embedded/sql/catalog.go` `EncodeRawValueAsKey`, `DecodeValue`, `MapKey`, `EncodeID`; `embedded/sql/stmt.go` `RowPrefix`, `PKIndexID` |
| `stateSignedBytes`, `verifyStateSignature` (`src/verification/state-signature.ts`) | `pkg/api/schema/state.go` `ToBytes`, `CheckSignature`; `pkg/signer/ecdsa.go` `Verify` |
```

- [ ] **Step 7: Wider checks.** `npx biome check --write libs/immudb`,
      `npx prettier --write libs/immudb/THIRD_PARTY_NOTICES.md`, `bun run check` — Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add libs/immudb
git commit -m "feat(immudb): verify SQL rows, consistency proofs and signed server states" \
  -m "ImmudbClient gains verifyConsistency (dual proof from a trusted state, rejecting a trusted state
newer than the target) and verifiedRow (row key encoding, htree inclusion, dual proof, optional
ECDSA state signature against IMMUDB_SERVER_SIGNING_PUBLIC_KEY). Ported from Apache-2.0 immudb
v1.9DOM.1; vector and real-server specs include tampered inputs."
```

### Task L-6: compose `immudb` service, readiness job and infra check

**Files:**

- Modify: `docker-compose.yml` (`x-env-base` `:30-56`, new anchor after `x-env-stripe` `:110-112`,
  services after `cassandra-init` `:286-304`, `infra-ready.depends_on` `:487-490`, `volumes:` `:899-910`),
  `scripts/docker/check-infra.sh` (`:42`, `:108-111`), `docker/prometheus/prometheus.yml` (after job
  `jaeger`), `.env.example` (compose-only section `:323-344`), `docs/DOCKER.md` (stack map `:33-50`,
  "Bootstrap jobs & migrations" `:196+`)
- Test: `scripts/docker/validate-compose.sh` and `PROJECT=ledger-infra-check scripts/docker/check-infra.sh`
  (existing checks, extended)

**Interfaces:**

- Consumes: L-2a variable names.
- Produces: compose service `immudb` (`codenotary/immudb:1.11.2`, gRPC `immudb:3322`, host
  `127.0.0.1:${IMMUDB_HOST_PORT:-3322}`, metrics/readiness `immudb:9497` in-network only), one-shot
  `immudb-init` (exits 0 once `/readyz` answers), anchor `x-env-immudb` (consumed by monolith and
  billing-service in L-12; unused until then), volume `immudb-data`.

**Wave:** after L-2a (parallel with L-3/L-5). The image is distroless (spec P0: no shell), so there is
no exec healthcheck: readiness is the `immudb-init` job, which uses the already-pulled Redis Alpine image's
busybox `wget` (the same trick as `infra-ready`).

- [ ] **Step 1: Extend the checks first (they fail until the service exists).** In
      `scripts/docker/check-infra.sh` replace `for svc in kafka-init cassandra-init storage-init; do` with
      `for svc in kafka-init cassandra-init storage-init immudb-init; do`, and in the host-port loop replace
      `  "s3:${S3_HOST_PORT:-9000}" "gcs:${GCS_HOST_PORT:-4443}"; do` with
      `  "s3:${S3_HOST_PORT:-9000}" "gcs:${GCS_HOST_PORT:-4443}" "immudb:${IMMUDB_HOST_PORT:-3322}"; do`.

- [ ] **Step 2: Run them.** `scripts/docker/validate-compose.sh` (Expected: PASS, nothing changed yet), then
      in an isolated project with shifted ports:

```bash
PROJECT=ledger-infra-check POSTGRES_HOST_PORT=25432 REDIS_HOST_PORT=26379 CASSANDRA_HOST_PORT=29042 \
  KAFKA_HOST_PORT=29094 MAILPIT_SMTP_HOST_PORT=21025 MAILPIT_UI_HOST_PORT=28025 S3_HOST_PORT=29000 \
  S3_CONSOLE_HOST_PORT=29001 GCS_HOST_PORT=24443 IMMUDB_HOST_PORT=23322 scripts/docker/check-infra.sh
```

Expected: FAIL at the init-job loop (`immudb-init`: no such service, or `[check-infra] FAIL: immudb-init
never ran`).

- [ ] **Step 3: Compose.** In `x-env-base`, after `  CASSANDRA_ALLOW_SIMPLE_STRATEGY: "true"` add
      `  IMMUDB_ALLOW_INSECURE: "true"`. After the `x-env-stripe` anchor add:

```yaml
# immudb (ledger store). Wired into monolith and billing-service by ledger wave 2 (L-12). The app user
# is provisioned by the apps' migrate step with SELECT + INSERT only; the admin password is immudb's
# built-in default unless IMMUDB_ADMIN_PASSWORD was set before the volume was first created.
# ChangeSQLPrivileges (re-applied by every migration run) ends the app user's open sessions; the
# pools recover, but L-12 should migrate from one process (the migrate step) rather than every app.
x-env-immudb: &env-immudb
  IMMUDB_ADDRESS: immudb:3322
  IMMUDB_DATABASE: ${IMMUDB_DATABASE:-app}
  IMMUDB_PASSWORD: '${IMMUDB_PASSWORD:-Compose-local-App1!}'
  IMMUDB_ADMIN_PASSWORD: ${IMMUDB_ADMIN_PASSWORD:-immudb}
  IMMUDB_RUN_MIGRATIONS: 'true'
```

After the `cassandra-init` service add the two services below. **Indent the whole block by 2 spaces**:
they are children of `services:` (`docker-compose.yml:143`, like `cassandra-init` at `:286`); Prettier
dedents YAML inside this plan, and `npx prettier --write docker-compose.yml` (Step 5) restores the
file's double quotes. Keep `$$(seq …)` (compose escapes `$` as `$$`).

```yaml
immudb:
  image: codenotary/immudb:1.11.2
  restart: unless-stopped
  logging: *logging
  networks: [backend]
  environment:
    # gRPC only: the pg-wire server takes passwords in cleartext and ignores GRANT/REVOKE.
    IMMUDB_PGSQL_SERVER: 'false'
    # Superuser password on first start of an empty volume (immudb's default is immudb).
    IMMUDB_ADMIN_PASSWORD: ${IMMUDB_ADMIN_PASSWORD:-immudb}
  ports: ['127.0.0.1:${IMMUDB_HOST_PORT:-3322}:3322']
  volumes: [immudb-data:/var/lib/immudb]
  # Distroless image (no shell, no exec healthcheck): immudb-init polls GET :9497/readyz instead.
  stop_grace_period: 30s
  deploy:
    resources:
      limits: { cpus: '1.0', memory: 512M }

immudb-init:
  image: redis:8.10.2-alpine3.23 # any already-pulled image with busybox wget
  restart: 'no'
  logging: *logging
  networks: [backend]
  depends_on:
    immudb: { condition: service_started }
  entrypoint:
    - sh
    - -c
    - >-
      for i in $$(seq 1 60); do
      wget -q -O /dev/null http://immudb:9497/readyz && echo 'immudb ready' && exit 0;
      sleep 1; done; echo 'immudb not ready after 60s' >&2; exit 1
  deploy:
    resources:
      limits: { cpus: '0.1', memory: 32M }
```

In `infra-ready.depends_on` add `      immudb-init: { condition: service_completed_successfully }` after the
`storage-init` line. Under `volumes:` add `  immudb-data:` after `  cassandra-data:`.

`docker/prometheus/prometheus.yml`: at the end of `scrape_configs` (after the `redis` job) append,
**indented by 2 spaces** like the other jobs (Prettier dedents YAML inside this plan)

```yaml
# immudb's Prometheus endpoint (in-network only; infra service, always on).
- job_name: immudb
  static_configs:
    - targets: ['immudb:9497']
      labels: { service: immudb }
```

`.env.example`, compose-only section: after `# GCS_HOST_PORT=4443` add `# IMMUDB_HOST_PORT=3322`.

`docs/DOCKER.md`: in the stack map, after the `cassandra-init` row add
`| `immudb`|`codenotary/immudb:1.11.2` (distroless) | 3322 (gRPC) | — | ledger store (append-only, verifiable SQL); pg-wire off; metrics 9497 in-network |`
and `| `immudb-init`|`redis:8.10.2-alpine3.23`(busybox) | — | — | one-shot: waits for immudb`/readyz` |`.
Under "Bootstrap jobs & migrations" add:

```markdown
- **immudb**: `immudb-init` only waits for readiness (the image has no shell, so no healthcheck). The
  database, the SELECT/INSERT-only application user and the tables come from the apps' migrate step
  (`@platform/immudb` `runImmudbMigrations`, gRPC `ChangeSQLPrivileges`), wired in ledger wave 2. Data is
  append-only and cannot be erased: back up the `immudb-data` volume (stop the service, snapshot the
  volume) and never configure truncation for the ledger database. Licence: the server image is
  BUSL-1.1 (`LICENSE` at v1.11.2: "Licensed Work: immudb Version 1.9DOM.2 or later"); its Additional
  Use Grant allows production use unless the product offers immudb to third parties, hosted or
  embedded, in competition with Codenotary's paid versions (internal use is not competitive). The
  repo's verification port comes from Apache-2.0 `v1.9DOM.1` (`libs/immudb/THIRD_PARTY_NOTICES.md`).
```

Also add `immudb-init` to the list "The init jobs (`kafka-init`, `cassandra-init`, `storage-init`) run once"
at `docs/DOCKER.md:85`.

- [ ] **Step 4: Run the checks.** `scripts/docker/validate-compose.sh` — Expected: PASS. The Step 2
      command — Expected: PASS with `immudb-init: exited 0` and `immudb 127.0.0.1:23322 open`. Tear down only
      this project:
      `[ "${PROJECT:-ledger-infra-check}" = ledger-infra-check ] && docker compose -p ledger-infra-check down -v`.

- [ ] **Step 5: Wider checks.** `npx prettier --write docker-compose.yml docker/prometheus/prometheus.yml docs/DOCKER.md`,
      `node scripts/check-env-example.mjs` (Expected: exit 0), `bun run check` (Expected: PASS).

- [ ] **Step 6: Commit.**

```bash
git add docker-compose.yml scripts/docker/check-infra.sh docker/prometheus/prometheus.yml .env.example docs/DOCKER.md
git commit -m "build(docker): add the immudb service with a readiness job and infra checks" \
  -m "codenotary/immudb:1.11.2 with pg-wire off, gRPC on 127.0.0.1:\${IMMUDB_HOST_PORT:-3322}, metrics
scraped in-network. The distroless image has no shell, so immudb-init polls /readyz and gates
infra-ready; check-infra.sh asserts it. x-env-immudb is ready for the apps (wave 2)."
```

### Task L-7: Stripe idempotency fixes that need no schema change (S-1, S-3, S-5, S-8, S-10)

**Files:**

- Modify: `domains/billing/src/billing.constants.ts` (`BillingErrorCode` `:5-31`, metrics after `:66`),
  `domains/billing/src/domain/billing.errors.ts`, `domains/billing/src/domain/payment.aggregate.ts`
  (`complete()` `:216-247`, getters `:136-170`), `domains/billing/src/domain/events/payment-succeeded.event.ts`,
  `domains/billing/src/application/relays/payment-succeeded.relay.ts:7-16`,
  `domains/billing/contracts/src/events/billing.events.ts:5-14`,
  `domains/billing/src/infrastructure/stripe/stripe.constants.ts`,
  `domains/billing/src/infrastructure/stripe/stripe.module.ts:8-21`,
  `domains/billing/src/infrastructure/stripe/stripe.service.ts`,
  `domains/billing/src/infrastructure/stripe/stripe.errors.ts:19-30`,
  `domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.ts:44-68`,
  `domains/billing/src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts:53-118`,
  `domains/billing/src/billing-core.module.ts:39-43`, `domains/billing/test/stripe-webhook.flow.spec.ts:80`,
  `domains/billing/README.md` (error table `:196` and the codes at `:106`), `docs/API.md:316`, `:372`,
  `docs/OBSERVABILITY.md:157` (metrics table)
- Test (extend): `create-checkout-session.handler.spec.ts`, `handle-stripe-webhook.handler.spec.ts`,
  `payment.aggregate.spec.ts`, `stripe.errors.spec.ts`, `stripe.service.spec.ts`,
  `payment-succeeded.relay.spec.ts`, `domains/billing/contracts/src/events/billing.events.spec.ts`

**Interfaces:**

- Consumes: existing billing code only. Touches no table, no migration, no `tenant_id` (D5).
- Produces:

```ts
// billing.constants.ts
BillingErrorCode.CHECKOUT_IN_PROGRESS = 'CHECKOUT_IN_PROGRESS'; // 409, details.retryAfterSec = 1
BillingErrorCode.CHECKOUT_SESSION_CLOSED = 'CHECKOUT_SESSION_CLOSED'; // 409, details.sessionStatus
export const AMOUNT_MISMATCH_METRIC = 'billing_checkout_amount_mismatch_total';
export const API_VERSION_MISMATCH_METRIC = 'billing_stripe_api_version_mismatch_total';
// domain
export class CheckoutSessionClosedException extends DomainConflictException {
  constructor(paymentId: string, sessionStatus: string);
}
Payment#amountTotal: number | null; // getter
PaymentSucceededEvent(…, paidAt: Date, stripePaymentIntentId: string | null = null);
// stripe
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-08-26.dahlia';
StripeService#retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session>;
// contracts: paymentSucceededPayload gains stripePaymentIntentId?: string (non-breaking, v1 kept)
```

**Wave:** after **G-11** merges into `feat/domains-tenancy` (G-11 restructures the billing barrel and
modules; rebase this worktree first). L-7 merges **before** B2 edge Lane B Task 1 (controller ruling 2026-11-10): that task edits the same
checkout and webhook handlers and quotes the post-L-7 code (`boundSession`, `retrieveCheckoutSession`,
the `api_version` check right after `constructWebhookEvent` in `execute`, the two counters), so keep these
names and placements exactly. Facts verified at `9600510`: a 409 `idempotency_key_in_use` is not a
`StripeIdempotencyError` (the SDK's `generateV1Error` only maps 400/404 `idempotency_error`), so today it
becomes `StripeAPIError` → `PAYMENT_PROVIDER_ERROR` (502), and because that is not a
`DomainConflictException`, `recordFailure` (`create-checkout-session.handler.ts:98-100`) marks the payment
`failed`. Stripe 22.6.2 pins `ApiVersion = "2026-08-26.dahlia"` (`node_modules/stripe/esm/apiVersion.d.ts`).

- [ ] **Step 1: Write the failing tests.** Append to
      `domains/billing/src/infrastructure/stripe/stripe.errors.spec.ts` (inside the `describe`):

```ts
it('maps a 409 idempotency_key_in_use (a StripeAPIError) to a retryable CHECKOUT_IN_PROGRESS', () => {
  const raw = Stripe.errors.StripeError.generate({
    type: 'invalid_request_error',
    code: 'idempotency_key_in_use',
    statusCode: 409,
    message: 'There is currently another in-progress request using this Idempotent Key.',
  });
  expect(raw).toBeInstanceOf(Stripe.errors.StripeAPIError);
  const mapped = toPaymentDomainException(raw);
  expect(mapped).toBeInstanceOf(DomainConflictException);
  expect(mapped).toMatchObject({
    code: 'CHECKOUT_IN_PROGRESS',
    details: { retryAfterSec: 1 },
  });
});
```

Append to `domains/billing/src/infrastructure/stripe/stripe.service.spec.ts`:

```ts
describe('StripeService.retrieveCheckoutSession and the pinned API version', () => {
  it('retrieves a session by id and translates SDK errors', async () => {
    const service = createService();
    const retrieve = vi
      .spyOn(service.client.checkout.sessions, 'retrieve')
      .mockResolvedValueOnce({ id: 'cs_1', status: 'open' } as never)
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({ statusCode: 500, message: 'down', type: 'api_error' }),
      );
    await expect(service.retrieveCheckoutSession('cs_1')).resolves.toMatchObject({ id: 'cs_1' });
    expect(retrieve).toHaveBeenCalledWith('cs_1');
    await expect(service.retrieveCheckoutSession('cs_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
    });
  });

  it('pins the API version the SDK was built for', () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });
});
```

(import `STRIPE_API_VERSION` from `./stripe.constants.js`). Append to
`create-checkout-session.handler.spec.ts` (inside the `describe`; `stripe.retrieveCheckoutSession` is
auto-mocked by `createMock`):

```ts
it('a replay retrieves the bound session instead of creating a second one (S-1)', async () => {
  const first = await handler.execute(
    new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-50-key' })),
  );
  stripe.createCheckoutSession.mockClear();
  stripe.retrieveCheckoutSession.mockResolvedValueOnce(
    makeCheckoutSession({ id: 'cs_test_1', amount_total: 5_000, currency: 'usd', status: 'open' }),
  );
  const second = await handler.execute(
    new CreateCheckoutSessionCommand(request({ idempotencyKey: 'order-50-key' })),
  );
  expect(second).toEqual(first);
  expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith('cs_test_1');
  expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
});

it.each(['expired', 'complete'] as const)(
  'a replay of a %s session gets 409 CHECKOUT_SESSION_CLOSED and no new session',
  async (status) => {
    await handler.execute(
      new CreateCheckoutSessionCommand(request({ idempotencyKey: `order-51-${status}` })),
    );
    stripe.createCheckoutSession.mockClear();
    stripe.retrieveCheckoutSession.mockResolvedValueOnce(
      makeCheckoutSession({ id: 'cs_test_1', status, url: null }),
    );
    await expect(
      handler.execute(
        new CreateCheckoutSessionCommand(request({ idempotencyKey: `order-51-${status}` })),
      ),
    ).rejects.toMatchObject({
      code: 'CHECKOUT_SESSION_CLOSED',
      details: { sessionStatus: status },
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  },
);
```

Replace the existing test `'replays an Idempotency-Key: same payment, same Stripe key, one row'`
(`:100-114`) body's last assertion block

```ts
expect(stripe.createCheckoutSession.mock.calls.map((call) => call[1])).toEqual([
  checkoutIdempotencyKey(first.paymentId),
  checkoutIdempotencyKey(first.paymentId),
]);
```

with

```ts
expect(stripe.createCheckoutSession.mock.calls.map((call) => call[1])).toEqual([
  checkoutIdempotencyKey(first.paymentId),
]);
expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith('cs_test_1');
```

and, before its second `handler.execute`, add
`stripe.retrieveCheckoutSession.mockResolvedValueOnce(makeCheckoutSession({ id: 'cs_test_1', amount_total: 5_000, currency: 'usd', status: 'open' }));`.

Append to `domains/billing/src/domain/payment.aggregate.spec.ts` inside `describe('complete', …)`:

```ts
it('refuses a paid completion when no amount is known (no ?? 0, S-5)', () => {
  const payment = makePayment({
    stripeCheckoutSessionId: 'cs_1',
    amountTotal: null,
    currency: 'usd',
  });
  const done = payment.complete(
    {
      sessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      amountTotal: null,
      currency: 'usd',
      paidAt: new Date(),
    },
    new Date(),
  );
  expect(done).toBe(false);
  expect(payment.status).toBe(PaymentStatus.Pending);
  expect(payment.getUncommittedEvents()).toEqual([]);
});

it('records what Stripe charged and carries the PaymentIntent id on the event (S-5, S-8)', () => {
  const payment = makePayment({
    stripeCheckoutSessionId: 'cs_1',
    amountTotal: 2_500,
    currency: 'usd',
  });
  payment.complete(
    {
      sessionId: 'cs_1',
      paymentIntentId: 'pi_9',
      amountTotal: 2_000,
      currency: 'usd',
      paidAt: new Date(),
    },
    new Date(),
  );
  expect(payment.amountTotal).toBe(2_000);
  expect(payment.getUncommittedEvents()).toEqual([
    expect.objectContaining({ amountTotal: 2_000, stripePaymentIntentId: 'pi_9' }),
  ]);
});
```

(`makePayment` is in `domains/billing/test/billing-test.utils.ts`; import it with the relative path the spec
already uses for test utils, or `../../test/billing-test.utils.js`.) Append to
`handle-stripe-webhook.handler.spec.ts`: change `beforeEach` to also create
`amountMismatch = { inc: vi.fn<() => void>() }` and `apiVersionMismatch = { inc: vi.fn<() => void>() }`
(declare them next to `paidWithoutCurrency`) and pass them as the 6th and 7th constructor arguments, then add:

```ts
it('counts and records a charge that differs from the quote (S-5)', async () => {
  const warn = vi.spyOn(Logger.prototype, 'warn');
  await deliver(completed({ amount_total: 2_000 }, 'evt_amount_mismatch_1'));
  expect(store.payment(payment.id)).toMatchObject({
    status: PaymentStatus.Succeeded,
    amountTotal: 2_000,
  });
  expect(amountMismatch.inc).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('quoted 2500 usd'));
  warn.mockRestore();
});

it('does not count a charge equal to the quote', async () => {
  await deliver(completed({}, 'evt_amount_equal_1'));
  expect(amountMismatch.inc).not.toHaveBeenCalled();
});

it('counts events signed for another API version but still applies them (S-10)', async () => {
  await deliver(
    signedEvent(
      'checkout.session.expired',
      makeCheckoutSession({ id: 'cs_paid_1', client_reference_id: payment.id, status: 'expired' }),
      { id: 'evt_old_api_1', apiVersion: '2020-08-27' },
    ),
  );
  expect(apiVersionMismatch.inc).toHaveBeenCalledTimes(1);
  expect(store.payment(payment.id)).toMatchObject({ status: PaymentStatus.Expired });
});
```

`signedEvent` (`domains/billing/test/billing-test.utils.ts:280-300`) gains an optional
`apiVersion?: string` in its options, used as `api_version: options.apiVersion ?? Stripe.API_VERSION`.
Append to `payment-succeeded.relay.spec.ts` a test that `toPaymentSucceededPayload` includes
`stripePaymentIntentId: 'pi_1'` when the event carries it and omits the key when it is `null`, and to
`billing.events.spec.ts` a test that `paymentSucceededPayload.parse` accepts the payload with and without
`stripePaymentIntentId` and rejects `stripePaymentIntentId: ''`.

- [ ] **Step 2: Run them.** `npx vitest run --project billing --project billing-contracts` — Expected:
      FAIL (`retrieveCheckoutSession` is not a function, `STRIPE_API_VERSION` undefined, mapped code
      `PAYMENT_PROVIDER_ERROR`, `?? 0` completes the payment, unknown constructor arguments).

- [ ] **Step 3: Implement.** `billing.constants.ts`: add to `BillingErrorCode` after
      `CHECKOUT_URL_MISSING`:

```ts
  /** The same checkout request is still in flight at Stripe (`idempotency_key_in_use`): retry. */
  CHECKOUT_IN_PROGRESS: 'CHECKOUT_IN_PROGRESS',
  /** A replayed checkout request whose session is already `complete` or `expired`. */
  CHECKOUT_SESSION_CLOSED: 'CHECKOUT_SESSION_CLOSED',
```

and after `PAID_WITHOUT_CURRENCY_METRIC`:

```ts
/**
 * Prometheus counter: paid Checkout Sessions whose charged amount or currency differs from the quote
 * stored at session creation (promotion codes, tax, price changes). The charged values are recorded;
 * reconcile any increase (ledger reconciliation R3 later writes a discrepancy row).
 */
export const AMOUNT_MISMATCH_METRIC = 'billing_checkout_amount_mismatch_total';
/** Prometheus counter: webhook events whose `api_version` differs from `STRIPE_API_VERSION`. */
export const API_VERSION_MISMATCH_METRIC = 'billing_stripe_api_version_mismatch_total';
```

`domain/billing.errors.ts`: add

```ts
/** A replayed checkout request found its session `complete` or `expired`: never create a second one. */
export class CheckoutSessionClosedException extends DomainConflictException {
  constructor(paymentId: string, sessionStatus: string) {
    super(`The Checkout Session of payment ${paymentId} is ${sessionStatus}`, {
      code: BillingErrorCode.CHECKOUT_SESSION_CLOSED,
      details: { paymentId, sessionStatus },
    });
  }
}
```

`domain/events/payment-succeeded.event.ts`: add a last constructor parameter
`    /** Stripe PaymentIntent (`pi_…`), when Stripe reported one. */\n    readonly stripePaymentIntentId: string | null = null,`
after `readonly paidAt: Date,`.

`domain/payment.aggregate.ts`: add the getter after `get quantity()`:

```ts
  /** Minor units; the quote until the payment completes, then what Stripe charged. */
  get amountTotal(): number | null {
    return this.state.amountTotal;
  }
```

In `complete()`, replace these lines (`payment.aggregate.ts:221-224`, quoted verbatim in a `text` block
so formatting never re-wraps them)

```text
    const currency =
      normalizeCurrency(completion.currency) ?? normalizeCurrency(this.state.currency);
    if (currency === null) return false;
    const amountTotal = completion.amountTotal ?? this.state.amountTotal ?? 0;
```

with (Biome re-wraps it)

```ts
const currency = normalizeCurrency(completion.currency) ?? normalizeCurrency(this.state.currency);
// What Stripe charged wins over the quote; with neither, refuse rather than record 0.
const amountTotal = completion.amountTotal ?? this.state.amountTotal;
if (currency === null || amountTotal === null) return false;
```

and pass `this.state.stripePaymentIntentId` as the last `new PaymentSucceededEvent(…)` argument (after
`completion.paidAt`). Update the method's doc comment: "…and when no currency or no amount is known".

`application/relays/payment-succeeded.relay.ts` `toPaymentSucceededPayload`: add
`    ...(event.stripePaymentIntentId === null ? {} : { stripePaymentIntentId: event.stripePaymentIntentId }),`
after `paidAt`. `contracts/src/events/billing.events.ts`: add to the object after `paidAt`:

```ts
  /** Stripe PaymentIntent (`pi_…`): locates the charge and its balance transaction. Optional (v1). */
  stripePaymentIntentId: z.string().min(1).optional(),
```

`infrastructure/stripe/stripe.constants.ts`: add

```ts
import type Stripe from 'stripe';

/**
 * The Stripe API version requests are made with and webhooks are expected in. Typed as the SDK's
 * pinned literal: an SDK upgrade that moves it fails `tsc` here, so the webhook endpoint in the
 * dashboard is re-pinned deliberately (`docs/API.md`).
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-08-26.dahlia';
```

`infrastructure/stripe/stripe.module.ts` `createStripeClient`: add `apiVersion: STRIPE_API_VERSION,` to the
options and replace the doc sentence "`apiVersion` is deliberately omitted: …SDK upgrades (pin the webhook
endpoint to the same version in the dashboard)." with "`apiVersion` is pinned to `STRIPE_API_VERSION` (the
SDK's literal); pin the webhook endpoint to the same version in the dashboard."

`infrastructure/stripe/stripe.service.ts`: add after `createCheckoutSession`:

```ts
  /** The current state of a Checkout Session (a GET: naturally idempotent). */
  async retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session> {
    try {
      return await this.client.checkout.sessions.retrieve(id);
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }
```

`infrastructure/stripe/stripe.errors.ts`: right after the
`if (!(error instanceof Stripe.errors.StripeError)) return undefined;` block's `details` line add

```ts
// 409 from a concurrent request with the same key: a StripeAPIError (only 400/404 become
// StripeIdempotencyError). A conflict, so the caller does not mark the payment failed.
if (error.code === 'idempotency_key_in_use') {
  return new DomainConflictException(
    'The same checkout request is still being processed, retry shortly',
    {
      code: BillingErrorCode.CHECKOUT_IN_PROGRESS,
      cause: error,
      details: { ...details, retryAfterSec: 1 },
    },
  );
}
```

`create-checkout-session.handler.ts`: replace `    const session = await this.createSession(payment, request);`
with

```ts
const boundId = payment.stripeCheckoutSessionId;
const session =
  boundId === null
    ? await this.createSession(payment, request)
    : await this.boundSession(payment, boundId);
```

and add the method (import `CheckoutSessionClosedException`):

```ts
  /**
   * A replay never creates a second session (Stripe forgets idempotency keys after 24 h, so a late
   * `create` would make an orphan session and then fail `CHECKOUT_SESSION_MISMATCH`).
   */
  private async boundSession(
    payment: Payment,
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    const session = await this.stripe.retrieveCheckoutSession(sessionId);
    if (session.status === 'complete' || session.status === 'expired') {
      throw new CheckoutSessionClosedException(payment.id, session.status);
    }
    return session;
  }
```

Update the class doc comment step 2: "Create the Checkout Session …, or retrieve the one already bound to
the payment (a replay)."

`handle-stripe-webhook.handler.ts`: constructor gains

```ts
    @InjectMetric(AMOUNT_MISMATCH_METRIC)
    private readonly amountMismatch: { inc(): void },
    @InjectMetric(API_VERSION_MISMATCH_METRIC)
    private readonly apiVersionMismatch: { inc(): void },
```

(imports from `billing.constants.js` and `STRIPE_API_VERSION` from `stripe.constants.js`). In
`execute`, after `const event = this.stripe.constructWebhookEvent(…)`:

```ts
if (event.api_version !== null && event.api_version !== STRIPE_API_VERSION) {
  this.apiVersionMismatch.inc();
  this.logger.warn(
    `Stripe event ${event.id} uses API version ${event.api_version}, expected ${STRIPE_API_VERSION}: re-pin the webhook endpoint`,
  );
}
```

In the completed/async-succeeded branch, replace the `return p.complete(` … `);` call with

```ts
const quoted = { amount: p.amountTotal, currency: normalizeCurrency(p.currency) };
const applied = p.complete(
  {
    sessionId: session.id,
    paymentIntentId: paymentIntentIdOf(session),
    amountTotal: session.amount_total,
    currency: session.currency,
    paidAt,
  },
  now,
);
const charged = { amount: p.amountTotal, currency: normalizeCurrency(p.currency) };
if (
  applied &&
  quoted.amount !== null &&
  quoted.currency !== null &&
  (charged.amount !== quoted.amount || charged.currency !== quoted.currency)
) {
  this.amountMismatch.inc();
  this.logger.warn(
    `Stripe event ${event.id}: payment ${p.id} was quoted ${quoted.amount} ${quoted.currency} but Stripe charged ${charged.amount} ${charged.currency}; recorded as charged`,
  );
}
return applied;
```

`billing-core.module.ts`: after the existing `makeCounterProvider({ name: PAID_WITHOUT_CURRENCY_METRIC, … })`
add

```ts
    makeCounterProvider({
      name: AMOUNT_MISMATCH_METRIC,
      help: 'Paid Stripe Checkout Sessions whose charged amount or currency differs from the quote',
    }),
    makeCounterProvider({
      name: API_VERSION_MISMATCH_METRIC,
      help: 'Stripe webhook events whose api_version differs from the pinned STRIPE_API_VERSION',
    }),
```

`domains/billing/test/stripe-webhook.flow.spec.ts:80`: next to
`makeCounterProvider({ name: PAID_WITHOUT_CURRENCY_METRIC, help: 'test' }),` add the same for
`AMOUNT_MISMATCH_METRIC` and `API_VERSION_MISMATCH_METRIC`.

- [ ] **Step 4: Run the tests.** `npx vitest run --project billing --project billing-contracts` —
      Expected: PASS. Then `npx vitest run --project monolith --project billing-service --project gateway`
      — Expected: PASS (the apps compile `BillingCoreModule` with the two new counters).

- [ ] **Step 5: Docs.** `docs/API.md:316`: add `CHECKOUT_IN_PROGRESS`, `CHECKOUT_SESSION_CLOSED` to the
      409 billing row. `docs/API.md:372`: replace "Sending it again with the same `priceId` and `quantity`
      returns the same payment and the same Checkout Session." with "Sending it again with the same `priceId`
      and `quantity` returns the same payment and the same Checkout Session (retrieved from Stripe, so this
      holds after Stripe's 24-hour key window too); once that session is paid or expired the replay gets 409
      `CHECKOUT_SESSION_CLOSED`. A replay while the first request is still at Stripe gets 409
      `CHECKOUT_IN_PROGRESS` (`details.retryAfterSec`). The key lives as long as the payment." In
      `domains/billing/README.md:196` table add the row
      `| `StripeAPIError`with`code: idempotency_key_in_use`(409) |`DomainConflictException`(409) |`CHECKOUT_IN_PROGRESS` |`
      and list both new codes at `:106`. `docs/OBSERVABILITY.md`: after the
      `billing_checkout_paid_without_currency_total` row (`:157`) add these two rows (Prettier pads them):

```text
| `billing_checkout_amount_mismatch_total` | counter | — | billing: paid Checkout Sessions whose charged amount or currency differs from the quote |
| `billing_stripe_api_version_mismatch_total` | counter | — | billing: Stripe webhook events whose `api_version` differs from `STRIPE_API_VERSION` |
```

- [ ] **Step 6: Wider checks.** `npx biome check --write domains/billing`,
      `npx prettier --write docs/API.md docs/OBSERVABILITY.md domains/billing/README.md`, `bun run check` —
      Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add domains/billing docs/API.md docs/OBSERVABILITY.md
git commit -m "fix(billing,billing-contracts): retrieve bound checkout sessions and verify paid amounts" \
  -m "S-1: a replay retrieves the session bound to the payment (409 CHECKOUT_SESSION_CLOSED once paid
or expired) instead of creating a second one after Stripe's 24 h key window. S-3: a 409
idempotency_key_in_use becomes CHECKOUT_IN_PROGRESS and no longer marks the payment failed. S-5:
no ?? 0 on completion; charges differing from the quote are counted. S-8: optional
stripePaymentIntentId on billing.payment-succeeded.v1. S-10: STRIPE_API_VERSION pinned and
mismatching events counted."
```

### Task L-8a: billing ledger model (types, chart, ids, canonical hash, invariant)

**Files:**

- Create: `domains/billing/src/domain/ledger/ledger.types.ts`, `domains/billing/src/domain/ledger/ledger.ids.ts`,
  `domains/billing/src/domain/ledger/ledger.invariant.ts`, `domains/billing/src/domain/ledger/ledger.errors.ts`
- Modify: `domains/billing/src/billing.constants.ts` (`BillingErrorCode`), `domains/billing/package.json`
  (`"uuid": "catalog:"`), `domains/billing/src/index.ts` (root barrel)
- Test: `domains/billing/src/domain/ledger/ledger.ids.spec.ts`,
  `domains/billing/src/domain/ledger/ledger.invariant.spec.ts`, helper `domains/billing/test/ledger-fixtures.ts`

**Interfaces:**

- Consumes: `@platform/common` `BusinessRuleViolationException`, `ExternalServiceException`; `uuid` `v5`.
- Produces (root barrel `@domain/billing`; binding names from the spec's Interface contracts, plus the
  read-model types the spec left open):

```ts
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const LEDGER_NAMESPACE = '9402cabc-4fa0-4891-9ed1-389e5828479d'; // fixed forever: re-keys every entry if changed
export type LedgerAccountCode =
  | 'asset:stripe_balance'
  | 'asset:bank'
  | 'revenue:checkout'
  | 'contra_revenue:refunds'
  | 'contra_revenue:disputes'
  | 'expense:stripe_fees'
  | 'expense:dispute_fees'
  | 'equity:adjustments';
export type LedgerAccountKind =
  'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';
export const LEDGER_CHART: Readonly<
  Record<
    LedgerAccountCode,
    { readonly kind: LedgerAccountKind; readonly owner: 'platform' | 'tenant' }
  >
>;
export type LedgerEntryKind =
  | 'charge'
  | 'refund'
  | 'refund_failure'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'payout_failure'
  | 'stripe_fee'
  | 'adjustment';
export interface LedgerLine {
  readonly account: LedgerAccountCode;
  readonly accountOwnerTenantId: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}
export interface LedgerEntryDraft {
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly occurredAt: Date;
  readonly lines: readonly LedgerLine[];
}
export type LedgerPostOutcome =
  | {
      readonly status: 'posted';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly immudbTxId: bigint;
    }
  | { readonly status: 'replayed'; readonly entryId: string; readonly payloadHash: string }
  | {
      readonly status: 'conflict';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly existingPayloadHash: string;
    };
export interface LedgerPosting {
  readonly line: number;
  readonly accountId: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}
export interface LedgerEntry {
  readonly id: string;
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly payloadHash: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly postings: readonly LedgerPosting[];
}
export interface LedgerBalance {
  readonly accountId: string;
  readonly account: LedgerAccountCode | null;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}
export interface LedgerImbalance {
  readonly entryId: string;
  readonly currency: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly postings: number;
} // currency null = < 2 postings
export interface LedgerTrustedState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
}
export function ledgerEntryId(sourceKey: string): string; // uuidv5(LEDGER_NAMESPACE, sourceKey)
export function ledgerAccountId(
  ownerTenantId: string,
  account: LedgerAccountCode,
  currency: string,
): string;
export function ledgerPayloadHash(draft: LedgerEntryDraft): string; // sha256 hex of canonical JSON
export function toEpochMicros(at: Date): bigint;
export function assertBalanced(draft: LedgerEntryDraft): void; // throws LedgerUnbalancedException
export class LedgerUnbalancedException extends BusinessRuleViolationException {
  readonly sourceKey: string;
  readonly problems: readonly string[];
}
export class LedgerVerificationFailedException extends ExternalServiceException {
  constructor(entryId: string, reason: string, cause?: unknown);
}
// BillingErrorCode.LEDGER_ENTRY_INVALID, BillingErrorCode.LEDGER_VERIFICATION_FAILED
```

Canonical JSON (hash input): keys sorted at every level, `bigint` as a decimal string, no whitespace, over
`{ sourceKey, tenantId, kind, paymentId, stripeObject, presentment, occurredAtUs, lines: [{ accountId,
currency, debit, credit }] }` (spec 2.5; `recordedAt` excluded so a replay hashes the same; line order is
significant).

**Wave:** after **G-11** merges (root barrel and package manifest restructured). Place the new exports in
the root barrel (`src/index.ts`), never in `src/api/index.ts`: the gateway has no ledger use. If G-11 has not
merged when this lane reaches L-8a, stop and report (do not edit the pre-G-11 barrel). L-8a merges
**before** B2 edge Lane B Task 1, which replaces the line
`export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';` in `ledger.types.ts` with
`export { PLATFORM_TENANT_ID } from '@platform/common';`: keep that line byte for byte as below.

- [ ] **Step 1: Write the failing tests.** `domains/billing/test/ledger-fixtures.ts` (a test helper, shared by the ledger specs):

```ts
import type { LedgerEntryDraft } from '../src/domain/ledger/ledger.types.js';
import { PLATFORM_TENANT_ID } from '../src/domain/ledger/ledger.types.js';

export const LEDGER_TEST_TENANT = '0192f0c1-0000-7000-8000-000000000001';
const TENANT = LEDGER_TEST_TENANT;

/** A Stripe charge of 25.00 USD with a 1.03 USD fee (spec 2.4 first row). */
export const CHARGE_DRAFT: LedgerEntryDraft = {
  sourceKey: 'stripe:txn:txn_1',
  tenantId: TENANT,
  kind: 'charge',
  paymentId: '0192f0c1-0000-7000-8000-0000000000aa',
  stripeObjectId: 'ch_1',
  presentment: { amount: 2_500n, currency: 'usd' },
  occurredAt: new Date('2026-11-09T00:00:00.000Z'),
  lines: [
    {
      account: 'asset:stripe_balance',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 2_500n,
      credit: 0n,
    },
    {
      account: 'revenue:checkout',
      accountOwnerTenantId: TENANT,
      currency: 'usd',
      debit: 0n,
      credit: 2_500n,
    },
    {
      account: 'expense:stripe_fees',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 103n,
      credit: 0n,
    },
    {
      account: 'asset:stripe_balance',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 0n,
      credit: 103n,
    },
  ],
};
```

`domains/billing/src/domain/ledger/ledger.ids.spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT } from '../../../test/ledger-fixtures.js';
import { ledgerAccountId, ledgerEntryId, ledgerPayloadHash, toEpochMicros } from './ledger.ids.js';
import { PLATFORM_TENANT_ID } from './ledger.types.js';

/** Pinned forever: changing the namespace, the id inputs or the canonical form re-keys the ledger. */
const CANONICAL =
  '{"kind":"charge","lines":[{"accountId":"a713bc9c-7bfa-5292-bb07-c457419d8212","credit":"0","currency":"usd","debit":"2500"},{"accountId":"8b802315-548b-502c-9be0-a1d41b52aecf","credit":"2500","currency":"usd","debit":"0"},{"accountId":"7d92ee01-4ffa-5c83-8232-404f697c9460","credit":"0","currency":"usd","debit":"103"},{"accountId":"a713bc9c-7bfa-5292-bb07-c457419d8212","credit":"103","currency":"usd","debit":"0"}],"occurredAtUs":"1794182400000000","paymentId":"0192f0c1-0000-7000-8000-0000000000aa","presentment":{"amount":"2500","currency":"usd"},"sourceKey":"stripe:txn:txn_1","stripeObject":"ch_1","tenantId":"0192f0c1-0000-7000-8000-000000000001"}';

describe('ledger ids and hash', () => {
  it('derives deterministic uuidv5 ids', () => {
    expect(ledgerEntryId('stripe:txn:txn_1')).toBe('34963174-7910-51ca-a20a-690a08315957');
    expect(ledgerAccountId(PLATFORM_TENANT_ID, 'asset:stripe_balance', 'usd')).toBe(
      'a713bc9c-7bfa-5292-bb07-c457419d8212',
    );
    expect(ledgerAccountId(TENANT, 'revenue:checkout', 'usd')).toBe(
      '8b802315-548b-502c-9be0-a1d41b52aecf',
    );
  });

  it('hashes the canonical JSON (sorted keys, bigints as strings, recordedAt excluded)', () => {
    expect(ledgerPayloadHash(CHARGE_DRAFT)).toBe(
      createHash('sha256').update(CANONICAL).digest('hex'),
    );
    expect(ledgerPayloadHash(CHARGE_DRAFT)).toBe(
      '1764943fe2e39a5a9ac6b072deb88461d9c0d99ea244f7ab548487e139aba4e6',
    );
  });

  it('changes the hash for any money, account, order or tenant change', () => {
    const base = ledgerPayloadHash(CHARGE_DRAFT);
    const [a, b, c, d] = CHARGE_DRAFT.lines;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error();
    expect(
      ledgerPayloadHash({
        ...CHARGE_DRAFT,
        lines: [a, b, { ...c, debit: 104n }, { ...d, credit: 104n }],
      }),
    ).not.toBe(base);
    expect(ledgerPayloadHash({ ...CHARGE_DRAFT, lines: [b, a, c, d] })).not.toBe(base);
    expect(ledgerPayloadHash({ ...CHARGE_DRAFT, tenantId: PLATFORM_TENANT_ID })).not.toBe(base);
  });

  it('converts dates to epoch microseconds', () => {
    expect(toEpochMicros(new Date('2026-11-09T00:00:00.001Z'))).toBe(1_794_182_400_001_000n);
  });
});
```

`domains/billing/src/domain/ledger/ledger.invariant.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import { LedgerUnbalancedException } from './ledger.errors.js';
import { assertBalanced } from './ledger.invariant.js';
import { type LedgerEntryDraft, type LedgerLine, PLATFORM_TENANT_ID } from './ledger.types.js';

const problemsOf = (draft: LedgerEntryDraft): readonly string[] => {
  try {
    assertBalanced(draft);
  } catch (error) {
    if (error instanceof LedgerUnbalancedException) return error.problems;
    throw error;
  }
  return [];
};
const line = (overrides: Partial<LedgerLine>): LedgerLine => ({
  account: 'asset:stripe_balance',
  accountOwnerTenantId: PLATFORM_TENANT_ID,
  currency: 'usd',
  debit: 1n,
  credit: 0n,
  ...overrides,
});

describe('assertBalanced', () => {
  it('accepts a balanced multi-line entry', () => {
    expect(problemsOf(CHARGE_DRAFT)).toEqual([]);
  });

  it.each<[string, Partial<LedgerEntryDraft>, RegExp]>([
    ['one line', { lines: [line({})] }, /at least 2 lines/],
    [
      'debit and credit both set',
      { lines: [line({ credit: 1n }), line({ debit: 0n, credit: 1n })] },
      /exactly one of debit or credit/,
    ],
    [
      'a zero line',
      { lines: [line({ debit: 0n }), line({ debit: 0n, credit: 1n })] },
      /exactly one of debit or credit/,
    ],
    [
      'a negative amount',
      { lines: [line({ debit: -1n }), line({ debit: 0n, credit: -1n })] },
      /negative/,
    ],
    [
      'an uppercase currency',
      { lines: [line({ currency: 'USD' }), line({ currency: 'USD', debit: 0n, credit: 1n })] },
      /currency/,
    ],
    [
      'unbalanced per currency',
      { lines: [line({}), line({ currency: 'eur', debit: 0n, credit: 1n })] },
      /usd: debit 1 ≠ credit 0/,
    ],
    [
      'a platform account owned by a tenant',
      {
        lines: [
          line({ accountOwnerTenantId: CHARGE_DRAFT.tenantId }),
          line({ debit: 0n, credit: 1n }),
        ],
      },
      /asset:stripe_balance must be owned by the platform/,
    ],
    [
      'a tenant account owned by another tenant',
      {
        lines: [
          line({}),
          line({
            account: 'revenue:checkout',
            accountOwnerTenantId: '0192f0c1-0000-7000-8000-000000000002',
            debit: 0n,
            credit: 1n,
          }),
        ],
      },
      /revenue:checkout must be owned by the entry tenant/,
    ],
    ['a malformed tenant', { tenantId: 'tenant-1' }, /tenantId/],
    ['an empty source key', { sourceKey: '' }, /sourceKey/],
    ['a negative presentment', { presentment: { amount: -1n, currency: 'usd' } }, /presentment/],
  ])('rejects %s', (_name, overrides, problem) => {
    expect(problemsOf({ ...CHARGE_DRAFT, ...overrides })).toEqual(
      expect.arrayContaining([expect.stringMatching(problem)]),
    );
  });

  it('throws LedgerUnbalancedException with code LEDGER_ENTRY_INVALID', () => {
    expect(() => assertBalanced({ ...CHARGE_DRAFT, lines: [] })).toThrow(
      expect.objectContaining({ code: 'LEDGER_ENTRY_INVALID' }),
    );
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing src/domain/ledger` — Expected: FAIL (modules
      `./ledger.ids.js`, `./ledger.types.js`, … not found).

- [ ] **Step 3: Dependency.** `domains/billing/package.json` `dependencies`: add `"uuid": "catalog:"`
      (catalog `uuid` 14.0.3, ESM with bundled types). **Controller: `bun install`** in this worktree; continue
      when it reports success.

- [ ] **Step 4: Implement.** `domains/billing/src/domain/ledger/ledger.types.ts`:

```ts
/** Tenant id of platform-level rows (payouts, unattributed fees). B2 never issues the nil UUID. */
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
/** uuidv5 namespace of every ledger id. A code constant, never env: changing it re-keys the ledger. */
export const LEDGER_NAMESPACE = '9402cabc-4fa0-4891-9ed1-389e5828479d';

export type LedgerAccountCode =
  | 'asset:stripe_balance'
  | 'asset:bank'
  | 'revenue:checkout'
  | 'contra_revenue:refunds'
  | 'contra_revenue:disputes'
  | 'expense:stripe_fees'
  | 'expense:dispute_fees'
  | 'equity:adjustments';

export type LedgerAccountKind =
  'asset' | 'liability' | 'equity' | 'revenue' | 'contra_revenue' | 'expense';

/** Chart of accounts (spec 2.3): Stripe Checkout, one Stripe account, the platform sells to tenants. */
export const LEDGER_CHART: Readonly<
  Record<
    LedgerAccountCode,
    { readonly kind: LedgerAccountKind; readonly owner: 'platform' | 'tenant' }
  >
> = {
  'asset:stripe_balance': { kind: 'asset', owner: 'platform' },
  'asset:bank': { kind: 'asset', owner: 'platform' },
  'revenue:checkout': { kind: 'revenue', owner: 'tenant' },
  'contra_revenue:refunds': { kind: 'contra_revenue', owner: 'tenant' },
  'contra_revenue:disputes': { kind: 'contra_revenue', owner: 'tenant' },
  'expense:stripe_fees': { kind: 'expense', owner: 'platform' },
  'expense:dispute_fees': { kind: 'expense', owner: 'platform' },
  'equity:adjustments': { kind: 'equity', owner: 'platform' },
};

export type LedgerEntryKind =
  | 'charge'
  | 'refund'
  | 'refund_failure'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'payout_failure'
  | 'stripe_fee'
  | 'adjustment';

export interface LedgerLine {
  readonly account: LedgerAccountCode;
  /** The entry's tenant for tenant accounts, `PLATFORM_TENANT_ID` for platform accounts. */
  readonly accountOwnerTenantId: string;
  /** Lowercase ISO 4217 (Stripe's settlement currency of the balance transaction). */
  readonly currency: string;
  /** Minor units; exactly one of debit/credit is > 0n. */
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface LedgerEntryDraft {
  /** Origin, e.g. `stripe:txn:txn_…`; the entry id is derived from it. */
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  /** What the customer paid, in presentment currency (reconciliation R3); null when n/a. */
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly occurredAt: Date;
  readonly lines: readonly LedgerLine[];
}

export type LedgerPostOutcome =
  | {
      readonly status: 'posted';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly immudbTxId: bigint;
    }
  | { readonly status: 'replayed'; readonly entryId: string; readonly payloadHash: string }
  | {
      readonly status: 'conflict';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly existingPayloadHash: string;
    };

export interface LedgerPosting {
  readonly line: number;
  readonly accountId: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface LedgerEntry {
  readonly id: string;
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly payloadHash: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly postings: readonly LedgerPosting[];
}

export interface LedgerBalance {
  readonly accountId: string;
  /** `null` when the id matches no chart account of the tenant or the platform in that currency. */
  readonly account: LedgerAccountCode | null;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

/** An entry whose postings do not balance in `currency`, or (`currency: null`) has < 2 postings. */
export interface LedgerImbalance {
  readonly entryId: string;
  readonly currency: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly postings: number;
}

/** A verified immudb state kept outside immudb (Postgres, wave 2) for tamper evidence (R5). */
export interface LedgerTrustedState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
}
```

`domains/billing/src/domain/ledger/ledger.ids.ts`:

```ts
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { LEDGER_NAMESPACE, type LedgerAccountCode, type LedgerEntryDraft } from './ledger.types.js';

/** The idempotency key of an entry: same source → same id → a replay can never post twice. */
export function ledgerEntryId(sourceKey: string): string {
  return uuidv5(sourceKey, LEDGER_NAMESPACE);
}

export function ledgerAccountId(
  ownerTenantId: string,
  account: LedgerAccountCode,
  currency: string,
): string {
  return uuidv5(`account:${ownerTenantId}:${account}:${currency}`, LEDGER_NAMESPACE);
}

export function toEpochMicros(at: Date): bigint {
  return BigInt(at.getTime()) * 1_000n;
}

/** Sorted keys at every level, bigints as decimal strings, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`cannot canonicalise a ${typeof value}`);
}

/** sha256 hex over the canonical entry (spec 2.5); `recordedAt` is excluded so replays match. */
export function ledgerPayloadHash(draft: LedgerEntryDraft): string {
  const payload = {
    sourceKey: draft.sourceKey,
    tenantId: draft.tenantId,
    kind: draft.kind,
    paymentId: draft.paymentId,
    stripeObject: draft.stripeObjectId,
    presentment: draft.presentment,
    occurredAtUs: toEpochMicros(draft.occurredAt),
    lines: draft.lines.map((line) => ({
      accountId: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
      currency: line.currency,
      debit: line.debit,
      credit: line.credit,
    })),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
```

`domains/billing/src/domain/ledger/ledger.errors.ts`:

```ts
import { BusinessRuleViolationException, ExternalServiceException } from '@platform/common';
import { BillingErrorCode } from '../../billing.constants.js';

/** A draft that violates the double-entry rules: a programming error, never retried. */
export class LedgerUnbalancedException extends BusinessRuleViolationException {
  constructor(
    readonly sourceKey: string,
    readonly problems: readonly string[],
  ) {
    super(`Ledger entry ${sourceKey} is invalid: ${problems.join('; ')}`, {
      code: BillingErrorCode.LEDGER_ENTRY_INVALID,
      details: { sourceKey, problems: [...problems] },
    });
  }
}

/** A ledger row did not verify against the trusted state (tamper evidence; page someone). */
export class LedgerVerificationFailedException extends ExternalServiceException {
  constructor(entryId: string, reason: string, cause?: unknown) {
    super(`Ledger entry ${entryId} failed verification: ${reason}`, {
      code: BillingErrorCode.LEDGER_VERIFICATION_FAILED,
      cause,
      details: { entryId },
    });
  }
}
```

`domains/billing/src/billing.constants.ts` `BillingErrorCode`: add

```ts
  /** A ledger draft violates the double-entry rules (programming error; never retried). */
  LEDGER_ENTRY_INVALID: 'LEDGER_ENTRY_INVALID',
  /** A ledger row failed proof verification against the trusted state. */
  LEDGER_VERIFICATION_FAILED: 'LEDGER_VERIFICATION_FAILED',
```

`domains/billing/src/domain/ledger/ledger.invariant.ts`:

```ts
import { LedgerUnbalancedException } from './ledger.errors.js';
import { LEDGER_CHART, type LedgerEntryDraft, PLATFORM_TENANT_ID } from './ledger.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[a-z]{3}$/;

/**
 * The double-entry rules, checked in TypeScript before any I/O (immudb enforces no CHECK): at least
 * two lines, each with exactly one positive side, lowercase ISO currencies, accounts owned by the
 * entry tenant or the platform as the chart says, and Σdebit = Σcredit per currency.
 */
export function assertBalanced(draft: LedgerEntryDraft): void {
  const problems: string[] = [];
  if (draft.sourceKey.length === 0 || draft.sourceKey.length > 128) {
    problems.push('sourceKey must be 1-128 characters');
  }
  if (!UUID.test(draft.tenantId)) problems.push('tenantId must be a lowercase UUID');
  if (draft.paymentId !== null && !UUID.test(draft.paymentId)) {
    problems.push('paymentId must be a lowercase UUID or null');
  }
  if (
    draft.stripeObjectId !== null &&
    (draft.stripeObjectId.length === 0 || draft.stripeObjectId.length > 64)
  ) {
    problems.push('stripeObjectId must be 1-64 characters or null');
  }
  if (
    draft.presentment !== null &&
    (draft.presentment.amount < 0n || !CURRENCY.test(draft.presentment.currency))
  ) {
    problems.push('presentment must have a non-negative amount and a lowercase ISO 4217 currency');
  }
  if (draft.lines.length < 2) problems.push('an entry needs at least 2 lines');
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  draft.lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (line.debit < 0n || line.credit < 0n) problems.push(`${at}: negative amount`);
    if (line.debit > 0n === line.credit > 0n) {
      problems.push(`${at}: exactly one of debit or credit must be > 0`);
    }
    if (!CURRENCY.test(line.currency)) {
      problems.push(`${at}: currency must be a lowercase ISO 4217 code`);
    }
    const owner = LEDGER_CHART[line.account].owner;
    if (owner === 'platform' && line.accountOwnerTenantId !== PLATFORM_TENANT_ID) {
      problems.push(`${at}: ${line.account} must be owned by the platform`);
    }
    if (owner === 'tenant' && line.accountOwnerTenantId !== draft.tenantId) {
      problems.push(`${at}: ${line.account} must be owned by the entry tenant`);
    }
    const total = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
    totals.set(line.currency, {
      debit: total.debit + line.debit,
      credit: total.credit + line.credit,
    });
  });
  for (const [currency, { debit, credit }] of totals) {
    if (debit !== credit) problems.push(`${currency}: debit ${debit} ≠ credit ${credit}`);
  }
  if (problems.length > 0) throw new LedgerUnbalancedException(draft.sourceKey, problems);
}
```

`domains/billing/src/index.ts` (root barrel, after G-11's core/domain exports): add

```ts
// Ledger (model)
export * from './domain/ledger/ledger.errors.js';
export * from './domain/ledger/ledger.ids.js';
export * from './domain/ledger/ledger.invariant.js';
export * from './domain/ledger/ledger.types.js';
```

- [ ] **Step 5: Run the tests.** `npx vitest run --project billing src/domain/ledger` — Expected: PASS.
      `CHARGE_DRAFT` and `LEDGER_TEST_TENANT` live in `test/ledger-fixtures.ts` (a helper, not collected).

- [ ] **Step 6: Wider checks.** `npx biome check --write domains/billing`, `bun run check` (Expected:
      PASS), `npx vitest run --project billing` (Expected: PASS).

- [ ] **Step 7: Commit.**

```bash
git add domains/billing bun.lock
git commit -m "feat(billing): add the double-entry ledger model with deterministic ids and hashes" \
  -m "Chart of accounts, entry/posting/balance types, PLATFORM_TENANT_ID and the fixed
LEDGER_NAMESPACE, uuidv5 entry and account ids, a canonical-JSON sha256 payload hash pinned by a
golden value, and assertBalanced (two or more lines, one positive side each, chart ownership,
per-currency balance)."
```

### Task L-8b: posting rules, `LedgerPort`, `InMemoryLedger` and the shared contract spec

**Files:**

- Create: `domains/billing/src/domain/ledger/ledger.accounts.ts`,
  `domains/billing/src/application/ledger/posting-rules.ts`,
  `domains/billing/src/application/ports/ledger.port.ts`, `domains/billing/src/testing/in-memory-ledger.ts`,
  `domains/billing/src/testing/ledger.contract.test.ts` (helper: not collected by Vitest, not built by SWC)
- Modify or create: `domains/billing/src/testing/index.ts`; `domains/billing/package.json`
  (`exports["./testing"]` if G-11 did not add it); `domains/billing/src/index.ts`
- Test: `domains/billing/src/application/ledger/posting-rules.spec.ts`,
  `domains/billing/src/testing/in-memory-ledger.spec.ts`

**Interfaces:**

- Consumes: L-8a model.
- Produces:

```ts
// @domain/billing (root barrel)
export function resolveLedgerAccount(
  accountId: string,
  tenantId: string,
  currency: string,
): LedgerAccountCode | null;
export type PostingBalanceTransaction = Pick<
  Stripe.BalanceTransaction,
  'id' | 'amount' | 'fee' | 'currency' | 'created' | 'reporting_category' | 'source'
>;
export interface PostingContext {
  readonly tenantId: string;
  readonly paymentId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
}
export function ledgerKindOf(reportingCategory: string): LedgerEntryKind;
export function draftFromBalanceTransaction(
  txn: PostingBalanceTransaction,
  context: PostingContext,
): LedgerEntryDraft | null;
export abstract class LedgerPort {
  abstract post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome>;
  abstract getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null>;
  abstract balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]>;
  abstract findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]>;
  abstract totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  >;
  abstract findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]>;
  abstract verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void>;
  abstract advanceTrustedState(trusted: LedgerTrustedState | null): Promise<LedgerTrustedState>;
}
// @domain/billing/testing
export class InMemoryLedger extends LedgerPort {
  constructor(now?: () => Date);
}
// domains/billing/src/testing/ledger.contract.test.ts (relative import only)
export interface LedgerUnderTest {
  readonly ledger: LedgerPort;
  readonly close?: () => Promise<void>;
}
export function describeLedgerContract(name: string, make: () => Promise<LedgerUnderTest>): void;
```

Posting rules (spec 2.4), one entry per balance transaction, `sourceKey = stripe:txn:<id>`, amounts in the
settlement currency (`txn.currency`), presentment from the context. Kind by `reporting_category`: `charge`
→ charge, `refund` → refund, `refund_failure` → refund_failure, `dispute` → dispute, `dispute_reversal`
→ dispute_reversal, `payout` → payout, `payout_reversal` → payout_failure, `fee` → stripe_fee, anything
else → adjustment. Counter account: charge `revenue:checkout`; refund/refund_failure
`contra_revenue:refunds`; dispute/dispute_reversal `contra_revenue:disputes`; payout/payout_failure
`asset:bank`; stripe_fee `expense:stripe_fees`; adjustment `equity:adjustments`. Amount > 0: D
`asset:stripe_balance`, C counter; amount < 0: D counter, C `asset:stripe_balance`. Fee (account
`expense:dispute_fees` for disputes, else `expense:stripe_fees`) > 0: D fee account, C
`asset:stripe_balance`; < 0: reversed. Payout, payout_failure, stripe_fee and adjustment are platform-level
(`PLATFORM_TENANT_ID`, no payment, no presentment). Zero amount and zero fee → `null` (nothing moves). The
dispute row of spec 2.4 ("C stripe_balance abs(amount)+fee") is posted as two credit lines with the same
totals.

**Wave:** after L-8a. `InMemoryLedger` goes to `@domain/billing/testing` (imported only by specs, `test/**`
and `src/testing/**`); `ledger.contract.test.ts` is never re-exported (SWC ignores `*.test.ts`, so a
re-export would break `dist/testing/index.js`).

- [ ] **Step 1: Write the failing tests.** `domains/billing/src/application/ledger/posting-rules.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LEDGER_TEST_TENANT as TENANT } from '../../../test/ledger-fixtures.js';
import { assertBalanced } from '../../domain/ledger/ledger.invariant.js';
import { type LedgerLine, PLATFORM_TENANT_ID } from '../../domain/ledger/ledger.types.js';
import {
  draftFromBalanceTransaction,
  ledgerKindOf,
  type PostingBalanceTransaction,
  type PostingContext,
} from './posting-rules.js';

const PAYMENT = '0192f0c1-0000-7000-8000-0000000000aa';
const context: PostingContext = {
  tenantId: TENANT,
  paymentId: PAYMENT,
  presentment: { amount: 2_500n, currency: 'usd' },
};
const txn = (overrides: Partial<PostingBalanceTransaction>): PostingBalanceTransaction => ({
  id: 'txn_1',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: 1_794_182_400,
  reporting_category: 'charge',
  source: 'ch_1',
  ...overrides,
});
const P = PLATFORM_TENANT_ID;
const l = (
  account: LedgerLine['account'],
  owner: string,
  debit: bigint,
  credit: bigint,
): LedgerLine => ({
  account,
  accountOwnerTenantId: owner,
  currency: 'usd',
  debit,
  credit,
});

describe('posting rules', () => {
  it.each([
    ['charge', 'charge'],
    ['refund', 'refund'],
    ['refund_failure', 'refund_failure'],
    ['dispute', 'dispute'],
    ['dispute_reversal', 'dispute_reversal'],
    ['payout', 'payout'],
    ['payout_reversal', 'payout_failure'],
    ['fee', 'stripe_fee'],
    ['other_adjustment', 'adjustment'],
  ])('reporting_category %s → %s', (category, kind) => {
    expect(ledgerKindOf(category)).toBe(kind);
  });

  it.each<[string, Partial<PostingBalanceTransaction>, string, LedgerLine[]]>([
    [
      'charge',
      {},
      TENANT,
      [
        l('asset:stripe_balance', P, 2_500n, 0n),
        l('revenue:checkout', TENANT, 0n, 2_500n),
        l('expense:stripe_fees', P, 103n, 0n),
        l('asset:stripe_balance', P, 0n, 103n),
      ],
    ],
    [
      'refund',
      { reporting_category: 'refund', amount: -1_000, fee: 0, source: 're_1' },
      TENANT,
      [l('contra_revenue:refunds', TENANT, 1_000n, 0n), l('asset:stripe_balance', P, 0n, 1_000n)],
    ],
    [
      'refund failure',
      { reporting_category: 'refund_failure', amount: 1_000, fee: 0 },
      TENANT,
      [l('asset:stripe_balance', P, 1_000n, 0n), l('contra_revenue:refunds', TENANT, 0n, 1_000n)],
    ],
    [
      'dispute',
      { reporting_category: 'dispute', amount: -2_500, fee: 1_500, source: 'du_1' },
      TENANT,
      [
        l('contra_revenue:disputes', TENANT, 2_500n, 0n),
        l('asset:stripe_balance', P, 0n, 2_500n),
        l('expense:dispute_fees', P, 1_500n, 0n),
        l('asset:stripe_balance', P, 0n, 1_500n),
      ],
    ],
    [
      'dispute reversal with the fee refunded',
      { reporting_category: 'dispute_reversal', amount: 2_500, fee: -1_500 },
      TENANT,
      [
        l('asset:stripe_balance', P, 2_500n, 0n),
        l('contra_revenue:disputes', TENANT, 0n, 2_500n),
        l('asset:stripe_balance', P, 1_500n, 0n),
        l('expense:dispute_fees', P, 0n, 1_500n),
      ],
    ],
    [
      'payout',
      { reporting_category: 'payout', amount: -10_000, fee: 0, source: 'po_1' },
      P,
      [l('asset:bank', P, 10_000n, 0n), l('asset:stripe_balance', P, 0n, 10_000n)],
    ],
    [
      'payout reversal',
      { reporting_category: 'payout_reversal', amount: 10_000, fee: 0 },
      P,
      [l('asset:stripe_balance', P, 10_000n, 0n), l('asset:bank', P, 0n, 10_000n)],
    ],
    [
      'stripe fee',
      { reporting_category: 'fee', amount: -200, fee: 0, source: null },
      P,
      [l('expense:stripe_fees', P, 200n, 0n), l('asset:stripe_balance', P, 0n, 200n)],
    ],
    [
      'adjustment',
      { reporting_category: 'other_adjustment', amount: 50, fee: 0 },
      P,
      [l('asset:stripe_balance', P, 50n, 0n), l('equity:adjustments', P, 0n, 50n)],
    ],
  ])('%s', (_name, overrides, tenantId, lines) => {
    const draft = draftFromBalanceTransaction(txn(overrides), context);
    expect(draft).not.toBeNull();
    expect(draft?.tenantId).toBe(tenantId);
    expect(draft?.lines).toEqual(lines);
    if (draft !== null) expect(() => assertBalanced(draft)).not.toThrow();
  });

  it('carries the source, the payment and the presentment for tenant entries only', () => {
    expect(draftFromBalanceTransaction(txn({}), context)).toMatchObject({
      sourceKey: 'stripe:txn:txn_1',
      kind: 'charge',
      paymentId: PAYMENT,
      stripeObjectId: 'ch_1',
      presentment: { amount: 2_500n, currency: 'usd' },
      occurredAt: new Date('2026-11-09T00:00:00.000Z'),
    });
    expect(
      draftFromBalanceTransaction(
        txn({ reporting_category: 'payout', amount: -5, fee: 0, source: { id: 'po_9' } as never }),
        context,
      ),
    ).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      paymentId: null,
      presentment: null,
      stripeObjectId: 'po_9',
    });
  });

  it('posts nothing when no money moves', () => {
    expect(draftFromBalanceTransaction(txn({ amount: 0, fee: 0 }), context)).toBeNull();
  });
});
```

`domains/billing/src/testing/ledger.contract.test.ts`:

```ts
import { generateId } from '@platform/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftFromBalanceTransaction } from '../application/ledger/posting-rules.js';
import type { LedgerPort } from '../application/ports/ledger.port.js';
import {
  LedgerUnbalancedException,
  LedgerVerificationFailedException,
} from '../domain/ledger/ledger.errors.js';
import { ledgerEntryId, ledgerPayloadHash, toEpochMicros } from '../domain/ledger/ledger.ids.js';
import type { LedgerEntryDraft } from '../domain/ledger/ledger.types.js';

export interface LedgerUnderTest {
  readonly ledger: LedgerPort;
  readonly close?: () => Promise<void>;
}

/**
 * The behaviour every LedgerPort implementation shares (spec 6.4): run by the in-memory fake's unit
 * spec and by the immudb adapter's int spec. Each test uses fresh tenant and source ids, so a shared
 * database works.
 */
export function describeLedgerContract(name: string, make: () => Promise<LedgerUnderTest>): void {
  describe(`LedgerPort contract: ${name}`, () => {
    let subject: LedgerUnderTest;
    let tenantId: string;
    let txnId: string;

    const charge = (amount = 2_500, fee = 103): LedgerEntryDraft => {
      const draft = draftFromBalanceTransaction(
        {
          id: txnId,
          amount,
          fee,
          currency: 'usd',
          created: 1_794_182_400,
          reporting_category: 'charge',
          source: 'ch_contract',
        },
        {
          tenantId,
          paymentId: generateId(),
          presentment: { amount: BigInt(amount), currency: 'usd' },
        },
      );
      if (draft === null) throw new Error('charge posts nothing');
      return draft;
    };

    beforeEach(async () => {
      subject = await make();
      tenantId = generateId();
      txnId = `txn_${generateId().replaceAll('-', '')}`;
    });

    afterEach(async () => {
      await subject.close?.();
    });

    it('posts once, then replays the same draft and flags a different one as a conflict', async () => {
      const draft = charge();
      const posted = await subject.ledger.post(draft);
      expect(posted).toMatchObject({
        status: 'posted',
        entryId: ledgerEntryId(draft.sourceKey),
        payloadHash: ledgerPayloadHash(draft),
      });
      expect(posted.status === 'posted' && posted.immudbTxId > 0n).toBe(true);
      await expect(subject.ledger.post(draft)).resolves.toEqual({
        status: 'replayed',
        entryId: posted.entryId,
        payloadHash: posted.payloadHash,
      });
      const changed = charge(2_400);
      await expect(subject.ledger.post(changed)).resolves.toEqual({
        status: 'conflict',
        entryId: posted.entryId,
        payloadHash: ledgerPayloadHash(changed),
        existingPayloadHash: posted.payloadHash,
      });
      await expect(subject.ledger.getEntry(tenantId, posted.entryId)).resolves.toMatchObject({
        payloadHash: posted.payloadHash,
      });
    });

    it('rejects an unbalanced draft before writing anything', async () => {
      const draft = charge();
      const [first, ...rest] = draft.lines;
      if (first === undefined) throw new Error('no lines');
      const unbalanced = { ...draft, lines: [{ ...first, debit: first.debit + 1n }, ...rest] };
      await expect(subject.ledger.post(unbalanced)).rejects.toBeInstanceOf(
        LedgerUnbalancedException,
      );
      await expect(
        subject.ledger.getEntry(tenantId, ledgerEntryId(draft.sourceKey)),
      ).resolves.toBeNull();
    });

    it('lets exactly one of several concurrent posts of an entry win', async () => {
      const draft = charge();
      const outcomes = await Promise.all([1, 2, 3].map(() => subject.ledger.post(draft)));
      expect(outcomes.filter((o) => o.status === 'posted')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'replayed')).toHaveLength(2);
    });

    it('reads an entry only for its own tenant, with its postings in line order', async () => {
      const draft = charge();
      const posted = await subject.ledger.post(draft);
      const entry = await subject.ledger.getEntry(tenantId, posted.entryId);
      expect(entry).toMatchObject({
        id: posted.entryId,
        sourceKey: draft.sourceKey,
        tenantId,
        kind: 'charge',
        paymentId: draft.paymentId,
        stripeObjectId: 'ch_contract',
        presentment: { amount: 2_500n, currency: 'usd' },
        occurredAt: draft.occurredAt,
      });
      expect(entry?.postings.map((p) => [p.line, p.debit, p.credit])).toEqual([
        [1, 2_500n, 0n],
        [2, 0n, 2_500n],
        [3, 103n, 0n],
        [4, 0n, 103n],
      ]);
      await expect(subject.ledger.getEntry(generateId(), posted.entryId)).resolves.toBeNull();
    });

    it('sums balances per account for a tenant', async () => {
      await subject.ledger.post(charge());
      const balances = await subject.ledger.balances(tenantId, 'usd');
      const byAccount = Object.fromEntries(
        balances.map((b) => [b.account ?? b.accountId, [b.debit, b.credit]]),
      );
      expect(byAccount).toEqual({
        'asset:stripe_balance': [2_500n, 103n],
        'revenue:checkout': [0n, 2_500n],
        'expense:stripe_fees': [103n, 0n],
      });
      await expect(subject.ledger.balances(generateId())).resolves.toEqual([]);
    });

    it('finds nothing unbalanced or mutated and balances every currency globally', async () => {
      await subject.ledger.post(charge());
      const window = { fromUs: 0n, toUs: toEpochMicros(new Date(Date.now() + 60_000)) };
      await expect(subject.ledger.findUnbalanced(window)).resolves.toEqual([]);
      for (const total of await subject.ledger.totalsByCurrency()) {
        expect(total.debit).toBe(total.credit);
      }
      await expect(subject.ledger.findMutations()).resolves.toEqual([]);
    });

    it('verifies a posted entry against an advanced trusted state', async () => {
      const first = await subject.ledger.advanceTrustedState(null);
      const posted = await subject.ledger.post(charge());
      const trusted = await subject.ledger.advanceTrustedState(first);
      expect(trusted.txId).toBeGreaterThanOrEqual(first.txId);
      await expect(
        subject.ledger.verifyEntry(posted.entryId, posted.payloadHash, trusted),
      ).resolves.toBeUndefined();
      await expect(
        subject.ledger.verifyEntry(posted.entryId, '0'.repeat(64), trusted),
      ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
      // A trusted state the store never reached (rolled back or forked) fails closed in both.
      await expect(
        subject.ledger.verifyEntry(posted.entryId, posted.payloadHash, {
          ...trusted,
          txId: trusted.txId + 1_000n,
        }),
      ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    });
  });
}
```

`domains/billing/src/testing/in-memory-ledger.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LedgerVerificationFailedException } from '../domain/ledger/ledger.errors.js';
import { InMemoryLedger } from './in-memory-ledger.js';
import { describeLedgerContract } from './ledger.contract.test.js';

describeLedgerContract('InMemoryLedger', async () => ({ ledger: new InMemoryLedger() }));

describe('InMemoryLedger', () => {
  it('refuses a trusted state ahead of the ledger', async () => {
    const ledger = new InMemoryLedger();
    await expect(
      ledger.advanceTrustedState({ database: 'in-memory', txId: 5n, txHash: new Uint8Array(32) }),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing src/application/ledger src/testing` —
      Expected: FAIL (`./posting-rules.js`, `./in-memory-ledger.js` not found).

- [ ] **Step 3: Implement.** `domains/billing/src/domain/ledger/ledger.accounts.ts`:

```ts
import { ledgerAccountId } from './ledger.ids.js';
import { LEDGER_CHART, type LedgerAccountCode, PLATFORM_TENANT_ID } from './ledger.types.js';

const CODES = Object.keys(LEDGER_CHART) as LedgerAccountCode[];

/** Which chart account an id is, for `tenantId` (tenant accounts) or the platform, in `currency`. */
export function resolveLedgerAccount(
  accountId: string,
  tenantId: string,
  currency: string,
): LedgerAccountCode | null {
  for (const code of CODES) {
    const owner = LEDGER_CHART[code].owner === 'platform' ? PLATFORM_TENANT_ID : tenantId;
    if (ledgerAccountId(owner, code, currency) === accountId) return code;
  }
  return null;
}
```

`domains/billing/src/application/ledger/posting-rules.ts`:

```ts
import type Stripe from 'stripe';
import {
  type LedgerAccountCode,
  type LedgerEntryDraft,
  type LedgerEntryKind,
  type LedgerLine,
  PLATFORM_TENANT_ID,
  LEDGER_CHART,
} from '../../domain/ledger/ledger.types.js';

export type PostingBalanceTransaction = Pick<
  Stripe.BalanceTransaction,
  'id' | 'amount' | 'fee' | 'currency' | 'created' | 'reporting_category' | 'source'
>;

export interface PostingContext {
  readonly tenantId: string;
  readonly paymentId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
}

const KIND_BY_CATEGORY: Readonly<Record<string, LedgerEntryKind>> = {
  charge: 'charge',
  refund: 'refund',
  refund_failure: 'refund_failure',
  dispute: 'dispute',
  dispute_reversal: 'dispute_reversal',
  payout: 'payout',
  payout_reversal: 'payout_failure',
  fee: 'stripe_fee',
};

const COUNTER_ACCOUNT: Readonly<Record<LedgerEntryKind, LedgerAccountCode>> = {
  charge: 'revenue:checkout',
  refund: 'contra_revenue:refunds',
  refund_failure: 'contra_revenue:refunds',
  dispute: 'contra_revenue:disputes',
  dispute_reversal: 'contra_revenue:disputes',
  payout: 'asset:bank',
  payout_failure: 'asset:bank',
  stripe_fee: 'expense:stripe_fees',
  adjustment: 'equity:adjustments',
};

const PLATFORM_KINDS: readonly LedgerEntryKind[] = [
  'payout',
  'payout_failure',
  'stripe_fee',
  'adjustment',
];

export function ledgerKindOf(reportingCategory: string): LedgerEntryKind {
  return KIND_BY_CATEGORY[reportingCategory] ?? 'adjustment';
}

/**
 * One ledger entry per Stripe balance transaction (spec 2.4). Amounts are the balance
 * transaction's (settlement currency); fees come only from it. `null` when no money moves.
 */
export function draftFromBalanceTransaction(
  txn: PostingBalanceTransaction,
  context: PostingContext,
): LedgerEntryDraft | null {
  const amount = BigInt(txn.amount);
  const fee = BigInt(txn.fee);
  if (amount === 0n && fee === 0n) return null;
  const kind = ledgerKindOf(txn.reporting_category);
  const platformLevel = PLATFORM_KINDS.includes(kind);
  const tenantId = platformLevel ? PLATFORM_TENANT_ID : context.tenantId;
  const currency = txn.currency.toLowerCase();
  const line = (account: LedgerAccountCode, debit: bigint, credit: bigint): LedgerLine => ({
    account,
    accountOwnerTenantId:
      LEDGER_CHART[account].owner === 'platform' ? PLATFORM_TENANT_ID : tenantId,
    currency,
    debit,
    credit,
  });
  const pair = (counter: LedgerAccountCode, signed: bigint): LedgerLine[] =>
    signed > 0n
      ? [line('asset:stripe_balance', signed, 0n), line(counter, 0n, signed)]
      : [line(counter, -signed, 0n), line('asset:stripe_balance', 0n, -signed)];
  const feeAccount: LedgerAccountCode =
    kind === 'dispute' || kind === 'dispute_reversal'
      ? 'expense:dispute_fees'
      : 'expense:stripe_fees';
  const lines = [
    ...(amount === 0n ? [] : pair(COUNTER_ACCOUNT[kind], amount)),
    // A fee is money leaving the balance: the mirror image of an amount.
    ...(fee === 0n ? [] : pair(feeAccount, -fee)),
  ];
  const source = txn.source;
  return {
    sourceKey: `stripe:txn:${txn.id}`,
    tenantId,
    kind,
    paymentId: platformLevel ? null : context.paymentId,
    stripeObjectId: source === null ? null : typeof source === 'string' ? source : source.id,
    presentment: platformLevel ? null : context.presentment,
    occurredAt: new Date(txn.created * 1_000),
    lines,
  };
}
```

`domains/billing/src/application/ports/ledger.port.ts`:

```ts
import type {
  LedgerBalance,
  LedgerEntry,
  LedgerEntryDraft,
  LedgerImbalance,
  LedgerPostOutcome,
  LedgerTrustedState,
} from '../../domain/ledger/ledger.types.js';

/**
 * The append-only double-entry ledger (immudb in production, `InMemoryLedger` in tests). Every
 * tenant read takes the tenant explicitly; cross-tenant reads (`findUnbalanced`,
 * `totalsByCurrency`, `findMutations`) are reconciliation-only (system context, wave 2).
 */
export abstract class LedgerPort {
  /** Validates (`assertBalanced`) before any I/O; idempotent by `ledgerEntryId(sourceKey)`. */
  abstract post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome>;
  abstract getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null>;
  abstract balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]>;
  abstract findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]>;
  abstract totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  >;
  abstract findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]>;
  /** @throws LedgerVerificationFailedException */
  abstract verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void>;
  /** @throws LedgerVerificationFailedException when the store is not consistent with `trusted`. */
  abstract advanceTrustedState(trusted: LedgerTrustedState | null): Promise<LedgerTrustedState>;
}
```

`domains/billing/src/testing/in-memory-ledger.ts`:

```ts
import { createHash } from 'node:crypto';
import { LedgerPort } from '../application/ports/ledger.port.js';
import { resolveLedgerAccount } from '../domain/ledger/ledger.accounts.js';
import { LedgerVerificationFailedException } from '../domain/ledger/ledger.errors.js';
import {
  ledgerAccountId,
  ledgerEntryId,
  ledgerPayloadHash,
  toEpochMicros,
} from '../domain/ledger/ledger.ids.js';
import { assertBalanced } from '../domain/ledger/ledger.invariant.js';
import type {
  LedgerBalance,
  LedgerEntry,
  LedgerEntryDraft,
  LedgerImbalance,
  LedgerPostOutcome,
  LedgerTrustedState,
} from '../domain/ledger/ledger.types.js';

/** `LedgerPort` in memory, with the same ids, hashes, replay/conflict and balance semantics. */
export class InMemoryLedger extends LedgerPort {
  private readonly entries = new Map<string, LedgerEntry>();
  private chain = new Uint8Array(32);
  private txId = 0n;

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  override async post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome> {
    assertBalanced(draft);
    const entryId = ledgerEntryId(draft.sourceKey);
    const payloadHash = ledgerPayloadHash(draft);
    const existing = this.entries.get(entryId);
    if (existing !== undefined) {
      return existing.payloadHash === payloadHash
        ? { status: 'replayed', entryId, payloadHash }
        : { status: 'conflict', entryId, payloadHash, existingPayloadHash: existing.payloadHash };
    }
    this.entries.set(entryId, {
      id: entryId,
      sourceKey: draft.sourceKey,
      tenantId: draft.tenantId,
      kind: draft.kind,
      paymentId: draft.paymentId,
      stripeObjectId: draft.stripeObjectId,
      presentment: draft.presentment,
      payloadHash,
      occurredAt: draft.occurredAt,
      recordedAt: this.now(),
      postings: draft.lines.map((line, i) => ({
        line: i + 1,
        accountId: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
        currency: line.currency,
        debit: line.debit,
        credit: line.credit,
      })),
    });
    this.txId++;
    this.chain = new Uint8Array(
      createHash('sha256').update(this.chain).update(payloadHash).digest(),
    );
    return { status: 'posted', entryId, payloadHash, immudbTxId: this.txId };
  }

  override async getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null> {
    const entry = this.entries.get(entryId);
    return entry?.tenantId === tenantId ? entry : null;
  }

  override async balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]> {
    const sums = new Map<string, LedgerBalance>();
    for (const entry of this.entries.values()) {
      if (entry.tenantId !== tenantId) continue;
      for (const p of entry.postings) {
        if (currency !== undefined && p.currency !== currency) continue;
        const key = `${p.accountId}:${p.currency}`;
        const sum = sums.get(key) ?? {
          accountId: p.accountId,
          account: resolveLedgerAccount(p.accountId, tenantId, p.currency),
          currency: p.currency,
          debit: 0n,
          credit: 0n,
        };
        sums.set(key, { ...sum, debit: sum.debit + p.debit, credit: sum.credit + p.credit });
      }
    }
    return [...sums.values()];
  }

  override async findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]> {
    const found: LedgerImbalance[] = [];
    for (const entry of this.entries.values()) {
      const at = toEpochMicros(entry.recordedAt);
      if (at < window.fromUs || at >= window.toUs) continue;
      if (entry.postings.length < 2) {
        found.push({
          entryId: entry.id,
          currency: null,
          debit: 0n,
          credit: 0n,
          postings: entry.postings.length,
        });
        continue;
      }
      const byCurrency = new Map<string, { debit: bigint; credit: bigint; postings: number }>();
      for (const p of entry.postings) {
        const sum = byCurrency.get(p.currency) ?? { debit: 0n, credit: 0n, postings: 0 };
        byCurrency.set(p.currency, {
          debit: sum.debit + p.debit,
          credit: sum.credit + p.credit,
          postings: sum.postings + 1,
        });
      }
      for (const [currency, sum] of byCurrency) {
        if (sum.debit !== sum.credit) found.push({ entryId: entry.id, currency, ...sum });
      }
    }
    return found;
  }

  override async totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  > {
    const totals = new Map<string, { currency: string; debit: bigint; credit: bigint }>();
    for (const entry of this.entries.values()) {
      for (const p of entry.postings) {
        const sum = totals.get(p.currency) ?? { currency: p.currency, debit: 0n, credit: 0n };
        totals.set(p.currency, {
          ...sum,
          debit: sum.debit + p.debit,
          credit: sum.credit + p.credit,
        });
      }
    }
    return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** Memory has no history: nothing is ever mutated. */
  override async findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return [];
  }

  override async verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void> {
    if (trusted.txId > this.txId) {
      throw new LedgerVerificationFailedException(entryId, 'trusted state is ahead of the ledger');
    }
    const entry = this.entries.get(entryId);
    if (entry === undefined) throw new LedgerVerificationFailedException(entryId, 'no such entry');
    if (entry.payloadHash !== expectedPayloadHash) {
      throw new LedgerVerificationFailedException(entryId, 'payload hash differs');
    }
  }

  override async advanceTrustedState(
    trusted: LedgerTrustedState | null,
  ): Promise<LedgerTrustedState> {
    if (trusted !== null && trusted.txId > this.txId) {
      throw new LedgerVerificationFailedException(
        'trusted-state',
        'trusted state is ahead of the ledger',
      );
    }
    return { database: 'in-memory', txId: this.txId, txHash: this.chain };
  }
}
```

`domains/billing/src/testing/index.ts`: if it exists, append `export * from './in-memory-ledger.js';`;
otherwise (G-11's target export map has no billing `./testing`) create it with that single line and add
to `domains/billing/package.json` `exports`, after the `"./api"` block (G placement rule: in-memory
fakes → `src/testing/index.ts`):

```json
    "./testing": {
      "@repo/source": "./src/testing/index.ts",
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    },
```

Root barrel `domains/billing/src/index.ts`, under the L-8a "Ledger (model)" block:

```ts
export * from './application/ledger/posting-rules.js';
export * from './application/ports/ledger.port.js';
export * from './domain/ledger/ledger.accounts.js';
```

- [ ] **Step 4: Run the tests.** `npx vitest run --project billing` — Expected: PASS (the contract runs
      7 tests against `InMemoryLedger`).

- [ ] **Step 5: Wider checks.** `npx biome check --write domains/billing`, `bun run check` — Expected: PASS
      (`check-boundaries` treats `src/testing/**` and `*.test.ts` as test code).

- [ ] **Step 6: Commit.**

```bash
git add domains/billing
git commit -m "feat(billing): add ledger posting rules, LedgerPort and the in-memory ledger" \
  -m "One draft per Stripe balance transaction (charge, refund, dispute, payout, fee, adjustment) with
fees from the balance transaction and platform-level entries on PLATFORM_TENANT_ID; LedgerPort
per the ledger spec; InMemoryLedger in @domain/billing/testing; describeLedgerContract shared
with the immudb adapter's int spec."
```

### Task L-9: `ImmudbLedgerAdapter`, `001_ledger.sql` and the contract int spec

**Files:**

- Create: `domains/billing/src/infrastructure/ledger/migrations/001_ledger.sql`,
  `domains/billing/src/infrastructure/ledger/billing-ledger.migrations.ts`,
  `domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.ts`
- Modify: `domains/billing/package.json` (`"@platform/immudb": "workspace:*"` in `dependencies`,
  `"testcontainers": "catalog:"` in `devDependencies`), `domains/billing/src/index.ts`,
  `domains/billing/README.md` (a "Ledger" section)
- Test: `domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.spec.ts`,
  `domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.int-spec.ts`

**Interfaces:**

- Consumes: L-2b/L-3/L-5 `ImmudbClient`, `ImmudbModule`, `ImmudbError`, `ImmudbMigrationSource`,
  `RecordingImmudbClient` (`@platform/immudb/testing`); L-8a/L-8b model, `LedgerPort`,
  `describeLedgerContract`.
- Produces (root barrel):

```ts
export const billingLedgerMigrations: ImmudbMigrationSource; // { name: 'billing-ledger', dir: <…>/migrations }
export const LEDGER_SQL: { readonly [statement: string]: string };
export const LEDGER_TENANT_READS: readonly string[]; // every LEDGER_SQL key that reads tenant data
export class ImmudbLedgerAdapter extends LedgerPort {
  constructor(immudb: ImmudbClient);
}
```

Not wired into `BillingCoreModule` yet (`LEDGER_ENABLED`, the consumer and the app modules come in L-12).
Rules from the spec (A1, 2.5): validate before I/O; one `ReadWrite` tx: select the entry's hash →
`replayed` / `conflict` (no write, rolled back) or ensure accounts + insert entry + postings → `posted`
with the commit's tx id; `read-conflict` and `duplicate-key` retry up to 5 times with jitter (the retry
sees the winner's row). Nulls are stored as `''` (strings) and `0` (amounts): ledger columns are never
NULL. Times are `INTEGER` epoch microseconds. Every tenant read carries `tenant_id = @tenant`.

**Wave:** after L-3, L-5 and L-8b.

- [ ] **Step 1: Write the failing unit test.**
      `domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.spec.ts`:

```ts
import { ImmudbError, type ImmudbTx } from '@platform/immudb';
import { RecordingImmudbClient, type RecordedStatement } from '@platform/immudb/testing';
import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import {
  LedgerUnbalancedException,
  LedgerVerificationFailedException,
} from '../../domain/ledger/ledger.errors.js';
import { ledgerEntryId, ledgerPayloadHash } from '../../domain/ledger/ledger.ids.js';
import { ImmudbLedgerAdapter, LEDGER_SQL, LEDGER_TENANT_READS } from './immudb-ledger.adapter.js';

const ENTRY_ID = ledgerEntryId(CHARGE_DRAFT.sourceKey);
const HASH = ledgerPayloadHash(CHARGE_DRAFT);
const TRUSTED = { database: 'ledger', txId: 9n, txHash: new Uint8Array(32) };

describe('ImmudbLedgerAdapter', () => {
  it('posts accounts, the entry and its postings in one transaction', async () => {
    const client = new RecordingImmudbClient();
    const outcome = await new ImmudbLedgerAdapter(client).post(CHARGE_DRAFT);
    expect(outcome).toEqual({
      status: 'posted',
      entryId: ENTRY_ID,
      payloadHash: HASH,
      immudbTxId: 1n,
    });
    const sql = client.statements.map((s) => s.sql);
    expect(sql[0]).toBe(LEDGER_SQL.selectEntryHash);
    expect(sql.filter((s) => s === LEDGER_SQL.selectAccount)).toHaveLength(3);
    expect(sql.filter((s) => s === LEDGER_SQL.insertAccount)).toHaveLength(3);
    expect(sql.filter((s) => s === LEDGER_SQL.insertEntry)).toHaveLength(1);
    const postings = client.statements.filter((s) => s.sql === LEDGER_SQL.insertPosting);
    expect(postings.map((s) => [s.params['line'], s.params['debit'], s.params['credit']])).toEqual([
      [1n, 2_500n, 0n],
      [2n, 0n, 2_500n],
      [3n, 103n, 0n],
      [4n, 0n, 103n],
    ]);
    expect(postings.every((s) => s.params['tenant_id'] === CHARGE_DRAFT.tenantId)).toBe(true);
    const entry = client.statements.find((s) => s.sql === LEDGER_SQL.insertEntry);
    expect(entry?.params).toMatchObject({
      id: ENTRY_ID,
      payload_hash: HASH,
      payment_id: CHARGE_DRAFT.paymentId,
      presentment_amount: 2_500n,
      occurred_at_us: 1_794_182_400_000_000n,
      schema_version: 1n,
    });
  });

  it('replays the same hash and reports a different one as a conflict, writing nothing', async () => {
    for (const [stored, status] of [
      [HASH, 'replayed'],
      ['f'.repeat(64), 'conflict'],
    ] as const) {
      const client = new RecordingImmudbClient((s: RecordedStatement) =>
        s.sql === LEDGER_SQL.selectEntryHash ? [{ payload_hash: stored }] : [],
      );
      await expect(new ImmudbLedgerAdapter(client).post(CHARGE_DRAFT)).resolves.toMatchObject({
        status,
      });
      expect(client.statements.filter((s) => s.kind === 'exec')).toEqual([]);
    }
  });

  it('retries a read conflict in a new transaction', async () => {
    class FlakyClient extends RecordingImmudbClient {
      private failures = 1;
      override async readWrite<T>(
        work: (tx: ImmudbTx) => Promise<T>,
      ): Promise<{ result: T; txId: bigint | null }> {
        if (this.failures-- > 0) throw new ImmudbError('read-conflict', 'tx read conflict');
        return super.readWrite(work);
      }
    }
    await expect(
      new ImmudbLedgerAdapter(new FlakyClient()).post(CHARGE_DRAFT),
    ).resolves.toMatchObject({
      status: 'posted',
    });
  });

  it('rejects an invalid draft before any statement', async () => {
    const client = new RecordingImmudbClient();
    await expect(
      new ImmudbLedgerAdapter(client).post({
        ...CHARGE_DRAFT,
        lines: CHARGE_DRAFT.lines.slice(0, 1),
      }),
    ).rejects.toBeInstanceOf(LedgerUnbalancedException);
    expect(client.statements).toEqual([]);
  });

  it('every tenant read is scoped by tenant_id = @tenant', () => {
    expect(LEDGER_TENANT_READS.length).toBeGreaterThan(0);
    for (const key of LEDGER_TENANT_READS) expect(LEDGER_SQL[key]).toContain('tenant_id = @tenant');
  });

  it('verifies an entry row and its payload hash', async () => {
    const ok = new RecordingImmudbClient((s) =>
      s.kind === 'verify' ? [{ id: ENTRY_ID, payload_hash: HASH }] : [],
    );
    await expect(
      new ImmudbLedgerAdapter(ok).verifyEntry(ENTRY_ID, HASH, TRUSTED),
    ).resolves.toBeUndefined();
    expect(ok.statements[0]).toMatchObject({
      sql: 'verifiedRow ledger_entries',
      params: { pk0: ENTRY_ID },
    });
    await expect(
      new ImmudbLedgerAdapter(ok).verifyEntry(ENTRY_ID, '0'.repeat(64), TRUSTED),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    const missing = new RecordingImmudbClient();
    await expect(
      new ImmudbLedgerAdapter(missing).verifyEntry(ENTRY_ID, HASH, TRUSTED),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project billing src/infrastructure/ledger` — Expected: FAIL
      (`./immudb-ledger.adapter.js` not found; `@platform/immudb` not a dependency yet).

- [ ] **Step 3: Dependencies.** `domains/billing/package.json`: `dependencies` add
      `"@platform/immudb": "workspace:*"`; `devDependencies` add `"testcontainers": "catalog:"`.
      **Controller: `bun install`**; continue when it reports success.

- [ ] **Step 4: Implement.** `domains/billing/src/infrastructure/ledger/migrations/001_ledger.sql` (spec 2.2;
      only `CREATE … IF NOT EXISTS`, as the migrator requires):

```sql
-- Ledger tables (append-only: the application user has SELECT and INSERT only).
-- Money: INTEGER (int64) minor units, always >= 0, direction by the debit/credit pair.
-- Times: INTEGER epoch microseconds. No PII: immudb cannot erase.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id              VARCHAR[36],  -- uuidv5(LEDGER_NAMESPACE, 'account:' || owner || ':' || code || ':' || currency)
  owner_tenant_id VARCHAR[36],  -- PLATFORM_TENANT_ID for platform accounts
  code            VARCHAR[64],
  currency        VARCHAR[3],
  kind            VARCHAR[16],
  created_at_us   INTEGER,
  PRIMARY KEY id
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                   VARCHAR[36],  -- uuidv5(LEDGER_NAMESPACE, source_key): the idempotency key
  source_key           VARCHAR[128],
  tenant_id            VARCHAR[36],
  kind                 VARCHAR[32],
  payment_id           VARCHAR[36],  -- '' when none
  stripe_object        VARCHAR[64],  -- '' when none
  presentment_amount   INTEGER,      -- 0 when none
  presentment_currency VARCHAR[3],   -- '' when none
  payload_hash         VARCHAR[64],
  occurred_at_us       INTEGER,
  recorded_at_us       INTEGER,
  schema_version       INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(recorded_at_us);
CREATE TABLE IF NOT EXISTS ledger_postings (
  id         VARCHAR[40],  -- entry_id || ':' || line
  entry_id   VARCHAR[36],
  line       INTEGER,
  tenant_id  VARCHAR[36],  -- = ledger_entries.tenant_id (tenant-scoped sums)
  account_id VARCHAR[36],
  currency   VARCHAR[3],
  debit      INTEGER,
  credit     INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_postings(entry_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(account_id);
```

`domains/billing/src/infrastructure/ledger/billing-ledger.migrations.ts`:

```ts
import { join } from 'node:path';
import type { ImmudbMigrationSource } from '@platform/immudb';

/** The ledger's immudb tables; apps pass it to `ImmudbModule.forRootAsync({ migrations })`. */
export const billingLedgerMigrations: ImmudbMigrationSource = {
  name: 'billing-ledger',
  dir: join(import.meta.dirname, 'migrations'),
};
```

`domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ImmudbClient, ImmudbError, type ImmudbState } from '@platform/immudb';
import { LedgerPort } from '../../application/ports/ledger.port.js';
import { resolveLedgerAccount } from '../../domain/ledger/ledger.accounts.js';
import { LedgerVerificationFailedException } from '../../domain/ledger/ledger.errors.js';
import {
  ledgerAccountId,
  ledgerEntryId,
  ledgerPayloadHash,
  toEpochMicros,
} from '../../domain/ledger/ledger.ids.js';
import { assertBalanced } from '../../domain/ledger/ledger.invariant.js';
import {
  LEDGER_CHART,
  type LedgerBalance,
  type LedgerEntry,
  type LedgerEntryDraft,
  type LedgerEntryKind,
  type LedgerImbalance,
  type LedgerPostOutcome,
  type LedgerTrustedState,
} from '../../domain/ledger/ledger.types.js';

const POST_ATTEMPTS = 5;
const SCHEMA_VERSION = 1n;

export const LEDGER_SQL = {
  selectEntryHash: 'SELECT payload_hash FROM ledger_entries WHERE id = @id',
  selectAccount: 'SELECT id FROM ledger_accounts WHERE id = @id',
  insertAccount:
    'INSERT INTO ledger_accounts (id, owner_tenant_id, code, currency, kind, created_at_us) VALUES (@id, @owner_tenant_id, @code, @currency, @kind, @created_at_us)',
  insertEntry:
    'INSERT INTO ledger_entries (id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us, schema_version) VALUES (@id, @source_key, @tenant_id, @kind, @payment_id, @stripe_object, @presentment_amount, @presentment_currency, @payload_hash, @occurred_at_us, @recorded_at_us, @schema_version)',
  insertPosting:
    'INSERT INTO ledger_postings (id, entry_id, line, tenant_id, account_id, currency, debit, credit) VALUES (@id, @entry_id, @line, @tenant_id, @account_id, @currency, @debit, @credit)',
  entryForTenant:
    'SELECT id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us FROM ledger_entries WHERE id = @id AND tenant_id = @tenant',
  postingsForTenant:
    'SELECT line, account_id, currency, debit, credit FROM ledger_postings WHERE entry_id = @entry_id AND tenant_id = @tenant',
  balancesForTenant:
    'SELECT account_id, currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings WHERE tenant_id = @tenant GROUP BY account_id, currency',
  balancesForTenantCurrency:
    'SELECT account_id, currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings WHERE tenant_id = @tenant AND currency = @currency GROUP BY account_id, currency',
  // Reconciliation reads (cross-tenant, system context in wave 2).
  entriesRecordedIn:
    'SELECT id FROM ledger_entries WHERE recorded_at_us >= @from_us AND recorded_at_us < @to_us',
  postingSumsByEntry:
    'SELECT entry_id, currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total, COUNT(*) AS postings FROM ledger_postings GROUP BY entry_id, currency',
  totalsByCurrency:
    'SELECT currency, SUM(debit) AS debit_total, SUM(credit) AS credit_total FROM ledger_postings GROUP BY currency',
  entriesHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_entries)',
  postingsHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_postings)',
  accountsHistory: 'SELECT id, _rev FROM (HISTORY OF ledger_accounts)',
} as const;

/** Keys of `LEDGER_SQL` that read tenant data: each must carry `tenant_id = @tenant`. */
export const LEDGER_TENANT_READS: readonly (keyof typeof LEDGER_SQL)[] = [
  'entryForTenant',
  'postingsForTenant',
  'balancesForTenant',
  'balancesForTenantCurrency',
];

type HashRow = { payload_hash: string };
type EntryRow = {
  id: string;
  source_key: string;
  tenant_id: string;
  kind: string;
  payment_id: string;
  stripe_object: string;
  presentment_amount: bigint;
  presentment_currency: string;
  payload_hash: string;
  occurred_at_us: bigint;
  recorded_at_us: bigint;
};
type PostingRow = {
  line: bigint;
  account_id: string;
  currency: string;
  debit: bigint;
  credit: bigint;
};
type SumRow = { account_id: string; currency: string; debit_total: bigint; credit_total: bigint };
type EntrySumRow = {
  entry_id: string;
  currency: string;
  debit_total: bigint;
  credit_total: bigint;
  postings: bigint;
};
type HistoryRow = { id: string; _rev: bigint };
type Unposted = Exclude<LedgerPostOutcome, { status: 'posted' }> | { status: 'pending' };

const fromMicros = (us: bigint): Date => new Date(Number(us / 1_000n));
const orNull = (value: string): string | null => (value === '' ? null : value);

function retryable(error: unknown): boolean {
  return (
    error instanceof ImmudbError &&
    (error.kind === 'read-conflict' || error.kind === 'duplicate-key')
  );
}

/** `LedgerPort` over immudb (spec 2.5). Tenancy is enforced here: immudb has no RLS. */
@Injectable()
export class ImmudbLedgerAdapter extends LedgerPort {
  constructor(private readonly immudb: ImmudbClient) {
    super();
  }

  override async post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome> {
    assertBalanced(draft);
    const entryId = ledgerEntryId(draft.sourceKey);
    const payloadHash = ledgerPayloadHash(draft);
    let lastError: unknown;
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
      try {
        return await this.postOnce(draft, entryId, payloadHash);
      } catch (error) {
        if (!retryable(error)) throw error;
        lastError = error;
        await sleep(Math.floor(Math.random() * 20 * attempt));
      }
    }
    throw lastError;
  }

  private async postOnce(
    draft: LedgerEntryDraft,
    entryId: string,
    payloadHash: string,
  ): Promise<LedgerPostOutcome> {
    const { result, txId } = await this.immudb.readWrite(async (tx): Promise<Unposted> => {
      const [existing] = await tx.query<HashRow>(LEDGER_SQL.selectEntryHash, { id: entryId });
      if (existing !== undefined) {
        return existing.payload_hash === payloadHash
          ? { status: 'replayed', entryId, payloadHash }
          : {
              status: 'conflict',
              entryId,
              payloadHash,
              existingPayloadHash: existing.payload_hash,
            };
      }
      const now = toEpochMicros(new Date());
      const accounts = new Map(
        draft.lines.map((line) => [
          ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
          line,
        ]),
      );
      for (const [id, line] of accounts) {
        const [known] = await tx.query(LEDGER_SQL.selectAccount, { id });
        if (known !== undefined) continue;
        await tx.exec(LEDGER_SQL.insertAccount, {
          id,
          owner_tenant_id: line.accountOwnerTenantId,
          code: line.account,
          currency: line.currency,
          kind: LEDGER_CHART[line.account].kind,
          created_at_us: now,
        });
      }
      await tx.exec(LEDGER_SQL.insertEntry, {
        id: entryId,
        source_key: draft.sourceKey,
        tenant_id: draft.tenantId,
        kind: draft.kind,
        payment_id: draft.paymentId ?? '',
        stripe_object: draft.stripeObjectId ?? '',
        presentment_amount: draft.presentment?.amount ?? 0n,
        presentment_currency: draft.presentment?.currency ?? '',
        payload_hash: payloadHash,
        occurred_at_us: toEpochMicros(draft.occurredAt),
        recorded_at_us: now,
        schema_version: SCHEMA_VERSION,
      });
      for (const [i, line] of draft.lines.entries()) {
        await tx.exec(LEDGER_SQL.insertPosting, {
          id: `${entryId}:${i + 1}`,
          entry_id: entryId,
          line: BigInt(i + 1),
          tenant_id: draft.tenantId,
          account_id: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
          currency: line.currency,
          debit: line.debit,
          credit: line.credit,
        });
      }
      return { status: 'pending' };
    });
    if (result.status !== 'pending') return result;
    if (txId === null) throw new Error(`immudb committed ledger entry ${entryId} without a tx id`);
    return { status: 'posted', entryId, payloadHash, immudbTxId: txId };
  }

  override getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null> {
    return this.immudb.readOnly(async (tx) => {
      const [row] = await tx.query<EntryRow>(LEDGER_SQL.entryForTenant, {
        id: entryId,
        tenant: tenantId,
      });
      if (row === undefined) return null;
      const postings = await tx.query<PostingRow>(LEDGER_SQL.postingsForTenant, {
        entry_id: entryId,
        tenant: tenantId,
      });
      return {
        id: row.id,
        sourceKey: row.source_key,
        tenantId: row.tenant_id,
        kind: row.kind as LedgerEntryKind,
        paymentId: orNull(row.payment_id),
        stripeObjectId: orNull(row.stripe_object),
        presentment:
          row.presentment_currency === ''
            ? null
            : { amount: row.presentment_amount, currency: row.presentment_currency },
        payloadHash: row.payload_hash,
        occurredAt: fromMicros(row.occurred_at_us),
        recordedAt: fromMicros(row.recorded_at_us),
        postings: postings
          .map((p) => ({
            line: Number(p.line),
            accountId: p.account_id,
            currency: p.currency,
            debit: p.debit,
            credit: p.credit,
          }))
          .sort((a, b) => a.line - b.line),
      };
    });
  }

  override balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]> {
    return this.immudb.readOnly(async (tx) => {
      const rows =
        currency === undefined
          ? await tx.query<SumRow>(LEDGER_SQL.balancesForTenant, { tenant: tenantId })
          : await tx.query<SumRow>(LEDGER_SQL.balancesForTenantCurrency, {
              tenant: tenantId,
              currency,
            });
      return rows.map((row) => ({
        accountId: row.account_id,
        account: resolveLedgerAccount(row.account_id, tenantId, row.currency),
        currency: row.currency,
        debit: row.debit_total,
        credit: row.credit_total,
      }));
    });
  }

  override findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]> {
    return this.immudb.readOnly(async (tx) => {
      const inWindow = await tx.query<{ id: string }>(LEDGER_SQL.entriesRecordedIn, {
        from_us: window.fromUs,
        to_us: window.toUs,
      });
      const sums = await tx.query<EntrySumRow>(LEDGER_SQL.postingSumsByEntry);
      const byEntry = Map.groupBy(sums, (row) => row.entry_id);
      const found: LedgerImbalance[] = [];
      for (const { id } of inWindow) {
        const rows = byEntry.get(id) ?? [];
        const postings = rows.reduce((n, row) => n + Number(row.postings), 0);
        if (postings < 2) {
          found.push({ entryId: id, currency: null, debit: 0n, credit: 0n, postings });
          continue;
        }
        for (const row of rows) {
          if (row.debit_total !== row.credit_total) {
            found.push({
              entryId: id,
              currency: row.currency,
              debit: row.debit_total,
              credit: row.credit_total,
              postings: Number(row.postings),
            });
          }
        }
      }
      return found;
    });
  }

  override totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  > {
    return this.immudb.readOnly(async (tx) =>
      (
        await tx.query<{ currency: string; debit_total: bigint; credit_total: bigint }>(
          LEDGER_SQL.totalsByCurrency,
        )
      )
        .map((row) => ({
          currency: row.currency,
          debit: row.debit_total,
          credit: row.credit_total,
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    );
  }

  /** Any row with a revision > 1 was updated or deleted: impossible for the INSERT-only user. */
  override findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return this.immudb.readOnly(async (tx) => {
      const found: { table: string; id: string; rev: bigint }[] = [];
      for (const [table, sql] of [
        ['ledger_entries', LEDGER_SQL.entriesHistory],
        ['ledger_postings', LEDGER_SQL.postingsHistory],
        ['ledger_accounts', LEDGER_SQL.accountsHistory],
      ] as const) {
        for (const row of await tx.query<HistoryRow>(sql)) {
          if (row._rev > 1n) found.push({ table, id: row.id, rev: row._rev });
        }
      }
      return found;
    });
  }

  override async verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void> {
    let row: Record<string, unknown>;
    try {
      ({ row } = await this.immudb.verifiedRow(
        'ledger_entries',
        [entryId],
        toImmudbState(trusted),
      ));
    } catch (error) {
      if (error instanceof ImmudbError && error.kind === 'verification-failed') {
        throw new LedgerVerificationFailedException(entryId, error.message, error);
      }
      throw error;
    }
    if (row['payload_hash'] !== expectedPayloadHash) {
      throw new LedgerVerificationFailedException(
        entryId,
        'payload hash differs from the posted one',
      );
    }
  }

  override async advanceTrustedState(
    trusted: LedgerTrustedState | null,
  ): Promise<LedgerTrustedState> {
    const state = await this.immudb.currentState();
    if (trusted !== null) {
      try {
        await this.immudb.verifyConsistency(toImmudbState(trusted), state);
      } catch (error) {
        if (error instanceof ImmudbError && error.kind === 'verification-failed') {
          throw new LedgerVerificationFailedException('trusted-state', error.message, error);
        }
        throw error;
      }
    }
    return { database: state.database, txId: state.txId, txHash: state.txHash };
  }
}

function toImmudbState(trusted: LedgerTrustedState): ImmudbState {
  return { ...trusted, signature: null };
}
```

The unit test's missing-row case: `RecordingImmudbClient.verifiedRow` throws `ImmudbError('verification-failed')`
when `respond` returns no row, which the adapter wraps. `Map.groupBy` is ES2024 (`lib: ES2025` in
`tsconfig.base.json`, Node 24).

Root barrel `domains/billing/src/index.ts` (with the other ledger lines):

```ts
export * from './infrastructure/ledger/billing-ledger.migrations.js';
export * from './infrastructure/ledger/immudb-ledger.adapter.js';
```

- [ ] **Step 5: Run the unit test.** `npx vitest run --project billing src/infrastructure/ledger` —
      Expected: PASS.

- [ ] **Step 6: Write and run the int spec (Docker, sandbox off).**
      `domains/billing/src/infrastructure/ledger/immudb-ledger.adapter.int-spec.ts`:

```ts
import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@platform/config';
import { IMMUDB_TEST_IMAGE, ImmudbClient, ImmudbModule } from '@platform/immudb';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import { toEpochMicros } from '../../domain/ledger/ledger.ids.js';
import { describeLedgerContract } from '../../testing/ledger.contract.test.js';
import { billingLedgerMigrations } from './billing-ledger.migrations.js';
import { ImmudbLedgerAdapter } from './immudb-ledger.adapter.js';

describe.skipIf(process.env['INTEGRATION'] !== '1')('ImmudbLedgerAdapter on immudb 1.11.2', () => {
  let container: StartedTestContainer | undefined;
  let app: TestingModule | undefined;
  let admin: TestingModule | undefined;
  let adapter: ImmudbLedgerAdapter;

  const boot = async (env: Record<string, string>): Promise<TestingModule> => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }),
      ],
    }).compile();
    vi.unstubAllEnvs();
    return moduleRef;
  };

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    const address = `${container.getHost()}:${container.getMappedPort(3322)}`;
    // The application user (SELECT + INSERT only), provisioned and migrated at boot.
    app = await boot({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: 'ledger_it',
      IMMUDB_ADMIN_PASSWORD: 'immudb',
      IMMUDB_RUN_MIGRATIONS: 'true',
    });
    // A superuser session on the same database, to forge rows the adapter would never write.
    admin = await boot({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: 'ledger_it',
      IMMUDB_USERNAME: 'immudb',
      IMMUDB_PASSWORD: 'immudb',
    });
    adapter = new ImmudbLedgerAdapter(app.get(ImmudbClient));
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
    await container?.stop();
  });

  describeLedgerContract('ImmudbLedgerAdapter', async () => ({ ledger: adapter }));

  it('finds entries with fewer than two postings or unbalanced currencies (R1)', async () => {
    const immudb = admin?.get(ImmudbClient);
    if (immudb === undefined) throw new Error('admin not booted');
    const now = toEpochMicros(new Date());
    const entry = (id: string) =>
      `INSERT INTO ledger_entries (id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us, schema_version) VALUES ('${id}', 'forged:${id}', '${CHARGE_DRAFT.tenantId}', 'adjustment', '', '', 0, '', '${'0'.repeat(64)}', ${now}, ${now}, 1)`;
    const posting = (entryId: string, line: number, debit: number, credit: number) =>
      `INSERT INTO ledger_postings (id, entry_id, line, tenant_id, account_id, currency, debit, credit) VALUES ('${entryId}:${line}', '${entryId}', ${line}, '${CHARGE_DRAFT.tenantId}', 'acct', 'usd', ${debit}, ${credit})`;
    await immudb.readWrite(async (tx) => {
      await tx.exec(entry('forged-one-line'));
      await tx.exec(posting('forged-one-line', 1, 5, 0));
      await tx.exec(entry('forged-unbalanced'));
      await tx.exec(posting('forged-unbalanced', 1, 5, 0));
      await tx.exec(posting('forged-unbalanced', 2, 0, 4));
    });
    const found = await adapter.findUnbalanced({ fromUs: now - 1n, toUs: now + 60_000_000n });
    expect(found).toEqual(
      expect.arrayContaining([
        { entryId: 'forged-one-line', currency: null, debit: 0n, credit: 0n, postings: 1 },
        { entryId: 'forged-unbalanced', currency: 'usd', debit: 5n, credit: 4n, postings: 2 },
      ]),
    );
  });

  it('detects a row rewritten by a superuser (R2) and fails its verification', async () => {
    const immudb = admin?.get(ImmudbClient);
    if (immudb === undefined) throw new Error('admin not booted');
    const posted = await adapter.post({ ...CHARGE_DRAFT, sourceKey: 'stripe:txn:txn_tampered' });
    const trusted = await adapter.advanceTrustedState(null);
    await immudb.readWrite((tx) =>
      tx.exec("UPDATE ledger_entries SET kind = 'adjustment' WHERE id = @id", {
        id: posted.entryId,
      }),
    );
    await expect(adapter.findMutations()).resolves.toEqual(
      expect.arrayContaining([{ table: 'ledger_entries', id: posted.entryId, rev: 2n }]),
    );
    const now = await adapter.advanceTrustedState(trusted);
    // A new, valid revision with the same payload_hash: verification passes, R2 above caught it.
    await expect(
      adapter.verifyEntry(posted.entryId, posted.payloadHash, now),
    ).resolves.toBeUndefined();
    await expect(adapter.getEntry(CHARGE_DRAFT.tenantId, posted.entryId)).resolves.toMatchObject({
      kind: 'adjustment',
    });
  });
});
```

Run: `INTEGRATION=1 npx vitest run --project billing:int immudb-ledger` — Expected: PASS (7 contract
tests + 2). Notes for failures: if `GROUP BY entry_id, currency` with `COUNT(*)` is refused, split
`postingSumsByEntry` into the `SUM` query and a `COUNT(*) AS postings … GROUP BY entry_id` query (both
shapes were probed in P2); if `HISTORY OF` without `WHERE` is refused, add `WHERE _rev > 1` (spec R2
note) and keep the TypeScript filter. **Unverified: the L-9 int spec must confirm it** (Docker was
down at review): `GROUP BY … COUNT(*)`, `HISTORY OF` without `WHERE`, and the `key already exists` /
`tx read conflict` strings behind the adapter's retry (seen in spec P2/P6/P8 and in v1.9DOM.1
`embedded/store/immustore.go`).

The R2 test pins a limit worth knowing: a superuser `UPDATE` is a valid new revision with valid proofs,
and `verifyEntry` compares only the stored `payload_hash` (spec R5), so a rewrite of other columns is
caught by `findMutations` (R2), not by verification. Keep both assertions.

- [ ] **Step 7: Docs.** `domains/billing/README.md`: add a "Ledger (immudb)" section:

```markdown
## Ledger (immudb)

An append-only double-entry ledger in immudb (`@platform/immudb`), not Postgres. One entry per Stripe
balance transaction (`sourceKey = stripe:txn:<id>`, entry id = uuidv5 of it), postings in minor units per
currency, fees from the balance transaction (`application/ledger/posting-rules.ts`). `LedgerPort.post` is
idempotent (`posted` / `replayed` / `conflict`) and validates the double-entry rules before any I/O. The
immudb user may only `SELECT` and `INSERT`; every tenant read carries `tenant_id = @tenant` (immudb has no
RLS). Tables: `infrastructure/ledger/migrations/001_ledger.sql` (`billingLedgerMigrations`). Not wired
into the apps yet: the posting consumer, reconciliation and `LEDGER_ENABLED` arrive with the outbox
(ledger waves 1-2). Tests: `InMemoryLedger` (`@domain/billing/testing`) and the adapter run the same
contract spec (`src/testing/ledger.contract.test.ts`).
```

- [ ] **Step 8: Wider checks.** `npx biome check --write domains/billing`,
      `npx prettier --write domains/billing/README.md`, `bun run check` (Expected: PASS), `bun run build`
      (Expected: PASS; `dist/infrastructure/ledger/migrations/001_ledger.sql` is copied by SWC `copyFiles`).

- [ ] **Step 9: Commit.**

```bash
git add domains/billing bun.lock
git commit -m "feat(billing): post ledger entries to immudb through ImmudbLedgerAdapter" \
  -m "001_ledger.sql (accounts, entries, postings; append-only by privilege), billingLedgerMigrations,
and the LedgerPort adapter: validate before I/O, read-check-insert in one ReadWrite tx with
retries on MVCC conflicts, tenant-scoped reads, R1/R2 reconciliation reads and proof-backed
verifyEntry/advanceTrustedState. Runs the shared contract spec on immudb 1.11.2."
```

## Remaining waves (1 and 2)

Not written in full here (spec section 8; plans follow once their upstream items exist).

| Task | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Wave | Needs                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------ |
| L-10 | Postgres ledger tables (`ledger_accounts`, `ledger_entry_refs`, `ledger_discrepancies`, `ledger_reconciliation_runs`, `ledger_trusted_state`) + RLS custom SQL + `*.system-repository.ts` (spec section 5 system methods 8-11) + any S-2/S-6 columns or enum values B2-6 did not carry                                                                                                                                                                                                                                                                                                                                                                                                                         | 1    | B2-6, B3-6, B3-10, B3-11 |
| L-11 | Webhook coverage (`charge.refunded`, `refund.*`, `charge.dispute.*`, `payout.*`) writing `billing.ledger-posting.v1` outbox rows (platform-level events via the system path); topic + `.dlq` in `docker/kafka/topics.txt`; `LedgerPostingRequestedPayload` contract in `billing.events.ts`                                                                                                                                                                                                                                                                                                                                                                                                                     | 1    | G-1, G-2, L-10           |
| L-12 | `LedgerPostingConsumer` (envelope principal, balance-transaction fetch, `draftFromBalanceTransaction`, `LedgerPort.post`, `ledger_entry_refs`, conflict → discrepancy, metrics); `ledger` config namespace (`LEDGER_ENABLED`, `LEDGER_RECONCILE_LOOKBACK_HOURS`, `LEDGER_VERIFY`); `ImmudbModule` + `ImmudbHealthIndicator` + `x-env-immudb` + `depends_on: immudb-init` in monolith and billing-service; `runImmudbMigrationsCli([billingLedgerMigrations])` in their `src/migrate.ts` (one process migrates: `ChangeSQLPrivileges` ends the app user's open sessions, so prefer the migrate step to `IMMUDB_RUN_MIGRATIONS=true` on every replica); `LedgerService` principal gating of `PLATFORM_TENANT_ID` | 2    | G-3, L-9, L-11           |
| L-13 | `ReconcileLedgerCron` R1-R4 (system context), discrepancy writes, metrics and alert rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2    | L-12, G-4                |
| L-14 | Verified reconciliation R5 (trusted state in Postgres, `advanceTrustedState`, per-entry `verifyEntry`); production `--signingKey` with the pinned public key (D3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2    | L-5, L-13                |
| S-4b | Remaining part of ledger S-4 (wave 0 does not cover it): log (debug, with the user and tenant) and count checkout requests that send no `Idempotency-Key` (counter `billing_checkout_without_idempotency_key_total`, `makeCounterProvider` in `BillingCoreModule`, a row in `docs/OBSERVABILITY.md`), and document "key lifetime = payment lifetime" in `docs/API.md`; the header stays optional                                                                                                                                                                                                                                                                                                               | 1    | B2 edge Lane B Task 2    |
| L-15 | e2e in both topologies + billing-service e2e + docs (billing README "Consistency", ARCHITECTURE, SECURITY, TESTING, CONFIGURATION)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2    | L-12..L-14               |

## Spec coverage

| Spec item                                                                                                                                          | Where                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| L-1 package, vendored proto, codegen, CI drift, `@bufbuild/protobuf` catalog                                                                       | Task L-1                                                             |
| L-2 session pool, tx, keepalive, error map, module, health, `immudb` namespace, int spec                                                           | Tasks L-2a, L-2b                                                     |
| L-3 provisioning (`ChangeSQLPrivileges`), versioned `.sql` migrator, CLI                                                                           | Task L-3                                                             |
| L-4 htree/ahtree/linear/linear-advance/dual proofs, Alh, entry digests, vectors                                                                    | Task L-4 (vectors from the container: decision 2)                    |
| L-5 `verifyRow`, `verifiedRow`, `verifyConsistency`, state signature, negative int specs                                                           | Task L-5                                                             |
| L-6 compose service, anchor, `/readyz` check, Prometheus scrape, `docs/DOCKER.md`                                                                  | Task L-6                                                             |
| L-7 S-1, S-3, S-5, S-8, S-10                                                                                                                       | Task L-7                                                             |
| L-8 model, chart, invariant, ids, hash, posting rules, `LedgerPort`, `InMemoryLedger`, contract spec, `./testing`                                  | Tasks L-8a, L-8b                                                     |
| L-9 adapter, `001_ledger.sql`, contract int spec                                                                                                   | Task L-9                                                             |
| S-2, S-4, S-6 (schema), B2 carry list (8.1)                                                                                                        | B2-6 / B2-26 (restated in Interface contracts); L-10 fallback        |
| S-7 outbox                                                                                                                                         | G-1..G-3; L-11/L-12                                                  |
| S-9 unknown types consume a dedupe row                                                                                                             | documented in L-15 (no code change)                                  |
| S-11 money as `bigint`                                                                                                                             | Tasks L-2a (codec), L-8a (model)                                     |
| 2.5 rules (validate before I/O, one RW tx, retries, never Rollback after a failed statement)                                                       | Tasks L-2b, L-9                                                      |
| 4 R1, R2 reads                                                                                                                                     | Task L-9 (`findUnbalanced`, `findMutations`); cron in L-13           |
| 5 tenant column + code checks                                                                                                                      | Tasks L-8a (`assertBalanced` ownership), L-9 (`LEDGER_TENANT_READS`) |
| 6.2 `ledger` domain namespace                                                                                                                      | L-12 (nothing reads it before the consumer exists)                   |
| 6.4 `docs/TESTING.md` toolbox and int-spec rows (`RecordingImmudbClient`, `InMemoryLedger`, `describeLedgerContract`, `immudb:int`, `billing:int`) | L-15 (one docs task per phase, conventions §5)                       |

## Self-review

- Every wave-0 spec task (L-1..L-9) maps to a task above; L-2 and L-8 are split to keep each commit one
  reviewable deliverable. L-9's dependencies are corrected to include L-5 (`verifyEntry`,
  `advanceTrustedState` need `verifiedRow`/`verifyConsistency`).
- Names used across tasks were checked against each other: `ImmudbClient` (`readWrite`, `readOnly`,
  `currentState`, `verifyConsistency`, `verifiedRow`), `ImmudbSession.open`, `ImmudbSessionPool`,
  `GrpcImmudbClient(pool, { serverSigningPublicKeyPem })`, `RecordingImmudbClient`, `runImmudbMigrations`,
  `billingLedgerMigrations`, `IMMUDB_TEST_IMAGE`, `LEDGER_SQL`/`LEDGER_TENANT_READS`, `describeLedgerContract`,
  `CHARGE_DRAFT`/`LEDGER_TEST_TENANT` (`domains/billing/test/ledger-fixtures.ts`).
- Generated method names were taken from an actual `buf generate` run of the stripped proto (scratchpad,
  2026-11-09): `txSqlExec`, `txSqlQuery`, `sqlExec`, `verifiableSqlGet`, `changeSqlPrivileges`,
  `createDatabaseV2`, `LinearProof.TargetTxId`, `DualProof.LinearAdvanceProof`, `VerifiableSQLEntry.PKIDs`.
  The compiled output imported under native ESM (`node`), and `fromPartial` fills scalar defaults.
- Golden values (entry/account uuidv5 ids, canonical JSON, payload hash) were computed with the catalog
  `uuid` and `node:crypto` before being pinned.
- Unverified until the int specs run (each has a named fallback in its task; Docker was down during the
  2026-11-10 review, so **unverified: the L-9 int spec must confirm it**, or the L-2b/L-3/L-5 int spec
  named): result selector format of aliases and aggregates (L-2b; v1.9DOM.1 source says
  `(table.alias)`), `UPSERT` refusal text (L-3; spec P7 saw `[INSERT UPDATE]` over pg-wire), concurrent
  `CreateUser`/`CreateDatabaseV2` (L-3), `--signingKey` start-up (L-5), `GROUP BY … COUNT(*)` and
  `HISTORY OF` without `WHERE` (L-9), the duplicate-key/read-conflict strings (spec P2/P6/P8 saw them;
  also in `embedded/store/immustore.go` `ErrKeyAlreadyExists`, `ErrTxReadConflict`), `ChangeSQLPrivileges`
  revoking UPDATE/DELETE/DROP/ALTER/CREATE (spec P6/P7 saw it), `/readyz` on 9497 (spec P0 saw 200).
- Review run 2026-11-10 (scratch workspace, not committed): every `libs/immudb`, `libs/config` and
  billing-ledger TypeScript block of this plan was extracted, `tsc` (repo `tsconfig.base.json`, strict)
  exited 0, Biome lint was clean apart from the dependency rule of the stub manifests, and the 19 unit
  spec files ran green (198 tests) after fixes R-2/R-3/R-4. Not run: L-7 (edits existing billing code),
  the two vector specs (need the captured JSON), every int spec (Docker), ESLint (type-aware project).
- No task depends on tenant columns, billing Postgres migrations or the outbox (D5); nothing writes
  `request_hash` or new payment statuses.

## Interface contracts (for other lanes)

**`@platform/immudb`** (barrel): `IMMUDB_SERVER_VERSION`, `IMMUDB_TEST_IMAGE`, `ImmudbValue`, `ImmudbParams`,
`ImmudbRow`, `ImmudbTx`, `ImmudbState`, `ImmudbMigrationSource`, `ImmudbModuleOptions`, `ImmudbErrorKind`,
`ImmudbError`, `toImmudbError`, `isSessionGone`, `ImmudbClient` (DI token), `ImmudbModule.forRootAsync(options?)`
(global), `ImmudbHealthIndicator` (key `immudb`), `IMMUDB_MIGRATIONS_TABLE`, `IMMUDB_REVOKED_PRIVILEGES`,
`splitImmudbSql`, `loadImmudbMigrations`, `runImmudbMigrations(cfg, sources, options?)`,
`runImmudbMigrationsCli(sources)`. `./testing`: `RecordingImmudbClient`, `RecordedStatement`. Signatures:
tasks L-2a, L-2b, L-3, L-5. `verifiedRow` and `verifyConsistency` fail closed with kind
`verification-failed` when the trusted state is ahead of the server; `ChangeSQLPrivileges` (every
migration run) ends the application user's open sessions, so one process migrates.

**`@platform/config`**: namespace `immudb` registered in `CONFIG_NAMESPACES` and `AllConfig`;
`immudbConfig`, `ImmudbConfig`, `IMMUDB_DEFAULT_ADMIN_PASSWORD`, `IMMUDB_LOCAL_PASSWORD`. Keys:
`IMMUDB_ADDRESS`, `IMMUDB_DATABASE`, `IMMUDB_USERNAME`, `IMMUDB_PASSWORD`, `IMMUDB_ADMIN_USERNAME`,
`IMMUDB_ADMIN_PASSWORD`, `IMMUDB_SESSION_POOL_SIZE`, `IMMUDB_TIMEOUT_MS`, `IMMUDB_KEEPALIVE_INTERVAL_MS`,
`IMMUDB_TLS`, `IMMUDB_ALLOW_INSECURE`, `IMMUDB_SERVER_SIGNING_PUBLIC_KEY`, `IMMUDB_RUN_MIGRATIONS`.

**`@domain/billing`** export map (after G-11): root barrel (never `./api`) adds `PLATFORM_TENANT_ID`,
`LEDGER_NAMESPACE = '9402cabc-4fa0-4891-9ed1-389e5828479d'`, `LEDGER_CHART`, ledger types
(`LedgerAccountCode`, `LedgerAccountKind`, `LedgerEntryKind`, `LedgerLine`, `LedgerEntryDraft`,
`LedgerPostOutcome`, `LedgerPosting`, `LedgerEntry`, `LedgerBalance`, `LedgerImbalance`,
`LedgerTrustedState`), `ledgerEntryId`, `ledgerAccountId`, `ledgerPayloadHash`, `toEpochMicros`,
`assertBalanced`, `resolveLedgerAccount`, `LedgerUnbalancedException`, `LedgerVerificationFailedException`,
`PostingBalanceTransaction`, `PostingContext`, `ledgerKindOf`, `draftFromBalanceTransaction`, `LedgerPort`,
`billingLedgerMigrations`, `LEDGER_SQL`, `LEDGER_TENANT_READS`, `ImmudbLedgerAdapter`; `./testing` adds
`InMemoryLedger` (a new `./testing` subpath after `./api`, per the G placement rule for in-memory fakes;
`./api` is unchanged). Metric-name constants `AMOUNT_MISMATCH_METRIC`, `API_VERSION_MISMATCH_METRIC`
stay internal (not on any entry point). New error codes: `CHECKOUT_IN_PROGRESS`, `CHECKOUT_SESSION_CLOSED` (409),
`LEDGER_ENTRY_INVALID`, `LEDGER_VERIFICATION_FAILED`. New metrics:
`billing_checkout_amount_mismatch_total`, `billing_stripe_api_version_mismatch_total`.
`STRIPE_API_VERSION = '2026-08-26.dahlia'`. `billing.payment-succeeded.v1` gains optional
`stripePaymentIntentId`.

**immudb tables** (`001_ledger.sql`, spec 2.2 verbatim): `ledger_accounts`, `ledger_entries`,
`ledger_postings`; null strings stored as `''`, null amounts as `0`.

**Compose:** services `immudb`, `immudb-init`; anchor `x-env-immudb`; volume `immudb-data`; host knob
`IMMUDB_HOST_PORT` (3322).

**For the B2 planner (spec 8.1, requirements on B2, not wave-0 deliverables):** B2-6 adds
`billing.payments.request_hash text`, the unique `(tenant_id, user_id, idempotency_key)`,
`billing.stripe_events` PK `(tenant_id, id)` with a **nullable** `user_id`, and the `payment_status` values
`refunded`, `partially_refunded`, `disputed` (or leaves them to L-10 on the billing migration lane); B2-26
puts `{ paymentId, userId, tenantId }` in both session metadata and `payment_intent_data.metadata`; B2
reserves the nil UUID (`PLATFORM_TENANT_ID`) as never-a-tenant.

**Ordering with B2 (controller ruling 2026-11-10):** L-7 and L-8a merge **before** B2 edge Lane B
Task 1. That task edits the same checkout and webhook handlers, quotes post-L-7 code
(`CreateCheckoutSessionHandler#boundSession`, `StripeService#retrieveCheckoutSession`, the
`api_version` check right after `constructWebhookEvent` in `HandleStripeWebhookHandler#execute`, the
two counters as constructor arguments 6 and 7) and replaces L-8a's line
`export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';` in
`domains/billing/src/domain/ledger/ledger.types.ts` with `export { PLATFORM_TENANT_ID } from '@platform/common';`.

## Plan review (2026-11-10)

Status: DONE (adversarial review by review:ledger-wave0, run 2, 2026-11-10; run 1 left nothing). The
plan was fixed in place; findings R-1..R-16 below. The executive summary at the top reflects them.

### Changes made

- **R-1 (L-2a/L-2b, blocking): the expired-session message is `no session found`, not
  `session not found`.** `pkg/server/sessions/errors.go:29` at both `v1.9DOM.1` and `v1.11.2`:
  `ErrSessionNotFound = errors.New("no session found")`. With the planned regex a server-forgotten
  session was never classified `unavailable`, so the pool kept handing it out and the L-2b
  "replaces a session the server forgot" int spec could never pass. Fixed in `MESSAGE_KINDS`,
  `isSessionGone`, the error and pool unit tables and Review Focus 3 (both spellings matched).
- **R-2 (L-2a, blocking): `libs/config/src/all-config.spec.ts:18-33` pins the exact
  `CONFIG_NAMESPACES` key list**, so Step 7's `npx vitest run --project config` failed
  (`expected [ 'app', … ] … + "immudb"`, reproduced). L-2a now edits that spec (`'immudb'` after
  `'cassandra'`) and stages it.
- **R-3 (L-2b, blocking): the "caps open sessions" pool test failed with `TypeError: release is not
a function`** (reproduced): one `await Promise.resolve()` does not let `use()` get past the async
  factory. It now waits one macrotask (`setImmediate`). `Waiter` members became properties, because
  `release()` passes them unbound to `then` (`@typescript-eslint/unbound-method` in source files).
- **R-4 (L-4, blocking): Biome `lint/suspicious/useIterableCallbackReturn` error** in
  `dual-proof.vectors.spec.ts` (`forEach((item, i) => byteLeaves(…))` returns a value; spec
  overrides do not disable it, so `bun run check` failed). Braced body now.
- **R-5 (L-4, blocking): `capture-vectors.mjs` proved since `states[0]`, which is tx 0 on a fresh
  database.** `pkg/database/database.go` `VerifiableTxByID` (v1.9DOM.1) treats `proveSinceTx = 0` as
  "the tx itself", so the vector's proof would have source = target ≠ the recorded `0` and "accepts
  every captured proof" fails. The distant source is now `states[1]` (the `CREATE TABLE` tx).
- **R-6 (L-3): concurrent runs.** Two runners booting together can lose MVCC races on
  `CreateDatabaseV2`, `CreateUser` and the catalog (`CREATE TABLE IF NOT EXISTS`), which surface as
  `read-conflict`; the "survives two concurrent runs" int spec would have failed on the first one.
  `provision` now treats "already exists" or a read conflict as created elsewhere, and every
  migration statement runs through `execIdempotent` (up to 5 attempts on `read-conflict`).
  Documented that `ChangeSQLPrivileges` ends the user's open sessions (`pkg/server/user.go` at
  `v1.11.2`, read for behaviour only): run migrations from one process (L-12 note added).
- **R-7 (L-3): the boot int spec relied on `SELECT COUNT(*)` returning a row on an empty table**
  (unprobed). It now asserts `SELECT id FROM kv` resolves `[]` (the table exists, migrated at boot).
- **R-8 (L-2a, doc): unaliased aggregates are named `(table.colN)`, not `AGG(table.col)`**
  (`embedded/sql/proj_row_reader.go` `Columns`, v1.9DOM.1). Review Focus 2, the `columnKey` comment
  and the unit table are corrected; adapter SQL already aliases every aggregate. The L-2a spec uses
  the neutral `orders` vocabulary instead of `ledger` (the plan's own libs rule).
- **R-9 (L-5/L-8b): `verifyEntry` with a trusted state the store never reached** threw
  `LedgerVerificationFailedException` in `InMemoryLedger` but an unmapped gRPC error in the adapter
  (the server answers "latest txID=… is lower than specified as initial tx", `pkg/database`).
  `GrpcImmudbClient.verifiedRow` now fails closed with `verification-failed` after a `CurrentState`
  check, and the shared contract asserts it for both implementations.
- **R-10 (L-6, blocking): the compose and Prometheus YAML snippets were at column 0.** Pasted "after
  the `cassandra-init` service" they would have made `immudb`/`immudb-init` top-level keys
  (`services:` at `docker-compose.yml:143`, its children at 2 spaces) and the scrape job a
  top-level list. Prettier dedents YAML inside a formatted plan (that is how the planner's blocks
  ended at column 0), so both steps now say "indent by 2 spaces" explicitly; `labels: { service:
immudb }` added as every job has; the job goes after the last job (`redis`). My first fix also
  dropped compose's `$$` escape (a JS replacement pattern): restored and called out.
- **R-11 (L-7, blocking): the quoted old text of `complete()` did not exist.**
  `payment.aggregate.ts:221-224` breaks `const currency =` over two lines; the plan quoted one line,
  so the edit could not be matched. Quoted exactly now. Docs anchors moved (`docs/API.md:316`,
  `:372`), and the two new counters get rows in `docs/OBSERVABILITY.md:157` (missing before).
- **R-12 (ordering, controller ruling): L-7 and L-8a merge before B2 edge Lane B Task 1.** Replaced
  "rebase over B2-26 if it lands first" in the execution table, L-7 Wave, the executive summary and
  Interface contracts; L-8a pins `export const PLATFORM_TENANT_ID = '0000…';` byte for byte (B2
  edge Task 1 turns it into a re-export from `@platform/common`, `2026-11-09-b2-edge.md:975-977`).
  The S-4 remainder (log and count requests without `Idempotency-Key`) is row S-4b of the later waves.
- **R-13 (all tasks): commit bodies were single lines of 200-450 characters.** Wrapped at 96
  (`body-max-line-length` 100); headers are 72-88 characters, scopes valid (`immudb` from L-1's own
  commit).
- **R-14 (L-1): `libs/immudb/package.json` lacked `@bufbuild/buf` and `ts-proto`** although its
  `proto:gen` runs both (every contracts package declares them); added as devDependencies. CI drift
  anchor is `ci.yml:82-83` after E's `db:check` line.
- **R-15 (L-8a/L-8b, text):** `CHARGE_DRAFT` lives in `test/ledger-fixtures.ts`, not in a spec;
  billing's new `./testing` export goes after G-11's `./api` (G's target map has no billing
  `./testing`; its placement rule sends in-memory fakes there).
- **R-16 (docs, controller ruling):** `docs/DOCKER.md` now states the server's BUSL-1.1 licence and
  its Additional Use Grant (quoted from `LICENSE` at v1.11.2); Global Constraints list the
  deprecated RPCs (only `SQLQueryRequest.reuseSnapshot` is a deprecated field in v1.11.2, not
  `VerifiableTxRequest.noWait`).

Checked and correct (no change): the v1.11.2 `schema.proto` sha256 `66d3a290…d4aa` (downloaded), the
strip script on the real file (1,786 lines, 74 RPCs kept, only `go_package`/`deprecated` options left)
and on the unit fixture, `buf generate` output (`schema.pb.ts` 18,424 lines, `@bufbuild/protobuf/wire`
2.15.0 hoisted, ts-proto requires `^2.14.1`); the ledger golden ids, canonical JSON and hash
(recomputed with `uuid` 14.0.3 and `node:crypto`); the Stripe facts (`StripeError.generate` =
`generateV1Error`, so a 409 is a `StripeAPIError`; `ApiVersion = "2026-08-26.dahlia"`); the port
fidelity of every function against `v1.9DOM.1` (htree `VerifyInclusion`; ahtree inclusion,
consistency, last inclusion; `VerifyLinearProof`, `VerifyLinearAdvanceProof`, `VerifyDualProof`,
`advanceLinearHash`, `leafFor`; `TxHeader.innerHash`/`Alh`; `TxMetadata.Bytes` and
`TxMetadataFromProto`; `EntrySpecDigest_v0/_v1`; `EncodeRawValueAsKey`; `decodeRow`; `VerifyRow`
direction and state; `ImmutableState.ToBytes`/`CheckSignature`; `signer.Verify`); the billing code
L-7 changes (handler constructor order, spec helpers `createService`, `makeCheckoutSession`,
`makePayment`, `signedEvent`, `paidWithoutCurrency`); G-11's barrel and `check-api-subpaths` (ledger
symbols are root-only, `./api` unchanged); the libs vocabulary guard (no domain word in the planned
`libs/immudb` specs).

### Probe results (codenotary/immudb:1.11.2)

- **Docker was down for this review** (`docker info`: "Cannot connect to the Docker daemon at
  unix:///Users/maddie/.docker/run/docker.sock"), so no container probe ran. Every behaviour the
  planner left "to be confirmed by int specs" stays **unverified: the L-9 int spec must confirm it**
  (or the L-2b/L-3/L-5 int spec named in the task); each carries a written fallback in its task.

### Unresolved

- **Every container behaviour is unverified** (Docker down): the behaviours listed in Self-review
  "Unverified until the int specs run" must be confirmed by the L-2b, L-3, L-5 and L-9 int specs, each
  with its written fallback. The riskiest are the 1.11.2 selector of an aliased aggregate (L-2b; the
  Apache source says `(table.alias)`), `HISTORY OF` without `WHERE` and `GROUP BY … COUNT(*)` (L-9),
  and the start-up flag form of `--signingKey` (L-5).
- **L-7 was reviewed by reading, not compiled**: it edits existing billing files whose exact post-G-11
  text the scratch run did not reproduce. Its quoted anchors were checked against the current files.
- **ESLint (type-aware) did not run** on the extracted code; `no-floating-promises`,
  `unbound-method` and `return-await` were checked by hand.
- **Legal:** whether to have counsel confirm the BUSL-1.1 Additional Use Grant covers this product
  (decision 1) is the user's call; the code itself copies nothing from BUSL sources.

### Appendix: probe evidence

```
$ docker info --format '{{.ServerVersion}}'
Cannot connect to the Docker daemon at unix:///Users/maddie/.docker/run/docker.sock. Is the docker daemon running?
$ docker ps -a --filter name=prog-probe-          # nothing created, nothing to remove

$ curl -sfo schema-v1.11.2.proto https://raw.githubusercontent.com/codenotary/immudb/v1.11.2/pkg/api/schema/schema.proto
$ shasum -a 256 schema-v1.11.2.proto; wc -l schema-v1.11.2.proto
66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa  schema-v1.11.2.proto
    2024 schema-v1.11.2.proto
$ node scripts/strip-proto.mjs vendor/immudb-v1.11.2-schema.proto proto/immudb/schema/schema.proto
  -> 1786 lines; rpc count 74 = 74; remaining options: go_package, deprecated = true (9 RPCs)
$ buf generate --template buf.gen.yaml   (buf 1.73.0, ts-proto 2.13.3 from the repo's node_modules)
  -> src/generated/immudb/schema/schema.pb.ts 18424, google/protobuf/empty.pb.ts 96, struct.pb.ts 685
$ curl …/v1.9DOM.1/pkg/server/sessions/errors.go | rg SessionNotFound    (same line at v1.11.2)
29:var ErrSessionNotFound = errors.New("no session found").WithCode(errors.CodInvalidParameterValue)
$ curl …/v1.9DOM.1/embedded/store/immustore.go | rg 'errors.New'
ErrReadOnlyTx = "read-only transaction"; ErrTxReadConflict = "tx read conflict";
ErrKeyAlreadyExists = "key already exists"
$ curl …/v1.9DOM.1/embedded/sql/proj_row_reader.go   (Columns)
  aggregate without alias -> col = fmt.Sprintf("col%d", i); with alias -> (table.alias)
$ curl …/v1.9DOM.1/pkg/database/database.go   (VerifiableTxByID)
  if req.ProveSinceTx == 0 { rootTxHdr = reqTx.Header() }
$ curl …/v1.11.2/pkg/server/user.go   (ChangeSQLPrivileges, behaviour only)
  "terminate active sessions for this user"; CreateUser on an existing user: "user already exists"

# Scratch workspace (session scratchpad, never the repo): every libs/immudb, libs/config and
# billing-ledger TS block of this plan extracted, the plan's partial edits applied by script.
$ tsc -p tsconfig.json                      (extends the repo tsconfig.base.json)  -> exit 0
$ vitest run (repo SWC + resolve conditions) before fixes:
  FAIL libs/config/src/all-config.spec.ts  expected [ 'app', …(12) ] to deeply equal [ 'app', …(11) ]
  FAIL libs/immudb/src/client/session-pool.spec.ts  TypeError: release is not a function
  Test Files 2 failed | 17 passed (19); Tests 2 failed | 195 passed (197)
$ vitest run after fixes R-2, R-3, R-6, R-9   -> Test Files 19 passed (19); Tests 198 passed (198)
$ biome lint (repo biome.json)
  dual-proof.vectors.spec.ts:31:11 lint/suspicious/useIterableCallbackReturn  (fixed, R-4)
  (other hits: noUndeclaredDependencies of the scratch stub manifests only)
$ node -e '…uuid v5 + sha256…'   -> entry 34963174-7910-51ca-a20a-690a08315957,
  accounts a713bc9c-…-c457419d8212 / 8b802315-…-a1d41b52aecf / 7d92ee01-…-404f697c9460,
  hash 1764943fe2e39a5a9ac6b072deb88461d9c0d99ea244f7ab548487e139aba4e6 (all equal to the plan)
```
