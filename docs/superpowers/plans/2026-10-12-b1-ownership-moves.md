# B1 Ownership Moves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything domain-specific out of `libs/` into the domain that owns it, with no behaviour change apart
from Postgres schema names. That covers contracts, transport by value, Stripe, password hashing and token issuance,
config namespaces, mail templates, migrations and test fakes.

**Architecture:** Five lanes were drafted and validated separately (contracts, persistence, identity, billing,
platform), each in a lab replica of `74f70b7`. This file merges them into one order of 32 tasks, settles the four
places where the lanes disagreed, rebases their anchors onto HEAD `0505e92`, and adds the five tests the lanes missed.
Contracts runs first because its tasks ship as exact `git apply` patches. The other lanes edit by quoted text, which
survives reordering. `platform-8` is the checkpoint: check, every test, integration specs, build, both images and both
compose topologies.

**Tech Stack:** NestJS 12 (ESM, Fastify), TypeScript 6.0.3, Bun 1.4.3 workspaces (hoisted linker, nested
`domains/*/contracts`), Drizzle ORM 0.45.4 and drizzle-kit 0.31.11 on PostgreSQL 18, ts-proto and buf, kafkajs,
Vitest 5, Biome 2.5.15, ESLint and Prettier, SWC `copyFiles`.

**Spec:** [`docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md`](../specs/2026-10-12-domains-tenancy-rls-program-design.md).
B1 is §2's first checkpoint ("Ownership moves. No behaviour change apart from schema names."), plus §3 and the B1 part
of §4: schemas, migration sets, run order and fresh baselines. Database roles, `FORCE ROW LEVEL SECURITY` and the boot
guard are B3.

## Global Constraints

- Layers: `apps → domains → domains/*/contracts → libs`. A domain imports another domain only through
  `@domain/<x>-contracts`. A contracts package imports only `@platform/contracts` and third-party packages. `libs/`
  names no domain. `scripts/check-boundaries.mjs` enforces all of this inside `bun run check`.
- No behaviour change except schema names:
  - same env var names and defaults;
  - same gRPC packages and services (`identity.v1`, …) and Kafka topic names;
  - same HTTP routes and GraphQL schema, including `Payment.user` in the monolith and the gateway.
- The production guards from D and its review (`0505e92`) survive every move. Namespaces move with `git mv` and are
  never retyped from an older copy. Every known-secret issue goes through `addKnownLocalSecretIssue`.
- Postgres:
  - tables leave `public` for the `identity` and `billing` schemas, plus a platform schema `app`;
  - each set keeps its history in `<schema>.__drizzle_migrations` and starts from a fresh `0000_init`;
  - the platform set runs first, and all sets run under one advisory lock.
- Every command runs on Node 24.4.0 (`nvm use 24.4.0`). The full Vitest run and GPG-signed commits run outside the
  sandbox. `bun install` runs one at a time, by the orchestrator only.
- Every task ends in a signed commit on `feat/domains-tenancy` whose message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed or merged without asking.
- Docker: never touch the developer's own containers (Postgres on 5432, Redis on 6379, MySQL) or the default
  `boilerplate` compose project. Every compose run loads
  [`checkpoint.env`](2026-10-12-b1-ownership-moves/artifacts/checkpoint/checkpoint.env) first: project `b1-verify`,
  shifted host ports, image tag `b1`.

## Review Focus

The five failure modes most likely to bite after B1 that no lane task tests. Each one's test is added to the task
that owns the code (see [Additions](#additions-the-review-focus-tests)):

1. **notifications-service's image ships identity's and billing's contracts, but not their domains** (spec §3.1). This
   was verified only on a simulated tree in a lab. Test: `platform-8`, A3.2.
2. **The compose stack still boots in production mode once guards live in domain namespaces** (`stripe`,
   `refreshToken`, …). Test: `platform-8`, A3.1, with a negative control.
3. **The refresh-secret guard matches the D review.** That means the shared message, the `<…>` and `...` placeholders,
   the `ALLOW_KNOWN_LOCAL_SECRETS` opt-out, and the dev default always refused. Test: `identity-5`, A1.
4. **A variable read by two namespaces agrees on its default.** `JWT_ACCESS_SECRET` is read by `auth` and by
   `refreshToken`'s must-differ rule. Test: `identity-5`, A1.
5. **Test-only subpaths never reach production source.** `@platform/auth/testing` signs tokens and `@domain/*/testing`
   holds fake ports. Test: `contracts-4`, A2.

---

## How to use this plan

- Each task's full text, steps and code are in its lane file under
  [`2026-10-12-b1-ownership-moves/lanes/`](2026-10-12-b1-ownership-moves/lanes/). Run the tasks in the
  [order below](#execution-order), not in lane order.
- Before a task, read its row below and its [rebase note](#rebase-notes-head-0505e92), if any. When a note and the
  lane text disagree, the note wins.
- Lane line numbers are hints taken at `74f70b7` (identity's: at `7040115` plus the D and F work then in progress).
  Match on quoted text. Where a lane says "D's version" or "as D committed it", read HEAD's file.
- Contracts patches are in
  [`artifacts/contracts/patches/`](2026-10-12-b1-ownership-moves/artifacts/contracts/patches/), applied from the repo
  root with `git apply --index <patch>`. If one fails, use `git apply --3way --index <patch>`, or apply the same step
  by hand from [`plan-contracts-lane.md`](2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md),
  which has every snippet inline.
- Totals in expected output (test counts, "112 files", package counts) were measured in the labs. A gate passes on
  zero failures, not on matching totals.
- `persistence-2` → `persistence-5` is a runtime window. In between, don't run `identity:int` or `database:int`, the
  apps, or `bun run db:migrate`.

## Execution order

| #   | Task          | Lane file                                                         | Needs                                         | Notes                |
| --- | ------------- | ----------------------------------------------------------------- | --------------------------------------------- | -------------------- |
| 1   | contracts-1   | [contracts](2026-10-12-b1-ownership-moves/lanes/contracts.md)     | —                                             | R2                   |
| 2   | contracts-2   | contracts                                                         | 1                                             | R2                   |
| 3   | contracts-3   | contracts                                                         | 2                                             | R2                   |
| 4   | platform-2    | [platform](2026-10-12-b1-ownership-moves/lanes/platform.md)       | —                                             | before 9, 12, 13, 17 |
| 5   | platform-1    | platform                                                          | —                                             |                      |
| 6   | platform-4    | platform                                                          | —                                             |                      |
| 7   | billing-1     | [billing](2026-10-12-b1-ownership-moves/lanes/billing.md)         | 3                                             | R3                   |
| 8   | billing-2     | billing                                                           | 7                                             |                      |
| 9   | billing-3     | billing                                                           | 4, 8                                          | R4                   |
| 10  | billing-4     | billing                                                           | 8                                             |                      |
| 11  | billing-5     | billing                                                           | —                                             |                      |
| 12  | billing-6     | billing                                                           | 1, 4, 11                                      |                      |
| 13  | billing-7     | billing                                                           | 4                                             |                      |
| 14  | identity-1    | [identity](2026-10-12-b1-ownership-moves/lanes/identity.md)       | —                                             |                      |
| 15  | identity-2    | identity                                                          | 14                                            |                      |
| 16  | identity-3    | identity                                                          | —                                             |                      |
| 17  | identity-4    | identity                                                          | 4, 15                                         |                      |
| 18  | identity-5    | identity                                                          | 9, 17                                         | R5, A1               |
| 19  | identity-6    | identity                                                          | 14, 15, 18                                    |                      |
| 20  | identity-7    | identity                                                          | 14, 15, 19                                    | R6                   |
| 21  | platform-3    | platform                                                          | 9, 20                                         | R7                   |
| 22  | platform-5    | platform                                                          | 3, 16, 19                                     |                      |
| 23  | persistence-1 | [persistence](2026-10-12-b1-ownership-moves/lanes/persistence.md) | —                                             |                      |
| 24  | persistence-2 | persistence                                                       | 23 (opens the runtime window)                 |                      |
| 25  | persistence-3 | persistence                                                       | 7, 24                                         |                      |
| 26  | persistence-4 | persistence                                                       | 25                                            |                      |
| 27  | persistence-5 | persistence                                                       | 26 (closes the runtime window)                |                      |
| 28  | persistence-6 | persistence                                                       | 27                                            |                      |
| 29  | persistence-7 | persistence                                                       | 28                                            | R10                  |
| 30  | platform-6    | platform                                                          | every task that rewrites `libs/` files (1–29) |                      |
| 31  | contracts-4   | contracts                                                         | 3, 7, 8                                       | R8, A2               |
| 32  | platform-8    | platform                                                          | all                                           | R9, A3               |

`platform-7` is not run: `contracts-4` supersedes it (decision 3).

## Cross-lane decisions

The lanes' own ordering notes disagreed in four places:

1. **billing-1 vs contracts-3.** Billing wanted its `Payment.user` move to land before contracts rewrites
   `billing.resolver.ts`. Contracts assumed it lands after `contracts-3`. Decided: contracts goes first, because its
   patches are exact. `billing-1` then deletes the import in its new form (R3).
2. **billing-5/6 vs contracts-1.** Not a real conflict. `billing-5` only adds the three client-URL namespaces, and
   `billing-6` already tolerates either order ("if it already reads the domain namespace, leave it"). Order:
   `contracts-1` → `billing-5` → `billing-6`.
3. **contracts-4 vs platform-7.** Both rewrite `scripts/check-boundaries.mjs` with the same rules. `contracts-4` wins:
   it commits a spec over throwaway repo trees and adds the relative-import rule. It also takes `platform-7`'s sorted
   visit order (A2). After all lanes, the check counts 26 packages: 24, plus 3 contracts packages, minus
   `libs/payments`.
4. **billing-3 vs platform-3 (a cycle).** `billing-3` wanted `platform-3`'s `validateAllEnv(env, extraNamespaces)`
   first, `platform-3` needed `billing-3` first, and identity wanted `platform-3` after `identity-7`. Decided:
   `billing-3` drops its env-example edit (R4), and `platform-3`'s Step 2 makes the same edit after `identity-7`. Until
   then, removing `stripe` from `CONFIG_NAMESPACES` only narrows what `validateAllEnv(env)` checks.

## Rebase notes (HEAD 0505e92)

F (`75c477a`) and the D review (`0505e92`) landed after the lanes were drafted. A mechanical pass compared every quoted
anchor with HEAD. These are the only places where an anchor or a pasted block no longer matches, or where pasting it
would undo the review.

**R1 (every task).** Line numbers are hints. Where a lane pastes a block "as D committed it", HEAD's text wins.

**R2 (contracts-1 to contracts-3).** The 18 patches touch no file that F or the review changed, except
`contracts-3-step13.patch` on `docs/DOCKER.md`. Its hunks apply cleanly to HEAD
(`git apply --check --include=docs/DOCKER.md`).

**R3 (billing-1, which runs after contracts-3).**

- By then, `billing.resolver.ts` imports `User` from `@domain/identity-contracts`, and contracts-3 has added
  `"@domain/identity-contracts": "workspace:*"` to `domains/billing/package.json`.
- Delete that import and that dependency along with `"@domain/identity"`. The task's own check,
  `git grep -n "@domain/identity" -- domains/billing` printing nothing, covers both.
- Then run `bun install`.

**R4 (billing-3).**

- Step 1: build the new spec from HEAD's tests, not from the pasted blocks:
  - `production-guards.spec.ts` → `describe('stripe', …)`: the placeholders, the compose fallbacks and the redirect
    URLs, with the shared message "is a publicly known value";
  - `namespaces.spec.ts`: the `stripeConfig.parse({})` defaults assertion and the
    `[stripeConfig, { STRIPE_WEBHOOK_SECRET: 'nope' }, 'STRIPE_WEBHOOK_SECRET']` row.

  Keep a local `errorOf`. `libs/config/test/error-of.ts` is not exported, and a domain must not reach into another
  package by path.

- Step 3, imports: at HEAD the moved file's relative imports are:
  - `defineConfigNamespace`;
  - `zBool, zInt, zNodeEnv, zStr, zUrl`;
  - a multi-line `addKnownLocalSecretIssue, isKnownLocalSecret, isPublicHttpsUrl` from `'../env/production-guards.js'`.

  Replace them with one `@platform/config` import of those names.

- Step 3, `libs/config/src/index.ts`: don't follow the "skip if `git grep production-guards` prints it" rule. HEAD
  already has `export { isGoogleApisHost } from './env/production-guards.js';`, so the check would wrongly skip.
  Replace that line with `export * from './env/production-guards.js';`.
- Step 4: `namespaces.spec.ts` no longer has `describe('stripe production placeholder guard')`.
  - In `namespaces.spec.ts`, delete `import { stripeConfig } from './stripe.config.js';`, the defaults assertion and
    the table row.
  - In `production-guards.spec.ts`, delete the multi-line stripe import, `describe('stripe', …)`, `COMPOSE`'s two
    `STRIPE_*` keys, and the `x-env-stripe` mention in its comment.
- Step 5: skip the `apps/billing-service/test/env-example.spec.ts` edit, and leave that file out of Step 8's
  `git add`. `platform-3` makes the change (decision 4).

**R5 (identity-5).**

- The refresh secret's known-value issue calls `addKnownLocalSecretIssue(ctx, 'JWT_REFRESH_SECRET')`, exported since
  billing-3, instead of the snippet's inline message.
- Tests on the old wording "publicly known local value" match "is a publicly known value" instead.
- Its `libs/config/src/index.ts` export step finds billing-3's `export *` and skips.
- Add A1.

**R6 (identity-7).**

- `production-guards.spec.ts`:
  - The import is already `import { authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';`. Leave it.
  - In `describe('auth', …)`, remove the refresh parts:
    - the two `→ at JWT_REFRESH_SECRET` assertions;
    - the whole "rejects identical access and refresh secrets in production" test, which lives on in identity's
      `refresh-token.config.spec.ts`;
    - `JWT_REFRESH_SECRET` in `COMPOSE` and in the last test's env.
- `namespaces.spec.ts`:
  - There is no `describe('auth production secret guard')` at HEAD, so drop the lane's replacement block.
  - The remaining edits are the `DEV_JWT_REFRESH_SECRET` import, `refreshSecret` and `refreshTtlSec` in the defaults
    assertion, and `JWT_REFRESH_SECRET` in the derived-values test.
- `auth.config.ts`: the access secret's known-value issue stays `addKnownLocalSecretIssue(ctx, 'JWT_ACCESS_SECRET')`.
- `.env.example`, the block from `# ── auth:` to `# ── throttle:`: keep HEAD's `ALLOW_KNOWN_LOCAL_SECRETS` sentence,
  "The JWT and Stripe development defaults are always rejected in production."

**R7 (platform-3).** HEAD's CONFIGURATION.md reads "138 distinct variables across the 14 shared namespaces
(`node scripts/check-env-example.mjs` prints the count).", followed by the `"—"` and `NODE_ENV` / `SERVICE_NAME`
sentences. Replace only that first sentence.

**R8 (contracts-4).** Step 5 expects `Layer boundaries OK (26 packages: apps -> domains -> contracts -> libs).`, not 27. Add A2.

**R9 (platform-8).**

- Step 6 expects the line from R8. `platform-7`'s wording is gone.
- Steps 11 and 12 run in the isolated project:
  - start with
    `set -a; . docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/checkpoint/checkpoint.env; set +a`;
  - `localhost:3000` becomes `localhost:$API_HOST_PORT`, and `localhost:8025` becomes `localhost:$MAILPIT_UI_HOST_PORT`;
  - the `down -v` calls stay as written: with `COMPOSE_PROJECT_NAME=b1-verify` they remove only `b1-verify`'s volumes.
- Add A3.

**R10 (persistence-7).** Load `checkpoint.env` before its check
`docker compose --profile '*' down -v && bun run docker:infra && bun run db:migrate && bun run db:migrate`. It exports
`DATABASE_URL=postgres://app:app@127.0.0.1:15432/app`, so `db:migrate` never falls back to the root `.env`'s
`localhost:5432`. Then verify and clean up:

```bash
docker compose exec -T postgres psql -U app -d app -Atc \
  "select schema_name from information_schema.schemata where schema_name in ('app', 'identity', 'billing') order by 1"
docker compose --profile '*' down -v --remove-orphans
```

Expected: `app`, `billing`, `identity`; the second `db:migrate` reports every set up to date.

## Additions: the Review Focus tests

### A1 (identity-5): refresh-secret guard parity and the shared access-secret default

Add these tests to `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts`, which already has a
local `errorOf`. Add the import at the top, and the `describe` after the existing ones:

```ts
import { DEV_JWT_ACCESS_SECRET } from '@platform/config';

describe('refreshToken production guards match the platform ones', () => {
  const PROD = { NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(48) } as const;

  it.each([
    'compose-local-refresh-secret-not-for-production-0002',
    '<a random secret of at least 32 characters>',
    'set-a-real-refresh-secret-here-please-...',
  ])('refuses the publicly known value %s with the shared message and opt-out', (value) => {
    const env = { ...PROD, JWT_REFRESH_SECRET: value };
    const error = errorOf(() => refreshTokenConfig.parse(env));
    expect(error.message).toContain('JWT_REFRESH_SECRET is a publicly known value');
    expect(error.message).toContain('ALLOW_KNOWN_LOCAL_SECRETS=true');
    expect(() =>
      refreshTokenConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }),
    ).not.toThrow();
  });

  it('compares with the auth default when JWT_ACCESS_SECRET is unset', () => {
    // refreshToken reads JWT_ACCESS_SECRET only for the must-differ rule. Its default must be auth's, or a refresh
    // secret equal to the access secret the services really use would pass.
    const error = errorOf(() =>
      refreshTokenConfig.parse({
        NODE_ENV: 'production',
        JWT_REFRESH_SECRET: DEV_JWT_ACCESS_SECRET,
        ALLOW_KNOWN_LOCAL_SECRETS: 'true',
      }),
    );
    expect(error.message).toContain('must differ');
  });
});
```

Run: `npx vitest run --project identity refresh-token.config.spec`.

Expected: PASS once R5 is applied. With the lane's inline message, the `it.each` cases fail on
`JWT_REFRESH_SECRET is a publicly known value`.

### A2 (contracts-4): test-only subpaths stay out of production source; sorted visits

In Step 1, after applying `contracts-4-step01.patch`, make two edits to `scripts/check-boundaries.spec.ts`.

First, the `LAYERED` fixture imports `@platform/contracts/testing` from a contracts package's `index.ts`, which the new
rule would rightly flag. Move that import to a spec file of the same package. Old:

```ts
  'domains/orders/contracts/src/index.ts': [
    "import { join } from 'node:path';",
    "import { defineEventContract } from '@platform/contracts';",
    "import { loadGrpcPackages } from '@platform/contracts/testing';",
    "import { z } from 'zod';",
    '',
  ].join('\n'),
```

New:

```ts
  'domains/orders/contracts/src/index.ts': [
    "import { join } from 'node:path';",
    "import { defineEventContract } from '@platform/contracts';",
    "import { z } from 'zod';",
    '',
  ].join('\n'),
  'domains/orders/contracts/src/index.spec.ts':
    "import { loadGrpcPackages } from '@platform/contracts/testing';\n",
```

Second, add this case as the last one in the `describe`:

```ts
it('keeps testing subpaths out of production source', () => {
  const { status, output } = check({
    ...LAYERED,
    'apps/api/src/wiring.ts': "import { FakeOrders } from '@domain/orders/testing';\n",
    'apps/api/test/support/app.ts': "import { FakeOrders } from '@domain/orders/testing';\n",
    'domains/orders/src/testing/fake-orders.ts':
      "import { signTestToken } from '@platform/kernel/testing';\n",
    'domains/orders/src/orders.int-spec.ts':
      "import { signTestToken } from '@platform/kernel/testing';\n",
  });
  expect(status).toBe(1);
  expect(output).toContain(
    'apps/api/src/wiring.ts: must not import "@domain/orders/testing" (test-only code',
  );
  expect(output).not.toContain('apps/api/test/support/app.ts');
  expect(output).not.toContain('fake-orders.ts');
  expect(output).not.toContain('orders.int-spec.ts');
});
```

Step 2 then fails with 11 tests instead of 10.

In Step 3's script, make three edits:

- Add these constants under `WORKSPACE_SCOPE`:

  ```js
  // `@<scope>/<pkg>/testing` subpaths hold fakes and test signers: test code may import them, production source never
  // (a fake port or a token signer must not be wired into a deployable).
  const TESTING_SUBPATH = /^@(?:app|domain|platform)\/[^/]+\/testing(?:\/|$)/;
  const TEST_CODE =
    /(?:^|[\\/])(?:test|testing)[\\/]|\.(?:spec|e2e-spec|int-spec|test)\.[cm]?[jt]sx?$/;
  ```

- In the source loop, insert this right before `const reason = violation(pkg.kind, pkg.domain, specifier);`:

  ```js
  if (TESTING_SUBPATH.test(specifier) && !TEST_CODE.test(relative(pkg.dir, file))) {
    problems.push(
      `${relative(root, file)}: must not import "${specifier}" (test-only code must not reach production source)`,
    );
  }
  ```

- For deterministic output (from `platform-7`), sort both directory walks. In `subdirs`, use
  `.filter((entry) => entry.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))`. In `sourceFiles`, use
  `readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))`.

Step 4 expects PASS with 11 tests. On the real repo, nothing in production source imports a `/testing` subpath today
(checked at HEAD), so Step 5 stays green.

### A3 (platform-8): domain namespaces in the compose check, and the image contents

**A3.1.** Add a new step between Step 10 (images) and Step 11 (monolith topology):

```bash
set -a; . docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/checkpoint/checkpoint.env; set +a
docker compose --profile microservices --profile monolith config --format json > "${TMPDIR:-/tmp}/b1-compose.json"
node docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/checkpoint/compose-guards.mjs "${TMPDIR:-/tmp}/b1-compose.json"
```

Expected: `OK: every app accepts its compose environment`. Every other line starts with `info`, for a namespace that
app does not load.

The script also loads the domain namespaces from each domain's `dist`. Its `DOMAIN` map comes from the lanes' text, not
from built output, and the script has only been syntax-checked so far: it cannot run before B1 builds those files. If
a path differs at the checkpoint, fix the map. Keep its `LOADS` map in sync with CONFIGURATION.md's "Which app loads
which namespace" table.

Negative control:

```bash
node -e 'const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const s of Object.values(c.services)) if (s.environment) delete s.environment.ALLOW_KNOWN_LOCAL_SECRETS; fs.writeFileSync(process.argv[2], JSON.stringify(c));' "${TMPDIR:-/tmp}/b1-compose.json" "${TMPDIR:-/tmp}/b1-compose.negative.json"
node docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/checkpoint/compose-guards.mjs "${TMPDIR:-/tmp}/b1-compose.negative.json"; echo "exit=$?"
```

Expected: `exit=1`, with `FAIL` lines for `stripe` (monolith, billing-service) and `refreshToken` (monolith,
identity-service) next to the platform ones. That proves the domain namespaces' guards are live. This assumes the
compose fallback secrets: if the root `.env` sets real JWT or Stripe secrets, those namespaces pass, so run the control
with them unset.

**A3.2.** In Step 12, right after `docker compose --profile microservices up -d --build --wait` (with `checkpoint.env`
loaded, so `TAG=b1`):

```bash
docker run --rm "boilerplate/notifications-service:${TAG}" -e '
const fs = require("node:fs");
for (const domain of ["identity", "billing"]) {
  const entries = fs.readdirSync(`/app/domains/${domain}`).sort();
  const built = fs.existsSync(`/app/domains/${domain}/contracts/dist/index.js`);
  console.log(domain, JSON.stringify(entries), built);
  if (entries.join() !== "contracts" || !built) process.exit(1);
}'; echo "exit=$?"
```

Expected: `identity ["contracts"] true`, `billing ["contracts"] true`, `exit=0`. The distroless image's entrypoint is
`node`, so `-e` runs the check inside it. If the contracts packages' built entry is not `dist/index.js`, check the
`exports` of their `package.json`.

## Checkpoint (B1 done)

All of `platform-8`, with R9 and A3:

- `bun run check`, ending with the line from R8;
- `bun run test`, outside the sandbox;
- `INTEGRATION=1 npx vitest run --project identity:int --project database:int --project billing:int`;
- `bun run build`, `node scripts/check-env-example.mjs` and the generated-code drift checks;
- both images (monolith, gateway);
- A3.1 and its negative control;
- both topologies in the isolated project: `app|1`, `identity|1`, `billing|1`, and the welcome mail rendered from
  notifications' templates;
- A3.2;
- the signed checkpoint commit.

## Spec coverage

| Spec item                                                                                                       | Tasks                                                      |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| §3.2 per-domain contracts packages; `libs/contracts` keeps the generic envelope, headers, topic helpers and buf | contracts-3                                                |
| §3.2 transport takes values: a `GrpcPackageSpec` plus URL, one event contract per topic                         | contracts-1, contracts-2                                   |
| §3.2 the `stripe` namespace and `libs/payments` move to billing; barrel collisions renamed                      | billing-2, billing-3                                       |
| §3.2 `PasswordHasher` and the argon2 settings move to identity                                                  | identity-4                                                 |
| §3.2 token issuance moves to identity; `@platform/auth` keeps verification; `@platform/auth/testing` signer     | identity-1, identity-2, identity-5, identity-6, identity-7 |
| §3.2 gRPC client URLs move to each domain's `forRemote()` config, same env names                                | billing-5, billing-6                                       |
| §3.2 upload limits move to `domains/files`, same env names                                                      | billing-7                                                  |
| §3.2 mail templates move to the sending domain; `@platform/mailer` is template-agnostic                         | platform-1                                                 |
| §3.2 `STRIPE_SIGNATURE` and `normalizeEmail`                                                                    | billing-4, identity-3                                      |
| §3.2 migrations and `drizzle.config.ts` per Postgres domain                                                     | persistence-1 to persistence-7                             |
| §3.2 app test fakes move to `./testing` subpaths                                                                | platform-5                                                 |
| §3.2 platform-only `CONFIG_NAMESPACES`; `validateAllEnv` takes domain namespaces; the env check scans domains   | platform-2, platform-3                                     |
| §3.1 cross-domain imports only through `-contracts`; nested workspaces; notifications needs only contracts      | contracts-3, contracts-4 (A2), platform-8 (A3.2)           |
| §3.1 `Payment.user` is composed in the monolith and the gateway                                                 | billing-1                                                  |
| §4 schemas `app`, `identity`, `billing`; per-schema histories; platform set first, one lock; fresh `0000_init`  | persistence-1 to persistence-7                             |
| §1 success: `libs/` names no domain                                                                             | platform-6, contracts-4                                    |
| §1 success: check, tests, builds, both images and the compose topologies stay green                             | platform-8 (A3)                                            |
| Same intent, beyond §3.2's rows: domains contribute their own log redaction paths                               | platform-4                                                 |

Out of B1: tenancy (B2); database roles, `FORCE ROW LEVEL SECURITY`, the boot guard and the system pool (B3). Still as
before B1: the monolith and the gateway have no env-example spec. A3.1 covers their compose environment.
