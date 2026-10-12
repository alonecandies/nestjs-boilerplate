# Lane persistence: per-domain Postgres schemas and migration histories (B1)

This file is the full lane, with every code block.

Lab evidence (scratchpad `lab-persistence/`, read-only on the repo, drizzle-kit 0.31.11 + drizzle-orm 0.45.4 from the
repo's `node_modules`):

- With `pgSchema('identity')` exported, `drizzle-kit generate --name init` writes `0000_init.sql` whose first statement
  is `CREATE SCHEMA "identity";` (no `IF NOT EXISTS`, `node_modules/drizzle-kit/bin.cjs:25106`). drizzle-orm's
  migrator runs `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>` and creates the bookkeeping table **before** it reads
  any file (`node_modules/drizzle-orm/pg-core/dialect.js`, `migrate()`), so with bookkeeping in
  `identity.__drizzle_migrations` the generated line would fail on a fresh database. Each baseline gets one hand edit
  to `CREATE SCHEMA IF NOT EXISTS`; `generate` stays a no-op afterwards (it diffs snapshots, never SQL). If the
  `pgSchema` object is NOT exported, drizzle-kit emits no `CREATE SCHEMA` and records no schema in the snapshot, and a
  later export would generate a failing `CREATE SCHEMA` migration: the schema objects are exported.
- The trigram index (`users_search_trgm_idx`, today hand-added in `0001_users_search_trgm.sql`) and
  `stripe_events_processed_at_idx` (today `0002`) both come out of `generate` in the new baselines because the schema
  files declare them. Only `CREATE EXTENSION pg_trgm` is hand-written, and it moves to the platform set.
- `drizzle-kit generate` ignores `schemaFilter` (`bin.cjs:19850` calls `serializePg(schemaPath, casing2)` without
  it; only push/pull use it, `bin.cjs:15393`, `:15518`). `migrations: { schema, table }` is read by `drizzle-kit
  migrate` (`bin.cjs:15751`). Both keys exist in `node_modules/drizzle-kit/index.d.ts` (`schemaFilter?: string |
  string[]`, `migrations?: { table?; schema?; prefix? }`).
- `drizzle-kit generate --custom` without a `schema` key exits 1 ("Please provide required params: schema:
  undefined", `bin.cjs:15305-15311`); with an empty schema file (`export {}`) it works but writes a snapshot too. The
  platform set therefore keeps a **hand-written** `meta/_journal.json`: it has no Drizzle schema by design (schema
  `app`, extensions, and from B3 roles, grants and functions, none of which drizzle-kit models), the runtime migrator
  reads only `_journal.json` + `<tag>.sql` (`node_modules/drizzle-orm/migrator.js`), and a config plus an empty schema
  file in `libs/database` would only exist to append journal entries. A unit spec checks the journal.
- With `pgSchema`, drizzle renders `from "identity"."users"` and columns as `"identity"."users"."id"`
  (`node_modules/drizzle-orm/sql/sql.js:118-127`); select lists, `set`, `returning` and `on conflict` targets stay
  unqualified. Every expected SQL string below was rendered from the real query builders.
- `bun run --filter '@domain/*' <script>` skips packages without the script, forwards extra args (`--name init`), and
  propagates a failing exit code; it honours workspace dependency order (a dependent's script waits for its
  dependency's script to exit).
- git pathspec `'domains/*/src/infrastructure/persistence/migrations'` matches nothing; the trailing `/*` form matches
  modified, new and untracked files (verified in a scratch repo).
- Dry run of this plan on copies of `libs/database`, `domains/identity`, `domains/billing` and the app files (applied
  mechanically from the code blocks below, so every "old" snippet was matched verbatim against the current repo):
  `tsc` clean for all three packages and the new app files; Vitest: `database` 74/74, the seven changed identity and
  billing spec files 41/41, the three app `database.migrations.spec.ts` 3/3; generated baselines identical to the
  SQL shown below. Not run (need Postgres/Docker): the three `*:int` specs, which typecheck.
- Nest's `ConsoleLogger` with `json: true` prints nothing for a lone stack-formatted string (`printStackTrace` is a
  no-op in JSON mode), so today's `logger.error(error.stack ?? error.message)` in `libs/database/src/migrate.ts`
  drops single-line errors. `runMigrationsCli` logs the `Error` object instead (serialised with message and stack).

Task order: persistence-1 → persistence-2 → persistence-3 → persistence-4 → persistence-5 → persistence-6 →
persistence-7 (persistence-3 relies on persistence-2's root `db:generate` glob, CI pathspec and the removed combined
`libs/database/drizzle.config.ts`). Between persistence-2 and persistence-5 the code queries `identity.*` / `billing.*`
while boot still applies the old combined `public` history (persistence-4 then applies only the platform set): do not
run `*:int` or the apps against a real database inside that window; persistence-5 closes it.

### Task persistence-1: Migration set contract and the platform set in @platform/database

**Files:**

- Modify: `libs/database/src/database.types.ts:13` (add `DatabaseMigrationSet` above `DatabaseModuleOptions`)
- Create: `libs/database/src/platform/migrations/0000_init.sql`
- Create: `libs/database/src/platform/migrations/meta/_journal.json`
- Create: `libs/database/src/platform/platform.migrations.ts`
- Create: `libs/database/src/migrator/migration-sets.ts`
- Modify: `libs/database/src/index.ts:29-31`
- Modify: `libs/database/README.md:16-37` (Public API rows) and append a "Platform migration set" section
- Test: `libs/database/src/platform/platform.migrations.spec.ts`
- Test: `libs/database/src/migrator/migration-sets.spec.ts`

**Interfaces:**

- Consumes: `MIGRATIONS_TABLE` (`'__drizzle_migrations'`, `libs/database/src/migrator/migrations.constants.ts:8`).
- Produces:
  - `interface DatabaseMigrationSet { readonly name: string; readonly folder: string; readonly migrationsSchema: string; readonly migrationsTable: string }`
  - `const platformMigrations: DatabaseMigrationSet` = `{ name: 'platform', folder: libs/database/{src|dist}/platform/migrations, migrationsSchema: 'app', migrationsTable: '__drizzle_migrations' }`
  - `function withPlatformMigrations(sets: readonly DatabaseMigrationSet[]): readonly DatabaseMigrationSet[]` returns `[platformMigrations, ...sets]`; throws when a set name repeats or two sets share `<migrationsSchema>.<migrationsTable>`.

- [ ] **Step 1: Write the failing specs**

`libs/database/src/platform/platform.migrations.spec.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_TABLE } from '../migrator/migrations.constants.js';
import { platformMigrations } from './platform.migrations.js';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const readJournal = (): Journal =>
  JSON.parse(
    readFileSync(join(platformMigrations.folder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;

describe('platformMigrations', () => {
  it('is the platform set: src/platform/migrations, bookkeeping in app.__drizzle_migrations', () => {
    expect(platformMigrations).toEqual({
      name: 'platform',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'app',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('has a hand-written journal drizzle can apply: one entry per file, in order', () => {
    const journal = readJournal();
    expect(journal).toMatchObject({ version: '7', dialect: 'postgresql' });
    expect(journal.entries.length).toBeGreaterThan(0);
    let previousWhen = 0;
    for (const [index, entry] of journal.entries.entries()) {
      expect(entry).toMatchObject({ idx: index, version: '7', breakpoints: true });
      expect(entry.tag.startsWith(`${String(index).padStart(4, '0')}_`)).toBe(true);
      // drizzle applies only files whose `when` is newer than the last applied one.
      expect(entry.when).toBeGreaterThan(previousWhen);
      previousWhen = entry.when;
      expect(existsSync(join(platformMigrations.folder, `${entry.tag}.sql`))).toBe(true);
    }
    const files = readdirSync(platformMigrations.folder).filter((file) => file.endsWith('.sql'));
    expect(files.toSorted()).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));
  });

  it('0000_init creates the app schema and pg_trgm in public', () => {
    const sql = readFileSync(join(platformMigrations.folder, '0000_init.sql'), 'utf8');
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "app";');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;');
  });
});
```

`libs/database/src/migrator/migration-sets.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { withPlatformMigrations } from './migration-sets.js';
import { MIGRATIONS_TABLE } from './migrations.constants.js';

const set = (
  name: string,
  overrides: Partial<DatabaseMigrationSet> = {},
): DatabaseMigrationSet => ({
  name,
  folder: `/migrations/${name}`,
  migrationsSchema: name,
  migrationsTable: MIGRATIONS_TABLE,
  ...overrides,
});

describe('withPlatformMigrations', () => {
  it('puts the platform set first, then the given sets in array order', () => {
    const [identity, billing] = [set('identity'), set('billing')];
    expect(withPlatformMigrations([identity, billing])).toEqual([
      platformMigrations,
      identity,
      billing,
    ]);
    expect(withPlatformMigrations([billing, identity])).toEqual([
      platformMigrations,
      billing,
      identity,
    ]);
  });

  it('applies the platform set alone for a process that owns no tables', () => {
    expect(withPlatformMigrations([])).toEqual([platformMigrations]);
  });

  it('rejects the platform set passed by the caller: it always runs first', () => {
    expect(() => withPlatformMigrations([set('identity'), platformMigrations])).toThrow(
      /"platform" is listed twice/,
    );
  });

  it('rejects a set listed twice', () => {
    const identity = set('identity');
    expect(() => withPlatformMigrations([identity, identity])).toThrow(/"identity" is listed twice/);
  });

  it('rejects two sets sharing one bookkeeping table (drizzle would skip the older files)', () => {
    expect(() =>
      withPlatformMigrations([set('identity'), set('audit', { migrationsSchema: 'identity' })]),
    ).toThrow(/"identity" and "audit" share identity\.__drizzle_migrations/);
    expect(() => withPlatformMigrations([set('ledger', { migrationsSchema: 'app' })])).toThrow(
      /"platform" and "ledger" share app\.__drizzle_migrations/,
    );
  });
});
```

- [ ] **Step 2: Run the specs and watch them fail**

Run: `npx vitest run --project database platform.migrations migration-sets`
Expected: FAIL, both files: `Failed to load url ./platform.migrations.js` / `./migration-sets.js` (the modules do
not exist yet).

- [ ] **Step 3: Add the `DatabaseMigrationSet` contract**

In `libs/database/src/database.types.ts`, old:

```ts
export interface DatabaseModuleOptions<TSchema extends DrizzleSchema = DrizzleSchema> {
```

new:

```ts
/**
 * One migration history: a drizzle-kit output folder plus its OWN bookkeeping table. Each domain
 * exports one (`identityMigrations`, `billingMigrations`); `platformMigrations` always runs first.
 */
export interface DatabaseMigrationSet {
  /** Label in logs and run summaries; unique within one process. */
  readonly name: string;
  /** `meta/_journal.json` + `NNNN_*.sql`, resolved from `import.meta.dirname` (src or dist). */
  readonly folder: string;
  /** Schema of the bookkeeping table `<migrationsSchema>.<migrationsTable>`, never shared. */
  readonly migrationsSchema: string;
  readonly migrationsTable: string;
}

export interface DatabaseModuleOptions<TSchema extends DrizzleSchema = DrizzleSchema> {
```

- [ ] **Step 4: Write the platform set's SQL and its hand-written journal**

`libs/database/src/platform/migrations/0000_init.sql`:

```sql
-- @platform/database platform set: applied before every domain set, under the same advisory lock.
-- Hand-written: drizzle-kit has no schema to diff here. Never edit an applied file; add the next one
-- and its meta/_journal.json entry (libs/database/README.md, "Platform migration set").
-- The migrator already created "app" for app.__drizzle_migrations: IF NOT EXISTS keeps this valid alone.
CREATE SCHEMA IF NOT EXISTS "app";--> statement-breakpoint
-- pg_trgm backs identity's users_search_trgm_idx (drizzle-kit does not emit extensions). Trusted
-- since PG13, so the database owner may create it. Pinned to public: drizzle-kit writes the opclass
-- unqualified (gin_trgm_ops), and public is on the default search_path of every role.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

`libs/database/src/platform/migrations/meta/_journal.json` (drizzle-kit's journal format; `when` =
2026-10-12T00:00:00Z):

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1791763200000,
      "tag": "0000_init",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 5: Implement `platformMigrations` and `withPlatformMigrations`, export them**

`libs/database/src/platform/platform.migrations.ts`:

```ts
import { join } from 'node:path';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_TABLE } from '../migrator/migrations.constants.js';

/**
 * The platform migration set: the SQL no domain owns. It creates the `app` schema (bookkeeping in
 * `app.__drizzle_migrations`; B3 adds the RLS helper functions there) and the extensions domain
 * tables rely on (pg_trgm). Always applied first, under the same advisory lock as the domain sets
 * (`withPlatformMigrations`). The files are hand-written, see the README "Platform migration set".
 * `folder` resolves to src/ in dev and dist/ after the build (SWC copyFiles ships .sql and meta/).
 */
export const platformMigrations: DatabaseMigrationSet = {
  name: 'platform',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: 'app',
  migrationsTable: MIGRATIONS_TABLE,
};
```

`libs/database/src/migrator/migration-sets.ts`:

```ts
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';

/**
 * The sets one process applies, in order: `platformMigrations` first (it cannot be left out or
 * reordered), then `sets` in array order. Rejects a set listed twice and two sets sharing one
 * bookkeeping table: drizzle's migrator compares file timestamps only with the newest row of the
 * table it writes to, so the set with older timestamps would be skipped silently.
 */
export function withPlatformMigrations(
  sets: readonly DatabaseMigrationSet[],
): readonly DatabaseMigrationSet[] {
  const ordered = [platformMigrations, ...sets];
  const names = new Set<string>();
  const tableOwners = new Map<string, string>();
  for (const set of ordered) {
    if (names.has(set.name)) {
      throw new Error(
        `Migration set "${set.name}" is listed twice` +
          (set.name === platformMigrations.name
            ? ': the platform set always runs first, do not pass it'
            : ''),
      );
    }
    names.add(set.name);
    const table = `${set.migrationsSchema}.${set.migrationsTable}`;
    const owner = tableOwners.get(table);
    if (owner !== undefined) {
      throw new Error(
        `Migration sets "${owner}" and "${set.name}" share ${table}: give each set its own bookkeeping table`,
      );
    }
    tableOwners.set(table, set.name);
  }
  return ordered;
}
```

In `libs/database/src/index.ts`, old:

```ts
export * from './health/database.health.js';
export * from './migrator/migrations.constants.js';
export * from './migrator/run-migrations.js';
export * from './pagination/keyset.js';
```

new:

```ts
export * from './health/database.health.js';
export * from './migrator/migration-sets.js';
export * from './migrator/migrations.constants.js';
export * from './migrator/run-migrations.js';
export * from './pagination/keyset.js';
export * from './platform/platform.migrations.js';
```

- [ ] **Step 6: Run the specs**

Run: `npx vitest run --project database`
Expected: PASS (the two new files plus every existing `database` spec).

- [ ] **Step 7: Check that the build ships the platform set**

Run: `bun run --filter @platform/database build && test -f libs/database/dist/platform/migrations/0000_init.sql && test -f libs/database/dist/platform/migrations/meta/_journal.json && echo shipped`
Expected: `shipped` (SWC `copyFiles`, `swc.cli.json:6`; `scripts/docker/assemble-image.mjs:114-120` checks the same
assets in images).

- [ ] **Step 8: Document the platform set in the package README**

In `libs/database/README.md`, insert after the `DatabaseTransactionalOptions` row of the Public API table:

```markdown
| `DatabaseMigrationSet`                                                                                                                                  | interface       | `{ name; folder; migrationsSchema; migrationsTable }`: one migration history with its own bookkeeping table                             |
| `platformMigrations`                                                                                                                                    | const           | The platform set (`src/platform/migrations`, bookkeeping `app.__drizzle_migrations`): always applied first                              |
| `withPlatformMigrations(sets)`                                                                                                                          | fn              | `[platformMigrations, ...sets]`; throws on a set listed twice or two sets sharing a bookkeeping table                                   |
```

and append at the end of the file:

```markdown
## Platform migration set

`platformMigrations` (`src/platform/migrations`, bookkeeping in `app.__drizzle_migrations`) holds the SQL no domain
owns: the `app` schema and the extensions domain tables rely on (`pg_trgm` for identity's trigram index, created
`WITH SCHEMA public` because drizzle-kit writes `gin_trgm_ops` unqualified). It is applied before every domain set,
under the same advisory lock, and cannot be left out.

The files are hand-written: drizzle-kit has nothing to diff here, and `drizzle-kit generate --custom` refuses to run
without a schema file. The runtime migrator reads only `meta/_journal.json` and the `.sql` files. To add a file:

1. create `src/platform/migrations/NNNN_<name>.sql` (next index; statements separated by `--> statement-breakpoint`);
2. append `{ "idx": N, "version": "7", "when": <Date.now()>, "tag": "NNNN_<name>", "breakpoints": true }` to
   `src/platform/migrations/meta/_journal.json`. `when` must be larger than the previous entry's: drizzle applies only
   files newer than the last applied one;
3. never edit an applied file. `platform.migrations.spec.ts` checks the journal against the folder.
```

- [ ] **Step 9: Format and run the repository gate**

Run: `bunx biome check --write libs/database/src && bunx prettier --write libs/database/README.md && bun run check`
Expected: PASS (biome ci, eslint, prettier --check, tsc, boundaries).

- [ ] **Step 10: Commit**

```bash
git add libs/database/src/database.types.ts libs/database/src/platform libs/database/src/migrator/migration-sets.ts \
  libs/database/src/migrator/migration-sets.spec.ts libs/database/src/index.ts libs/database/README.md
git commit -F- <<'EOF'
feat(database): add migration sets and the platform migration set

- DatabaseMigrationSet: one drizzle-kit history with its own bookkeeping table
- platformMigrations: schema app and pg_trgm (WITH SCHEMA public), hand-written journal
- withPlatformMigrations(): platform set first, rejects repeated sets and shared tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-2: identity tables move to the `identity` schema with their own history

**Files:**

- Modify: `domains/identity/src/infrastructure/persistence/identity.schema.ts:2,5-19,21-26,34,51`
- Create: `domains/identity/drizzle.config.ts`
- Create: `domains/identity/src/infrastructure/persistence/identity.migrations.ts`
- Create (generated): `domains/identity/src/infrastructure/persistence/migrations/0000_init.sql`,
  `.../migrations/meta/0000_snapshot.json`, `.../migrations/meta/_journal.json`
- Modify: `domains/identity/src/index.ts:67-68`
- Modify: `domains/identity/package.json` (`scripts`, `devDependencies`)
- Modify: `libs/database/package.json` (`scripts`: drop `db:generate`, `db:studio`)
- Delete: `libs/database/drizzle.config.ts`
- Modify: `package.json` (root `db:generate`, `db:studio`)
- Modify: `.github/workflows/ci.yml:80-81`
- Modify: `bun.lock` (via `bun install`)
- Modify (SQL-text expectations): `domains/identity/src/infrastructure/persistence/drizzle-users.repository.spec.ts:56,72,79,92,112,123,142,175,179,189,201`,
  `domains/identity/src/infrastructure/persistence/drizzle-sessions.repository.spec.ts:36,53,77,79,87`,
  `domains/identity/src/identity-api.module.spec.ts:32,46,115-117`, `domains/identity/src/identity-grpc.module.spec.ts:17,78`,
  `apps/identity-service/test/app.e2e-spec.ts:60`
- Modify: `domains/identity/README.md:201-208`, `docs/SECURITY.md:153`
- Test: `domains/identity/src/infrastructure/persistence/identity.migrations.spec.ts`

**Interfaces:**

- Consumes: `DatabaseMigrationSet`, `MIGRATIONS_TABLE` from `@platform/database` (persistence-1).
- Produces:
  - `export const identityPgSchema = pgSchema('identity')` (identity.schema.ts)
  - `export const identityMigrations: DatabaseMigrationSet` = `{ name: 'identity', folder: domains/identity/{src|dist}/infrastructure/persistence/migrations, migrationsSchema: 'identity', migrationsTable: '__drizzle_migrations' }`, re-exported from `@domain/identity`
  - `domains/identity/drizzle.config.ts` (out `./src/infrastructure/persistence/migrations`, `schemaFilter: ['identity']`, `migrations: { schema: 'identity', table: '__drizzle_migrations' }`)
  - `@domain/identity` scripts `db:generate` (`drizzle-kit generate`), `db:studio` (`drizzle-kit studio`, port 4983)
  - root scripts `db:generate` = `bun run --filter '@domain/*' db:generate`, `db:studio` = `bun run --filter '@domain/*' db:studio`
  - CI drift pathspec `'domains/*/src/infrastructure/persistence/migrations/*'`

- [ ] **Step 1: Write the failing spec**

`domains/identity/src/infrastructure/persistence/identity.migrations.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIGRATIONS_TABLE } from '@platform/database';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { identityMigrations } from './identity.migrations.js';
import { identityPgSchema, sessions, userRole, users } from './identity.schema.js';

describe('identityMigrations', () => {
  it("is identity's own history: ./migrations, bookkeeping in identity.__drizzle_migrations", () => {
    expect(identityMigrations).toEqual({
      name: 'identity',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'identity',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every identity table and enum in the identity Postgres schema', () => {
    expect(identityPgSchema.schemaName).toBe(identityMigrations.migrationsSchema);
    expect([users, sessions].map((table) => getTableConfig(table).schema)).toEqual([
      'identity',
      'identity',
    ]);
    expect(userRole.schema).toBe('identity');
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(identityMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([identityMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: identityMigrations.migrationsSchema,
      table: identityMigrations.migrationsTable,
    });
  });

  it('creates its schema idempotently (the migrator creates it first) and carries the trigram index', () => {
    const baseline = readFileSync(join(identityMigrations.folder, '0000_init.sql'), 'utf8');
    expect(baseline).toContain('CREATE SCHEMA IF NOT EXISTS "identity";');
    expect(baseline).not.toMatch(/^CREATE SCHEMA "identity";/m);
    expect(baseline).toContain(
      'CREATE INDEX "users_search_trgm_idx" ON "identity"."users" USING gin',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project identity identity.migrations`
Expected: FAIL: `Failed to load url ../../../drizzle.config.js` / `./identity.migrations.js` (not created yet).

- [ ] **Step 3: Move the identity tables into `pgSchema('identity')`**

In `domains/identity/src/infrastructure/persistence/identity.schema.ts` apply these replacements.

old (line 2):

```ts
import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
```

new:

```ts
import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
```

old (lines 6-7):

```ts
 * Identity tables (drizzle-kit reads this file: ONLY drizzle-orm imports + dependency-free
 * relative files — see blueprint §3.6). Column names come from `casing: 'snake_case'`.
```

new:

```ts
 * Identity tables (drizzle-kit reads this file: ONLY drizzle-orm imports + dependency-free
 * relative files — see blueprint §3.6). Column names come from `casing: 'snake_case'`.
 *
 * Every table and enum lives in the `identity` Postgres schema, with identity's own migration
 * history (./migrations, generated by ../../../drizzle.config.ts, bookkeeping in
 * `identity.__drizzle_migrations`). Raw SQL qualifies names (`identity.users`): no role's
 * search_path includes `identity`.
```

old (lines 16-18):

```ts
 * hence `IDENTITY_LIMITS.SEARCH_MIN_LENGTH`. The migration that creates it starts with
 * `CREATE EXTENSION IF NOT EXISTS pg_trgm` (hand-added: drizzle-kit does not emit extensions;
 * pg_trgm is a trusted extension, so the database owner may create it).
```

new:

```ts
 * hence `IDENTITY_LIMITS.SEARCH_MIN_LENGTH`. drizzle-kit does not emit extensions: pg_trgm comes
 * from @platform/database's platform set (in schema public), which always runs before this history.
```

old (lines 21-26):

```ts
const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

/** RBAC roles (values = @platform/auth `Role`). */
export const userRole = pgEnum('user_role', USER_ROLES);

export const users = pgTable(
```

new:

```ts
/**
 * The `identity` Postgres schema. Exported: drizzle-kit only emits `CREATE SCHEMA` (and records
 * it in the snapshot) for exported schemas.
 */
export const identityPgSchema = pgSchema('identity');

const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

/** RBAC roles (values = @platform/auth `Role`). */
export const userRole = identityPgSchema.enum('user_role', USER_ROLES);

export const users = identityPgSchema.table(
```

old (line 34):

```ts
    roles: userRole().array().notNull().default(sql`ARRAY['user']::user_role[]`),
```

new:

```ts
    // Qualified: the cast is resolved when CREATE TABLE runs, and `identity` is not on search_path.
    roles: userRole().array().notNull().default(sql`ARRAY['user']::identity.user_role[]`),
```

old (line 51):

```ts
export const sessions = pgTable(
```

new:

```ts
export const sessions = identityPgSchema.table(
```

- [ ] **Step 4: Add the migration set and the domain drizzle-kit config**

`domains/identity/src/infrastructure/persistence/identity.migrations.ts`:

```ts
import { join } from 'node:path';
import { type DatabaseMigrationSet, MIGRATIONS_TABLE } from '@platform/database';
import { identityPgSchema } from './identity.schema.js';

/**
 * Identity's own Postgres migration history: ./migrations, generated from identity.schema.ts by
 * ../../../drizzle.config.ts, bookkeeping in `identity.__drizzle_migrations`. Apps that own
 * identity's tables list it in `DatabaseModule.forRootAsync({ migrations })` and in their
 * `migrate.ts`; the platform set always runs before it. src/ in dev, dist/ after the build.
 */
export const identityMigrations: DatabaseMigrationSet = {
  name: 'identity',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: identityPgSchema.schemaName,
  migrationsTable: MIGRATIONS_TABLE,
};
```

`domains/identity/drizzle.config.ts`:

```ts
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

/*
 * drizzle-kit config of the identity context: `bun run db:generate` / `db:studio` in this package,
 * or `bun run db:generate` at the root for every domain. The output is identity's own migration
 * history; `identityMigrations` (src/infrastructure/persistence/identity.migrations.ts) applies it
 * after @platform/database's platform set.
 *
 * - Paths are resolved relative to THIS file, then made cwd-relative (what drizzle-kit expects),
 *   so the config works from any working directory. drizzle-kit loads configs as CJS with its own
 *   loader: `import.meta.url` is polyfilled but `import.meta.dirname` is not, and the
 *   `@repo/source` condition is unknown, so neither this file nor the schema imports a workspace
 *   package.
 * - `schemaFilter` scopes push/pull/introspection to `identity` (`generate` ignores it);
 *   `migrations` is what `drizzle-kit migrate` would use. Both MUST equal `identityMigrations`;
 *   identity.migrations.spec.ts checks it.
 * - Reading process.env here is a documented exception to the "config only via @platform/config" rule.
 */
const fromCwd = (path: string): string =>
  relative(process.cwd(), fileURLToPath(new URL(path, import.meta.url))) || '.';

export default defineConfig({
  dialect: 'postgresql',
  schema: fromCwd('./src/infrastructure/persistence/identity.schema.ts'),
  out: fromCwd('./src/infrastructure/persistence/migrations'),
  // MUST equal the runtime `drizzle({ casing })` in @platform/database.
  casing: 'snake_case',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app' },
  schemaFilter: ['identity'],
  migrations: { schema: 'identity', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 5: Move drizzle-kit scripts from @platform/database to the domain, then install**

`domains/identity/package.json`, old:

```json
    "clean": "rimraf dist coverage"
  },
```

new:

```json
    "clean": "rimraf dist coverage",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio"
  },
```

and add `"drizzle-kit": "catalog:"` as the last entry of its `devDependencies` (after `"@types/passport-local": "catalog:"`, which gains a trailing comma).

`libs/database/package.json`, old:

```json
    "clean": "rimraf dist coverage",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node --env-file-if-exists=../../.env dist/migrate.js",
    "db:migrate:dev": "node --env-file-if-exists=../../.env --conditions=@repo/source --import @swc-node/register/esm-register src/migrate.ts",
    "db:studio": "drizzle-kit studio"
  },
```

new (its `drizzle-kit` devDependency stays: the README's fixture command uses it):

```json
    "clean": "rimraf dist coverage",
    "db:migrate": "node --env-file-if-exists=../../.env dist/migrate.js",
    "db:migrate:dev": "node --env-file-if-exists=../../.env --conditions=@repo/source --import @swc-node/register/esm-register src/migrate.ts"
  },
```

Root `package.json`, old:

```json
    "db:generate": "bun run --filter @platform/database db:generate",
    "db:migrate": "bun run --filter @platform/database db:migrate:dev",
    "db:studio": "bun run --filter @platform/database db:studio",
```

new:

```json
    "db:generate": "bun run --filter '@domain/*' db:generate",
    "db:migrate": "bun run --filter @platform/database db:migrate:dev",
    "db:studio": "bun run --filter '@domain/*' db:studio",
```

Then delete the combined config (its globs would now diff identity's moved tables into the old history) and install:

```bash
git rm libs/database/drizzle.config.ts
bun install
```

Expected: `bun install` succeeds and `git diff --stat bun.lock` shows the `domains/identity` workspace entry changed.

- [ ] **Step 6: Generate identity's baseline**

Run: `bun run --filter @domain/identity db:generate --name init`
Expected output ends with `[✓] Your SQL migration file ➜ src/infrastructure/persistence/migrations/0000_init.sql`,
and three new files exist: `0000_init.sql`, `meta/0000_snapshot.json`, `meta/_journal.json` (one entry, tag
`0000_init`; `when`, the snapshot `id` are generation-time values: commit them as generated).

- [ ] **Step 7: Make the baseline's `CREATE SCHEMA` idempotent (the one hand edit)**

```bash
perl -0pi -e 's/\ACREATE SCHEMA "identity";\n/-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for identity.__drizzle_migrations.\nCREATE SCHEMA IF NOT EXISTS "identity";\n/' \
  domains/identity/src/infrastructure/persistence/migrations/0000_init.sql
```

The file must now read exactly (drizzle-kit 0.31.11 output plus the edited first two lines):

```sql
-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for identity.__drizzle_migrations.
CREATE SCHEMA IF NOT EXISTS "identity";
--> statement-breakpoint
CREATE TYPE "identity"."user_role" AS ENUM('admin', 'moderator', 'user');--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"roles" "identity"."user_role"[] DEFAULT ARRAY['user']::identity.user_role[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "identity"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "identity"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_search_trgm_idx" ON "identity"."users" USING gin ("email" gin_trgm_ops,"display_name" gin_trgm_ops);
```

If drizzle-kit's output differs anywhere else, stop and compare against the schema edits of Step 3.

- [ ] **Step 8: Prove regeneration is a no-op and run the spec**

Run: `bun run db:generate && git status --porcelain -- 'domains/*/src/infrastructure/persistence/migrations/*'`
Expected: identity prints `No schema changes, nothing to migrate`; status lists only
`?? domains/identity/src/infrastructure/persistence/migrations/`.

Run: `npx vitest run --project identity identity.migrations`
Expected: PASS (4 tests).

- [ ] **Step 9: Qualify the SQL-text expectations of the identity unit specs**

Replace each string/regex literal (each is unique in its file unless noted):

`domains/identity/src/infrastructure/persistence/drizzle-users.repository.spec.ts`

```text
'select "id", "email", "display_name", "roles", "created_at", "updated_at" from "users" where "users"."id" = $1 limit $2'
→ 'select "id", "email", "display_name", "roles", "created_at", "updated_at" from "identity"."users" where "identity"."users"."id" = $1 limit $2'

'where "users"."email" = $1'
→ 'where "identity"."users"."email" = $1'

'select "id" from "users" where "users"."email" = $1 limit $2'
→ 'select "id" from "identity"."users" where "identity"."users"."email" = $1 limit $2'

/where "users"\."id" = any\(\$1::uuid\[\]\)$/
→ /where "identity"\."users"\."id" = any\(\$1::uuid\[\]\)$/

'where (("users"."email" ilike $1 or "users"."display_name" ilike $2) and "users"."id" < $3) order by "users"."id" desc limit $4'
→ 'where (("identity"."users"."email" ilike $1 or "identity"."users"."display_name" ilike $2) and "identity"."users"."id" < $3) order by "identity"."users"."id" desc limit $4'

'select "id", "email", "display_name", "roles", "created_at", "updated_at" from "users" order by "users"."id" desc limit $1'
→ 'select "id", "email", "display_name", "roles", "created_at", "updated_at" from "identity"."users" order by "identity"."users"."id" desc limit $1'

/^insert into "users" \("id", "email", "password_hash", "display_name", "roles", "created_at", "updated_at"\)/
→ /^insert into "identity"\."users" \("id", "email", "password_hash", "display_name", "roles", "created_at", "updated_at"\)/

'update "users" set "roles" = $1, "updated_at" = $2 where "users"."id" = $3'
→ 'update "identity"."users" set "roles" = $1, "updated_at" = $2 where "identity"."users"."id" = $3'

'update "users" set "password_hash" = $1, "updated_at" = $2 where "users"."id" = $3'
→ 'update "identity"."users" set "password_hash" = $1, "updated_at" = $2 where "identity"."users"."id" = $3'

/where "users"\."id" = \$1 limit \$2 for update$/
→ /where "identity"\."users"\."id" = \$1 limit \$2 for update$/

'select count(*) from "users" where "users"."roles" @> $1'
→ 'select count(*) from "identity"."users" where "identity"."users"."roles" @> $1'
```

`domains/identity/src/infrastructure/persistence/drizzle-sessions.repository.spec.ts`

```text
/^insert into "sessions" \("id", "user_id", "refresh_token_hash", "user_agent", "ip", "expires_at", "revoked_at", "replaced_by_id", "created_at"\)/
→ /^insert into "identity"\."sessions" \("id", "user_id", "refresh_token_hash", "user_agent", "ip", "expires_at", "revoked_at", "replaced_by_id", "created_at"\)/

'update "sessions" set "revoked_at" = $1, "replaced_by_id" = $2 where ("sessions"."id" = $3 and "sessions"."user_id" = $4 and "sessions"."refresh_token_hash" = $5 and "sessions"."revoked_at" is null and "sessions"."expires_at" > $6) returning "id"'
→ 'update "identity"."sessions" set "revoked_at" = $1, "replaced_by_id" = $2 where ("identity"."sessions"."id" = $3 and "identity"."sessions"."user_id" = $4 and "identity"."sessions"."refresh_token_hash" = $5 and "identity"."sessions"."revoked_at" is null and "identity"."sessions"."expires_at" > $6) returning "id"'

'"sessions"."revoked_at" is null'
→ '"identity"."sessions"."revoked_at" is null'

'update "sessions" set "revoked_at" = $1 where ("sessions"."user_id" = $2 and "sessions"."revoked_at" is null)'
→ 'update "identity"."sessions" set "revoked_at" = $1 where ("identity"."sessions"."user_id" = $2 and "identity"."sessions"."revoked_at" is null)'

'delete from "sessions" where "sessions"."id" in (select "id" from "sessions" where "sessions"."expires_at" <= $1 limit $2)'
→ 'delete from "identity"."sessions" where "identity"."sessions"."id" in (select "id" from "identity"."sessions" where "identity"."sessions"."expires_at" <= $1 limit $2)'
```

`domains/identity/src/identity-api.module.spec.ts`

```text
'select "id" from "users" where "users"."email"'          (line 32, handler)
→ 'select "id" from "identity"."users" where "identity"."users"."email"'

'insert into "users"'                                      (line 46, handler, AND line 116, expectation)
→ 'insert into "identity"."users"'

'select "id" from "users" where "users"."email" = $1 limit $2'   (line 115)
→ 'select "id" from "identity"."users" where "identity"."users"."email" = $1 limit $2'

'insert into "sessions"'                                   (line 117)
→ 'insert into "identity"."sessions"'
```

`domains/identity/src/identity-grpc.module.spec.ts`

```text
'from "users" where "users"."id"'      (line 17)  → 'from "identity"."users" where "identity"."users"."id"'
'where "users"."id" = $1'              (line 78)  → 'where "identity"."users"."id" = $1'
```

`apps/identity-service/test/app.e2e-spec.ts`

```text
'from "users" where "users"."id"'      (line 60)  → 'from "identity"."users" where "identity"."users"."id"'
```

Check nothing unqualified is left:
`grep -rnE '(from|into|update) "(users|sessions)"' domains/identity/src apps/identity-service/test` → no output.

- [ ] **Step 10: Run the affected projects**

Run: `npx vitest run --project identity --project identity-service --project identity-service:e2e`
Expected: PASS. (Do not run `identity:int` yet: boot still applies the old combined `public` history until
persistence-5.)

- [ ] **Step 11: Export the set, point CI drift at the domain histories, update docs**

`domains/identity/src/index.ts`, old:

```ts
// Infrastructure: the Drizzle schema for DatabaseModule / drizzle-kit.
export {
  type IdentitySchema,
```

new:

```ts
// Infrastructure: the Drizzle schema and the migration set for DatabaseModule / drizzle-kit.
export { identityMigrations } from './infrastructure/persistence/identity.migrations.js';
export {
  type IdentitySchema,
```

`.github/workflows/ci.yml:80-81`: in both lines replace the token `libs/database/src/migrations` with
`'domains/*/src/infrastructure/persistence/migrations/*'` (keep the trailing `/*`: without it git matches nothing).
Result:

```yaml
          git diff --exit-code -- libs/contracts/src/generated 'domains/*/src/infrastructure/persistence/migrations/*'
          test -z "$(git status --porcelain -- libs/contracts/src/generated 'domains/*/src/infrastructure/persistence/migrations/*')"
```

(The `libs/contracts/src/generated` token belongs to lane contracts; edit only the database token.)

`domains/identity/README.md`, old:

```markdown
  `users_search_trgm_idx` (pg_trgm GIN on `email` + `display_name`, migration
  `0001_users_search_trgm`, which also creates the extension). Trigrams need 3+ characters, so
```

new:

```markdown
  `users_search_trgm_idx` (pg_trgm GIN on `email` + `display_name`; the extension comes from
  `@platform/database`'s platform set, which always runs first). Trigrams need 3+ characters, so
```

old:

```markdown
The schema file imports only `drizzle-orm` and a dependency-free relative file, so drizzle-kit can
load it. Migrations are generated centrally in `@platform/database`.
```

new:

```markdown
The tables and the `user_role` enum live in the `identity` Postgres schema (`identityPgSchema`); raw SQL qualifies
them (`identity.users`). The schema file imports only `drizzle-orm` and a dependency-free relative file, so
drizzle-kit can load it. Identity owns its migration history: `drizzle.config.ts` generates
`src/infrastructure/persistence/migrations` (`bun run --filter @domain/identity db:generate`), bookkeeping in
`identity.__drizzle_migrations`, and `identityMigrations` applies it after the platform set.
```

`docs/SECURITY.md:153`, old:

```sql
UPDATE users SET roles = ARRAY['admin']::user_role[] WHERE email = 'you@example.com';
```

new:

```sql
UPDATE identity.users SET roles = ARRAY['admin']::identity.user_role[] WHERE email = 'you@example.com';
```

- [ ] **Step 12: Format and run the repository gate**

Run:
`bunx biome check --write domains/identity apps/identity-service/test libs/database package.json && bunx prettier --write domains/identity/README.md docs/SECURITY.md .github/workflows/ci.yml && bun run check`
Expected: PASS.

- [ ] **Step 13: Commit**

(`libs/database/drizzle.config.ts` is already staged as deleted by `git rm` in Step 5; naming it in `git add` would
fail with "pathspec did not match".)

```bash
git add domains/identity/src/infrastructure/persistence domains/identity/drizzle.config.ts domains/identity/src/index.ts \
  domains/identity/src/identity-api.module.spec.ts domains/identity/src/identity-grpc.module.spec.ts \
  domains/identity/package.json domains/identity/README.md apps/identity-service/test/app.e2e-spec.ts \
  libs/database/package.json package.json bun.lock .github/workflows/ci.yml docs/SECURITY.md
git status --short libs/database/drizzle.config.ts   # expect: D  libs/database/drizzle.config.ts
git commit -F- <<'EOF'
refactor(identity): move identity tables to the identity schema with their own history

- pgSchema('identity') for users, sessions and user_role; schema-qualified roles default
- domains/identity/drizzle.config.ts, a fresh 0000_init baseline and identityMigrations
- root db:generate and db:studio run per domain; libs/database/drizzle.config.ts removed
- SQL-text expectations, CI drift paths and the first-admin SQL qualified

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-3: billing tables move to the `billing` schema with their own history

**Files:**

- Modify: `domains/billing/src/infrastructure/persistence/billing.schema.ts:1-24,66`
- Create: `domains/billing/drizzle.config.ts`
- Create: `domains/billing/src/infrastructure/persistence/billing.migrations.ts`
- Create (generated): `domains/billing/src/infrastructure/persistence/migrations/0000_init.sql`, `.../meta/0000_snapshot.json`, `.../meta/_journal.json`
- Modify: `domains/billing/src/index.ts:29-30`
- Modify: `domains/billing/package.json` (`scripts`, `devDependencies`), `bun.lock`
- Modify (SQL-text expectations): `domains/billing/src/infrastructure/persistence/drizzle-payments.repository.spec.ts:42,62,78,91,92,93,124,127,150,157,175,188`,
  `apps/billing-service/test/app.e2e-spec.ts:83,89,251,306,309`, `apps/monolith/test/app.e2e-spec.ts:365`
- Modify: `domains/billing/README.md:203-207`
- Test: `domains/billing/src/infrastructure/persistence/billing.migrations.spec.ts`

**Interfaces:**

- Consumes: `DatabaseMigrationSet`, `MIGRATIONS_TABLE` from `@platform/database` (persistence-1); root `db:generate`/`db:studio` glob and CI pathspec (persistence-2) already cover billing.
- Produces:
  - `export const billingPgSchema = pgSchema('billing')`
  - `export const billingMigrations: DatabaseMigrationSet` = `{ name: 'billing', folder: domains/billing/{src|dist}/infrastructure/persistence/migrations, migrationsSchema: 'billing', migrationsTable: '__drizzle_migrations' }`, re-exported from `@domain/billing`
  - `domains/billing/drizzle.config.ts`; `@domain/billing` scripts `db:generate`, `db:studio` (`--port 4984`, so it runs next to identity's 4983)

- [ ] **Step 1: Write the failing spec**

`domains/billing/src/infrastructure/persistence/billing.migrations.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIGRATIONS_TABLE } from '@platform/database';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { billingMigrations } from './billing.migrations.js';
import { billingPgSchema, paymentStatusEnum, payments, stripeEvents } from './billing.schema.js';

describe('billingMigrations', () => {
  it("is billing's own history: ./migrations, bookkeeping in billing.__drizzle_migrations", () => {
    expect(billingMigrations).toEqual({
      name: 'billing',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'billing',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every billing table and enum in the billing Postgres schema', () => {
    expect(billingPgSchema.schemaName).toBe(billingMigrations.migrationsSchema);
    expect([payments, stripeEvents].map((table) => getTableConfig(table).schema)).toEqual([
      'billing',
      'billing',
    ]);
    expect(paymentStatusEnum.schema).toBe('billing');
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(billingMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([billingMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: billingMigrations.migrationsSchema,
      table: billingMigrations.migrationsTable,
    });
  });

  it('creates its schema idempotently and carries the former 0002 purge index', () => {
    const baseline = readFileSync(join(billingMigrations.folder, '0000_init.sql'), 'utf8');
    expect(baseline).toContain('CREATE SCHEMA IF NOT EXISTS "billing";');
    expect(baseline).not.toMatch(/^CREATE SCHEMA "billing";/m);
    expect(baseline).toContain(
      'CREATE INDEX "stripe_events_processed_at_idx" ON "billing"."stripe_events"',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project billing billing.migrations`
Expected: FAIL: `Failed to load url ../../../drizzle.config.js` / `./billing.migrations.js`.

- [ ] **Step 3: Move the billing tables into `pgSchema('billing')`**

In `domains/billing/src/infrastructure/persistence/billing.schema.ts`:

old (lines 1-5):

```ts
/*
 * Billing tables. drizzle-kit loads this file with its own loader (no `@repo/source` condition), so
 * it imports ONLY drizzle-orm and dependency-free relative files. Column names come from
 * `casing: 'snake_case'` (runtime + drizzle.config.ts).
 */
```

new:

```ts
/*
 * Billing tables. drizzle-kit loads this file with its own loader (no `@repo/source` condition), so
 * it imports ONLY drizzle-orm and dependency-free relative files. Column names come from
 * `casing: 'snake_case'` (runtime + drizzle.config.ts).
 *
 * Every table and enum lives in the `billing` Postgres schema, with billing's own migration history
 * (./migrations, generated by ../../../drizzle.config.ts, bookkeeping in
 * `billing.__drizzle_migrations`). Raw SQL qualifies names (`billing.payments`).
 */
```

old (import block, lines 7-17): replace `  pgEnum,\n  pgTable,\n` by `  pgSchema,\n` so it reads:

```ts
import {
  bigint,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
```

old (lines 20-24):

```ts
const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

export const payments = pgTable(
```

new:

```ts
/**
 * The `billing` Postgres schema. Exported: drizzle-kit only emits `CREATE SCHEMA` (and records it
 * in the snapshot) for exported schemas.
 */
export const billingPgSchema = pgSchema('billing');

const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

export const paymentStatusEnum = billingPgSchema.enum('payment_status', PAYMENT_STATUSES);

export const payments = billingPgSchema.table(
```

old (line 66):

```ts
export const stripeEvents = pgTable(
```

new:

```ts
export const stripeEvents = billingPgSchema.table(
```

- [ ] **Step 4: Add the migration set and the domain drizzle-kit config**

`domains/billing/src/infrastructure/persistence/billing.migrations.ts`:

```ts
import { join } from 'node:path';
import { type DatabaseMigrationSet, MIGRATIONS_TABLE } from '@platform/database';
import { billingPgSchema } from './billing.schema.js';

/**
 * Billing's own Postgres migration history: ./migrations, generated from billing.schema.ts by
 * ../../../drizzle.config.ts, bookkeeping in `billing.__drizzle_migrations`. Apps that own
 * billing's tables list it in `DatabaseModule.forRootAsync({ migrations })` and in their
 * `migrate.ts`; the platform set always runs before it. src/ in dev, dist/ after the build.
 */
export const billingMigrations: DatabaseMigrationSet = {
  name: 'billing',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: billingPgSchema.schemaName,
  migrationsTable: MIGRATIONS_TABLE,
};
```

`domains/billing/drizzle.config.ts`:

```ts
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

/*
 * drizzle-kit config of the billing context: `bun run db:generate` / `db:studio` in this package,
 * or `bun run db:generate` at the root for every domain. The output is billing's own migration
 * history; `billingMigrations` (src/infrastructure/persistence/billing.migrations.ts) applies it
 * after @platform/database's platform set.
 *
 * - Paths are resolved relative to THIS file, then made cwd-relative (what drizzle-kit expects),
 *   so the config works from any working directory. drizzle-kit loads configs as CJS with its own
 *   loader: `import.meta.url` is polyfilled but `import.meta.dirname` is not, and the
 *   `@repo/source` condition is unknown, so neither this file nor the schema imports a workspace
 *   package.
 * - `schemaFilter` scopes push/pull/introspection to `billing` (`generate` ignores it);
 *   `migrations` is what `drizzle-kit migrate` would use. Both MUST equal `billingMigrations`;
 *   billing.migrations.spec.ts checks it.
 * - Reading process.env here is a documented exception to the "config only via @platform/config" rule.
 */
const fromCwd = (path: string): string =>
  relative(process.cwd(), fileURLToPath(new URL(path, import.meta.url))) || '.';

export default defineConfig({
  dialect: 'postgresql',
  schema: fromCwd('./src/infrastructure/persistence/billing.schema.ts'),
  out: fromCwd('./src/infrastructure/persistence/migrations'),
  // MUST equal the runtime `drizzle({ casing })` in @platform/database.
  casing: 'snake_case',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app' },
  schemaFilter: ['billing'],
  migrations: { schema: 'billing', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 5: Add the domain scripts and install**

`domains/billing/package.json`, old:

```json
    "clean": "rimraf dist coverage"
  },
```

new:

```json
    "clean": "rimraf dist coverage",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio --port 4984"
  },
```

and add `"drizzle-kit": "catalog:"` as the last entry of its `devDependencies`. Then:

```bash
bun install
```

Expected: success; `git diff --stat bun.lock` shows the `domains/billing` workspace entry changed.

- [ ] **Step 6: Generate billing's baseline and make its `CREATE SCHEMA` idempotent**

```bash
bun run --filter @domain/billing db:generate --name init
perl -0pi -e 's/\ACREATE SCHEMA "billing";\n/-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for billing.__drizzle_migrations.\nCREATE SCHEMA IF NOT EXISTS "billing";\n/' \
  domains/billing/src/infrastructure/persistence/migrations/0000_init.sql
```

The file must now read exactly:

```sql
-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for billing.__drizzle_migrations.
CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint
CREATE TYPE "billing"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "billing"."payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_total" bigint,
	"currency" text,
	"status" "billing"."payment_status" DEFAULT 'pending' NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"idempotency_key" text,
	"paid_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
CREATE TABLE "billing"."stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "payments_user_id_id_idx" ON "billing"."payments" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_id_idempotency_key_uq" ON "billing"."payments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stripe_events_processed_at_idx" ON "billing"."stripe_events" USING btree ("processed_at");
```

- [ ] **Step 7: Prove regeneration is a no-op and run the spec**

Run: `bun run db:generate && git status --porcelain -- 'domains/*/src/infrastructure/persistence/migrations/*'`
Expected: identity and billing both print `No schema changes, nothing to migrate`; status lists only
`?? domains/billing/src/infrastructure/persistence/migrations/`.

Run: `npx vitest run --project billing billing.migrations`
Expected: PASS (4 tests).

- [ ] **Step 8: Qualify the SQL-text expectations of the billing specs**

`domains/billing/src/infrastructure/persistence/drizzle-payments.repository.spec.ts`

```text
/^insert into "payments" \(/
→ /^insert into "billing"\."payments" \(/

/where \("payments"\."user_id" = \$1 and "payments"\."idempotency_key" = \$2\) limit \$3$/
→ /where \("billing"\."payments"\."user_id" = \$1 and "billing"\."payments"\."idempotency_key" = \$2\) limit \$3$/

'where ("payments"."id" = $1 or "payments"."stripe_checkout_session_id" = $2)'
→ 'where ("billing"."payments"."id" = $1 or "billing"."payments"."stripe_checkout_session_id" = $2)'

/^update "payments" set .*"version" = \$\d+/
→ /^update "billing"\."payments" set .*"version" = \$\d+/

'where ("payments"."id" = $'
→ 'where ("billing"."payments"."id" = $'

'"payments"."version" = $'
→ '"billing"."payments"."version" = $'

/where "payments"\."user_id" = \$1 order by "payments"\."id" desc limit \$2$/
→ /where "billing"\."payments"\."user_id" = \$1 order by "billing"\."payments"\."id" desc limit \$2$/

/from "payments" order by "payments"\."id" desc limit \$1$/
→ /from "billing"\."payments" order by "billing"\."payments"\."id" desc limit \$1$/

/where \("payments"\."user_id" = \$1 and "payments"\."id" < \$2\) order by "payments"\."id" desc limit \$3$/
→ /where \("billing"\."payments"\."user_id" = \$1 and "billing"\."payments"\."id" < \$2\) order by "billing"\."payments"\."id" desc limit \$3$/

/from "payments" where "payments"\."id" < \$1 order by "payments"\."id" desc limit \$2$/
→ /from "billing"\."payments" where "billing"\."payments"\."id" < \$1 order by "billing"\."payments"\."id" desc limit \$2$/

'insert into "stripe_events" ("id", "type", "processed_at") values ($1, $2, default) on conflict ("id") do nothing returning "id"'
→ 'insert into "billing"."stripe_events" ("id", "type", "processed_at") values ($1, $2, default) on conflict ("id") do nothing returning "id"'

'delete from "stripe_events" where "stripe_events"."id" in (select "id" from "stripe_events" where "stripe_events"."processed_at" < $1 limit $2)'
→ 'delete from "billing"."stripe_events" where "billing"."stripe_events"."id" in (select "id" from "billing"."stripe_events" where "billing"."stripe_events"."processed_at" < $1 limit $2)'
```

(`'on conflict ("user_id","idempotency_key") do nothing returning'` and `/limit \$3 for update$/` stay: drizzle
does not qualify conflict targets.)

`apps/billing-service/test/app.e2e-spec.ts`

```text
'insert into "stripe_events"'                         (lines 83, 306, 309) → 'insert into "billing"."stripe_events"'
'from "payments" where "payments"."user_id"'          (line 89)            → 'from "billing"."payments" where "billing"."payments"."user_id"'
'"payments"."id" < $2'                                (line 251)           → '"billing"."payments"."id" < $2'
```

`apps/monolith/test/app.e2e-spec.ts`

```text
'from "payments"'                                     (line 365)           → 'from "billing"."payments"'
```

Check: `grep -rnE '(from|into|update) "(payments|stripe_events)"' domains/billing/src apps` → no output.

- [ ] **Step 9: Run the affected projects**

Run: `npx vitest run --project billing --project billing-service --project billing-service:e2e --project monolith:e2e`
Expected: PASS.

- [ ] **Step 10: Export the set and update the domain README**

`domains/billing/src/index.ts`, old:

```ts
export * from './infrastructure/adapters/local/billing-local.adapter.js';
export {
  type BillingSchema,
```

new:

```ts
export * from './infrastructure/adapters/local/billing-local.adapter.js';
export { billingMigrations } from './infrastructure/persistence/billing.migrations.js';
export {
  type BillingSchema,
```

`domains/billing/README.md`, old:

```markdown
(`payments_stripe_checkout_session_id_unique`). Migrations are generated by drizzle-kit into
`libs/database/src/migrations` (initial: `0000_init.sql`; `0002_stripe_events_processed_at_idx.sql`) (the schema file imports only `drizzle-orm` and a dependency-free enum file, so
drizzle-kit can load it). Reads (`findById`, `list`) use prepared statements on the pool; writes and row locks go
```

new:

```markdown
(`payments_stripe_checkout_session_id_unique`). The tables and the enum live in the `billing` Postgres schema
(`billingPgSchema`); raw SQL qualifies them (`billing.payments`). Billing owns its migration history:
`drizzle.config.ts` generates `src/infrastructure/persistence/migrations` (`0000_init.sql` holds every table and
index, `stripe_events_processed_at_idx` included), bookkeeping in `billing.__drizzle_migrations`, and
`billingMigrations` applies it after the platform set (the schema file imports only `drizzle-orm` and a
dependency-free enum file, so drizzle-kit can load it). Reads (`findById`, `list`) use prepared statements on the pool; writes and row locks go
```

- [ ] **Step 11: Format and run the repository gate**

Run: `bunx biome check --write domains/billing apps/billing-service/test apps/monolith/test && bunx prettier --write domains/billing/README.md && bun run check`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add domains/billing/src/infrastructure/persistence domains/billing/drizzle.config.ts domains/billing/src/index.ts \
  domains/billing/package.json domains/billing/README.md bun.lock \
  apps/billing-service/test/app.e2e-spec.ts apps/monolith/test/app.e2e-spec.ts
git commit -F- <<'EOF'
refactor(billing): move billing tables to the billing schema with their own history

- pgSchema('billing') for payments, stripe_events and payment_status
- domains/billing/drizzle.config.ts, a fresh 0000_init baseline (the former 0002
  index included) and billingMigrations
- SQL-text expectations of the repository and app e2e specs qualified

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-4: @platform/database applies migration sets under one lock

`DatabaseModuleOptions.migrations` stays optional in this task so the apps keep compiling; persistence-5 makes it
required when the apps declare their sets.

**Files:**

- Modify: `libs/database/src/database.types.ts:19-20` (`migrationsFolder` → `migrations?`)
- Modify: `libs/database/src/migrator/run-migrations.ts` (multi-set runner)
- Modify: `libs/database/src/migrator/migrations.constants.ts` (drop `MIGRATIONS_SCHEMA`)
- Create: `libs/database/src/migrator/migrate-cli.ts`
- Modify: `libs/database/src/drizzle/drizzle.factory.ts:6-7,35-43`
- Modify: `libs/database/src/database.module.ts:20,65-76`
- Modify: `libs/database/src/index.ts:1-6,29`
- Modify: `libs/database/package.json` (drop `db:migrate`, `db:migrate:dev`)
- Delete: `libs/database/src/migrate.ts`, `libs/database/src/migrations/` (the combined history: `0000_init.sql`,
  `0001_users_search_trgm.sql`, `0002_stripe_events_processed_at_idx.sql`, `meta/*`, `.gitkeep`)
- Create: `libs/database/test/fixtures/fixture-sets.ts`, `libs/database/test/fixtures/migrate.ts`,
  `libs/database/test/fixtures/gadgets/migrations/0000_create_gadgets.sql`,
  `libs/database/test/fixtures/gadgets/migrations/meta/_journal.json`
- Modify: `libs/database/test/database.int-spec.ts:15-38,107-116,132-189,205-209`
- Test: `libs/database/src/migrator/run-migrations.spec.ts`, `libs/database/src/migrator/migrate-cli.spec.ts`,
  `libs/database/src/database.module.spec.ts`, `libs/database/test/database.int-spec.ts`

**Interfaces:**

- Consumes: `DatabaseMigrationSet`, `platformMigrations`, `withPlatformMigrations` (persistence-1).
- Produces:
  - `runMigrations(url: string, options: RunMigrationsOptions): Promise<MigrationRunSummary>` with
    `RunMigrationsOptions { migrations: readonly DatabaseMigrationSet[]; logger?: LoggerService; applicationName?: string; lockTimeoutMs?: number; lockPollIntervalMs?: number }`,
    `MigrationSetSummary { name: string; folder: string; total: number; applied: number }`,
    `MigrationRunSummary { sets: MigrationSetSummary[]; total: number; applied: number }`. Runs exactly the given sets, in order.
  - `runMigrationsCli(migrations: readonly DatabaseMigrationSet[], args?: readonly string[]): Promise<void>` (applies `withPlatformMigrations(migrations)`).
  - `DatabaseModule.forRootAsync({ schema, migrations })`: boot applies `withPlatformMigrations(options.migrations)` before the pool; the list is validated when `forRootAsync` is called.
  - Removed: `DEFAULT_MIGRATIONS_FOLDER`, `MIGRATIONS_SCHEMA`, `RunMigrationsOptions.migrationsFolder`, `DatabaseModuleOptions.migrationsFolder`, `libs/database/src/migrate.ts`.

- [ ] **Step 1: Rewrite the runner spec for sets (failing)**

Replace `libs/database/src/migrator/run-migrations.spec.ts` with:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_ADVISORY_LOCK_ID, MIGRATIONS_TABLE } from './migrations.constants.js';
import { runMigrations } from './run-migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
// drizzle's migrator itself is exercised by database.int-spec.ts; here only its calls matter.
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: vi.fn(async () => undefined) }));

const URL = 'postgres://app:app@localhost:5432/app';
const silentLogger = (): LoggerService => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe('runMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrations-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A set whose folder holds a journal listing `tags`, or no journal at all for `null`. */
  const migrationSet = (name: string, tags: string[] | null): DatabaseMigrationSet => {
    const folder = join(dir, name);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    if (tags !== null) {
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
      );
    }
    return { name, folder, migrationsSchema: name, migrationsTable: MIGRATIONS_TABLE };
  };

  it('skips (without connecting) when no set has a drizzle journal yet', async () => {
    const logger = silentLogger();
    const empty = migrationSet('empty', null);
    await expect(runMigrations(URL, { migrations: [empty], logger })).resolves.toEqual({
      sets: [{ name: 'empty', folder: empty.folder, total: 0, applied: 0 }],
      total: 0,
      applied: 0,
    });
    expect(postgres).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('_journal.json missing'));
  });

  it('rejects a malformed journal before connecting', async () => {
    const broken = migrationSet('broken', null);
    writeFileSync(join(broken.folder, 'meta', '_journal.json'), JSON.stringify({ entries: 'nope' }));
    await expect(
      runMigrations(URL, { migrations: [broken], logger: silentLogger() }),
    ).rejects.toThrow(/Invalid drizzle migration journal/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('applies the sets in array order on ONE session, under ONE lock, and sums the summary', async () => {
    const identity = migrationSet('identity', ['0000_init']);
    const pending = migrationSet('pending', null);
    const billing = migrationSet('billing', ['0000_init', '0001_more']);
    const appliedBySchema = new Map<string, number>();
    const events: string[] = [];
    vi.mocked(migrate).mockImplementation(async (_db, config) => {
      const schema = config.migrationsSchema ?? '';
      events.push(`migrate ${schema}`);
      appliedBySchema.set(schema, schema === 'billing' ? 2 : 1);
    });
    const sql = createFakeSql((query, values) => {
      if (query.includes('pg_try_advisory_lock')) {
        events.push('lock');
        return [{ locked: true }];
      }
      if (query.includes('pg_advisory_unlock')) {
        events.push('unlock');
        return [];
      }
      if (query.includes('to_regclass')) return [{ exists: true }];
      if (query.startsWith('select count(*)')) {
        const [schema] = values as [{ identifier: string }];
        return [{ count: appliedBySchema.get(schema.identifier) ?? 0 }];
      }
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    const summary = await runMigrations(URL, {
      migrations: [identity, pending, billing],
      logger: silentLogger(),
    });

    expect(events).toEqual(['lock', 'migrate identity', 'migrate billing', 'unlock']);
    expect(vi.mocked(migrate).mock.calls.map(([, config]) => config)).toEqual([
      { migrationsFolder: identity.folder, migrationsSchema: 'identity', migrationsTable: MIGRATIONS_TABLE },
      { migrationsFolder: billing.folder, migrationsSchema: 'billing', migrationsTable: MIGRATIONS_TABLE },
    ]);
    expect(summary).toEqual({
      sets: [
        { name: 'identity', folder: identity.folder, total: 1, applied: 1 },
        { name: 'pending', folder: pending.folder, total: 0, applied: 0 },
        { name: 'billing', folder: billing.folder, total: 2, applied: 2 },
      ],
      total: 3,
      applied: 3,
    });
    expect(postgres).toHaveBeenCalledTimes(1);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('waits for the advisory lock, then gives up with a clear error and closes the client', async () => {
    const set = migrationSet('x', ['0000_x']);
    const lockValues: unknown[][] = [];
    const sql = createFakeSql((query, values) => {
      if (query.includes('pg_try_advisory_lock')) {
        lockValues.push(values);
        return [{ locked: false }];
      }
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);
    const logger = silentLogger();

    await expect(
      runMigrations(URL, {
        migrations: [set],
        logger,
        lockTimeoutMs: 30,
        lockPollIntervalMs: 5,
        applicationName: 'svc',
      }),
    ).rejects.toThrow(/Timed out after 30ms waiting for the migrations advisory lock/);

    // single-session client: the lock and migrate() must share one connection that never recycles
    expect(postgres).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        max: 1,
        max_lifetime: null,
        connection: { application_name: 'svc:migrate', statement_timeout: 0 },
      }),
    );
    expect(lockValues.length).toBeGreaterThan(1);
    expect(lockValues[0]).toEqual([MIGRATIONS_ADVISORY_LOCK_ID]);
    expect(logger.log).toHaveBeenCalledTimes(1); // "waiting" logged once, not per poll
    expect(migrate).not.toHaveBeenCalled();
    expect(sql.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project database run-migrations`
Expected: FAIL: the summary has no `sets` and `migrate` receives `migrationsSchema: 'public'` (the runner still takes
one folder).

- [ ] **Step 3: Implement the multi-set runner**

Replace `libs/database/src/migrator/run-migrations.ts` with:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, type LoggerService } from '@nestjs/common';
import { sleep } from '@platform/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { noop, sumBy } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_ADVISORY_LOCK_ID } from './migrations.constants.js';

export interface RunMigrationsOptions {
  /**
   * The sets to apply, in this order, exactly as given. `DatabaseModule` and `runMigrationsCli`
   * pass `withPlatformMigrations(appSets)`, so the platform set comes first.
   */
  migrations: readonly DatabaseMigrationSet[];
  logger?: LoggerService;
  /** `application_name` prefix of the migration session (shown in `pg_stat_activity`). */
  applicationName?: string;
  /** Max time to wait for another instance's migration run to release the lock. Default 5 min. */
  lockTimeoutMs?: number;
  /** How often to retry the advisory lock while another instance holds it. Default 1 s. */
  lockPollIntervalMs?: number;
}

export interface MigrationSetSummary {
  name: string;
  folder: string;
  /** Migrations listed in the set's journal (0 when the folder has no journal yet). */
  total: number;
  /** Applied by THIS run — 0 when the set was already current (e.g. another replica won). */
  applied: number;
}

export interface MigrationRunSummary {
  /** One entry per set, in the order they were applied. */
  sets: MigrationSetSummary[];
  /** Sums over `sets`. */
  total: number;
  applied: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 1_000;

const journalSchema = z.object({ entries: z.array(z.object({ tag: z.string() })) });

/** Number of journal entries, or `null` when the folder has no drizzle journal yet. */
function readJournalSize(folder: string): number | null {
  const journalPath = join(folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return null;
  const journal = journalSchema.safeParse(JSON.parse(readFileSync(journalPath, 'utf8')));
  if (!journal.success) throw new Error(`Invalid drizzle migration journal: ${journalPath}`);
  return journal.data.entries.length;
}

/**
 * Polls `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`, so a waiting replica
 * logs why it is stuck and gives up after `timeoutMs` instead of hanging its boot forever.
 */
async function acquireMigrationLock(
  sql: Sql,
  timeoutMs: number,
  pollIntervalMs: number,
  logger: LoggerService,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const [row] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATIONS_ADVISORY_LOCK_ID}) as locked`;
    if (row?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the migrations advisory lock ` +
          `(${MIGRATIONS_ADVISORY_LOCK_ID}); another instance is still migrating or its session is stuck`,
      );
    }
    if (attempt === 1) logger.log('Another instance is running migrations — waiting for its lock');
    await sleep(pollIntervalMs);
  }
}

/** Rows in the set's own bookkeeping table (0 before its first run). */
async function countAppliedMigrations(sql: Sql, set: DatabaseMigrationSet): Promise<number> {
  const [table] = await sql<{ exists: boolean }[]>`
    select to_regclass(${`${set.migrationsSchema}.${set.migrationsTable}`}) is not null as exists`;
  if (table?.exists !== true) return 0;
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(set.migrationsSchema)}.${sql(set.migrationsTable)}`;
  return row?.count ?? 0;
}

async function applySet(
  sql: Sql,
  set: DatabaseMigrationSet,
  total: number,
  logger: LoggerService,
): Promise<MigrationSetSummary> {
  const before = await countAppliedMigrations(sql, set);
  await migrate(drizzle({ client: sql }), {
    migrationsFolder: set.folder,
    migrationsSchema: set.migrationsSchema,
    migrationsTable: set.migrationsTable,
  });
  const applied = Math.max(0, (await countAppliedMigrations(sql, set)) - before);
  logger.log(
    applied > 0
      ? `${set.name}: applied ${applied} migration(s); ${total} in total`
      : `${set.name}: schema is up to date (${total} migrations)`,
  );
  return { name: set.name, folder: set.folder, total, applied };
}

const summarize = (sets: MigrationSetSummary[]): MigrationRunSummary => ({
  sets,
  total: sumBy(sets, 'total'),
  applied: sumBy(sets, 'applied'),
});

/**
 * Applies the pending drizzle-kit migrations of several sets, in order, safely under concurrency:
 * - ONE advisory lock around every set, so processes sharing a database (identity-service and
 *   billing-service) migrate one after the other;
 * - a dedicated `max: 1` client so the session-level lock and every `migrate()` share ONE
 *   connection (`max_lifetime: null` — a recycled socket would silently drop the lock);
 * - `statement_timeout: 0` for this session only: DDL / backfills may legitimately run long;
 * - each set writes its own bookkeeping table: drizzle applies only files newer than the LAST row
 *   of that table, so a shared table would skip the files of the set with older timestamps;
 * - drizzle runs a set's pending migrations in one transaction (all-or-nothing per set), so
 *   `CREATE INDEX CONCURRENTLY` cannot be used; a set that already ran stays applied when a later
 *   set fails.
 *
 * Every journal is read before connecting (a malformed one fails the run up front). A set whose
 * folder has no `meta/_journal.json` yet is skipped with a warning; when no set has one, nothing
 * connects.
 */
export async function runMigrations(
  url: string,
  options: RunMigrationsOptions,
): Promise<MigrationRunSummary> {
  const logger = options.logger ?? new Logger('DatabaseMigrations');
  const plan = options.migrations.map((set) => ({ set, total: readJournalSize(set.folder) }));
  const skipped = (set: DatabaseMigrationSet): MigrationSetSummary => ({
    name: set.name,
    folder: set.folder,
    total: 0,
    applied: 0,
  });
  for (const { set, total } of plan) {
    if (total === null) {
      logger.warn(
        `No drizzle migrations for "${set.name}" in ${set.folder} (meta/_journal.json missing) — skipping`,
      );
    }
  }
  if (plan.every(({ total }) => total === null)) {
    return summarize(plan.map(({ set }) => skipped(set)));
  }

  const sql = postgres(url, {
    max: 1,
    max_lifetime: null,
    prepare: false,
    onnotice: (notice) => {
      logger.debug?.(notice['message'] ?? 'notice');
    },
    connection: {
      application_name: `${options.applicationName ?? 'app'}:migrate`,
      statement_timeout: 0,
    },
  });
  let locked = false;
  try {
    await acquireMigrationLock(
      sql,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
      logger,
    );
    locked = true;
    const results: MigrationSetSummary[] = [];
    for (const { set, total } of plan) {
      results.push(total === null ? skipped(set) : await applySet(sql, set, total, logger));
    }
    return summarize(results);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(${MIGRATIONS_ADVISORY_LOCK_ID})`.catch(noop);
    await sql.end({ timeout: 5 });
  }
}
```

Replace `libs/database/src/migrator/migrations.constants.ts` with:

```ts
/** Name of every set's bookkeeping table; each set keeps it in its own schema (`<schema>.__drizzle_migrations`). */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * App-wide constant key for `pg_advisory_lock(bigint)`: drizzle's `migrate()` takes no lock, so
 * concurrent replicas booting with DATABASE_RUN_MIGRATIONS=true would race without it. One key for
 * every set, so processes that share a database (identity-service and billing-service) migrate one
 * after the other.
 */
export const MIGRATIONS_ADVISORY_LOCK_ID = 727_001;
```

- [ ] **Step 4: Run the runner spec**

Run: `npx vitest run --project database run-migrations`
Expected: PASS (4 tests). `tsc` still fails on `drizzle.factory.ts` and `migrate.ts`: Steps 5-9 fix them.

- [ ] **Step 5: Write the CLI helper spec (failing)**

`libs/database/src/migrator/migrate-cli.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { runMigrationsCli } from './migrate-cli.js';
import { MIGRATIONS_TABLE } from './migrations.constants.js';
import { runMigrations } from './run-migrations.js';

vi.mock('./run-migrations.js', () => ({ runMigrations: vi.fn() }));

const orders: DatabaseMigrationSet = {
  name: 'orders',
  folder: '/migrations/orders',
  migrationsSchema: 'orders',
  migrationsTable: MIGRATIONS_TABLE,
};

describe('runMigrationsCli', () => {
  afterEach(() => {
    process.exitCode = undefined; // never leak a failure code into the test worker
    vi.unstubAllEnvs();
  });

  it("applies the platform set, then the app's sets, and logs one JSON summary line", async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app:app@db:5432/app');
    vi.stubEnv('SERVICE_NAME', 'orders-service');
    vi.stubEnv('LOG_PRETTY', 'false');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(runMigrations).mockResolvedValue({
      sets: [
        { name: 'platform', folder: platformMigrations.folder, total: 1, applied: 1 },
        { name: 'orders', folder: orders.folder, total: 2, applied: 2 },
      ],
      total: 3,
      applied: 3,
    });

    await runMigrationsCli([orders], []);

    expect(runMigrations).toHaveBeenCalledWith(
      'postgres://app:app@db:5432/app',
      expect.objectContaining({
        migrations: [platformMigrations, orders],
        applicationName: 'orders-service',
      }),
    );
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      level: 'log',
      message: 'Done: 3 applied, 3 total (platform, orders)',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 on an unknown flag, before touching the database', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([orders], ['--migrations-folder', 'x']);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('--migrations-folder');
  });

  it('exits 1 when the app lists the platform set itself', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([platformMigrations], []);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
```

Run: `npx vitest run --project database migrate-cli`
Expected: FAIL: `Failed to load url ./migrate-cli.js`.

- [ ] **Step 6: Implement `runMigrationsCli`**

`libs/database/src/migrator/migrate-cli.ts`:

```ts
import { parseArgs } from 'node:util';
import { appConfig, databaseConfig, observabilityConfig } from '@platform/config';
import type { DatabaseMigrationSet } from '../database.types.js';
import { createMigrateCliLogger } from './cli-logger.js';
import { withPlatformMigrations } from './migration-sets.js';
import { runMigrations } from './run-migrations.js';

/**
 * The body of every app's `src/migrate.ts`: the one-off migration job for deploy pipelines
 * (`node dist/migrate.js` in the app's image, a k8s Job / initContainer) and `bun run db:migrate`.
 * No Nest application: config is parsed with the same zod schemas the apps use, so a bad
 * DATABASE_URL fails with the same message. Applies `platformMigrations`, then `migrations` in
 * order, under the migrations advisory lock.
 *
 * Takes no flags: an unknown one (such as the removed `--migrations-folder`) fails instead of being
 * ignored. Sets `process.exitCode` (0 = schema current, 1 = failure) instead of exiting, so the last
 * log line is flushed. Logs are JSON lines (log shippers); `LOG_PRETTY` (default on in development)
 * switches to coloured text, and JSON is the fallback, so even a config error is reported as JSON.
 * The caller imports `reflect-metadata` first: the domain packages declare decorated classes.
 */
export async function runMigrationsCli(
  migrations: readonly DatabaseMigrationSet[],
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let logger = createMigrateCliLogger(false);
  try {
    parseArgs({ args: [...args], options: {}, strict: true });
    if (observabilityConfig.parse().logPretty) logger = createMigrateCliLogger(true);
    const { url } = databaseConfig.parse();
    const { serviceName } = appConfig.parse();
    const summary = await runMigrations(url, {
      migrations: withPlatformMigrations(migrations),
      logger,
      applicationName: serviceName,
    });
    const names = summary.sets.map((set) => set.name).join(', ');
    logger.log(`Done: ${summary.applied} applied, ${summary.total} total (${names})`);
  } catch (error) {
    // The Error itself, not `error.stack`: with `json: true` ConsoleLogger treats a lone
    // stack-formatted string as a stack trace and prints nothing (printStackTrace is a no-op in
    // JSON mode), while an Error is serialised with its message and stack.
    logger.error(error instanceof Error ? error : String(error));
    process.exitCode = 1;
  }
}
```

Run: `npx vitest run --project database migrate-cli`
Expected: PASS (3 tests).

- [ ] **Step 7: Update the module spec for sets and the platform-first rule (failing)**

In `libs/database/src/database.module.spec.ts`:

old (lines 14-25):

```ts
import { createFakeSql, type FakeSql, type FakeSqlHandler } from '../test/fake-sql.js';
import { DatabaseModule } from './database.module.js';
import type { DatabaseModuleOptions } from './database.types.js';
import { DRIZZLE } from './drizzle/drizzle.constants.js';
import type { DrizzleDB, DrizzleTransactionalAdapter } from './drizzle/drizzle.types.js';
import { DatabaseHealthIndicator } from './health/database.health.js';
import { runMigrations } from './migrator/run-migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('./migrator/run-migrations.js', () => ({
  runMigrations: vi.fn(async () => ({ folder: '/m', total: 0, applied: 0 })),
}));
```

new:

```ts
import { createFakeSql, type FakeSql, type FakeSqlHandler } from '../test/fake-sql.js';
import { DatabaseModule } from './database.module.js';
import type { DatabaseMigrationSet, DatabaseModuleOptions } from './database.types.js';
import { DRIZZLE } from './drizzle/drizzle.constants.js';
import type { DrizzleDB, DrizzleTransactionalAdapter } from './drizzle/drizzle.types.js';
import { DatabaseHealthIndicator } from './health/database.health.js';
import { MIGRATIONS_TABLE } from './migrator/migrations.constants.js';
import { runMigrations } from './migrator/run-migrations.js';
import { platformMigrations } from './platform/platform.migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('./migrator/run-migrations.js', () => ({
  runMigrations: vi.fn(async () => ({ sets: [], total: 0, applied: 0 })),
}));
```

old (lines 30-32):

```ts
const items = pgTable('items', { id: uuid().primaryKey(), name: text().notNull() });
const schema = { items };
type Adapter = DrizzleTransactionalAdapter<typeof schema>;
```

new:

```ts
const items = pgTable('items', { id: uuid().primaryKey(), name: text().notNull() });
const schema = { items };
type Adapter = DrizzleTransactionalAdapter<typeof schema>;
const itemsMigrations: DatabaseMigrationSet = {
  name: 'items',
  folder: '/migrations/items',
  migrationsSchema: 'items',
  migrationsTable: MIGRATIONS_TABLE,
};
/** `migrations` defaults to none (the platform set alone) in these tests. */
type BootOptions = Omit<DatabaseModuleOptions<typeof schema>, 'migrations'> & {
  migrations?: readonly DatabaseMigrationSet[];
};
```

old (`boot` signature and module import, lines 60-70):

```ts
async function boot(
  options: DatabaseModuleOptions<typeof schema>,
```

new:

```ts
async function boot(
  options: BootOptions,
```

and old `      DatabaseModule.forRootAsync(options),` → new `      DatabaseModule.forRootAsync({ migrations: [], ...options }),`

In the `forRootAsync() definition` block replace the three direct calls `DatabaseModule.forRootAsync({ schema })` /
`DatabaseModule.forRootAsync({ schema, transactional: false })` with `DatabaseModule.forRootAsync({ schema,
migrations: [] })` / `DatabaseModule.forRootAsync({ schema, migrations: [], transactional: false })`, and add after
the `registers the transactional CLS plugin unless disabled` test:

```ts
    it('rejects colliding migration sets when the module is defined', () => {
      expect(() =>
        DatabaseModule.forRootAsync({ schema, migrations: [platformMigrations] }),
      ).toThrow(/"platform" is listed twice/);
    });
```

old (test at lines 139-148):

```ts
    it('runs migrations BEFORE opening the pool when enabled by option', async () => {
      app = await boot({ schema, runMigrations: true, migrationsFolder: '/custom' });
      expect(runMigrations).toHaveBeenCalledWith(
        'postgres://app:app@localhost:5432/app',
        expect.objectContaining({ applicationName: 'app', migrationsFolder: '/custom' }),
      );
```

new:

```ts
    it('runs the platform set, then the given sets, BEFORE opening the pool', async () => {
      app = await boot({ schema, runMigrations: true, migrations: [itemsMigrations] });
      expect(runMigrations).toHaveBeenCalledWith(
        'postgres://app:app@localhost:5432/app',
        expect.objectContaining({
          applicationName: 'app',
          migrations: [platformMigrations, itemsMigrations],
        }),
      );
```

old (lines 154-157, inside `honours DATABASE_RUN_MIGRATIONS, and the option wins over it`):

```ts
      expect(runMigrations).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ applicationName: 'identity-service' }),
      );
```

new:

```ts
      // No domain sets: the platform set still runs.
      expect(runMigrations).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          applicationName: 'identity-service',
          migrations: [platformMigrations],
        }),
      );
```

Run: `npx vitest run --project database database.module`
Expected: FAIL in `rejects colliding migration sets when the module is defined` (nothing throws yet) and in
`runs the platform set, then the given sets, BEFORE opening the pool` / `honours DATABASE_RUN_MIGRATIONS` (the
factory passes no `migrations`); every other test in the file passes.

- [ ] **Step 8: Take `migrations` in the module options, the factory and the module**

`libs/database/src/database.types.ts`, old:

```ts
  /** drizzle-kit output folder to apply on boot. Default: this package's `migrations` folder. */
  migrationsFolder?: string;
```

new:

```ts
  /**
   * The domain migration sets this process owns, in order. Applied after `platformMigrations`
   * (always first, never listed here) under one advisory lock when `runMigrations` /
   * DATABASE_RUN_MIGRATIONS is on. Omitted: the platform set alone.
   */
  migrations?: readonly DatabaseMigrationSet[];
```

`libs/database/src/drizzle/drizzle.factory.ts`, old:

```ts
import type { DatabaseModuleOptions } from '../database.types.js';
import { runMigrations } from '../migrator/run-migrations.js';
```

new:

```ts
import type { DatabaseModuleOptions } from '../database.types.js';
import { withPlatformMigrations } from '../migrator/migration-sets.js';
import { runMigrations } from '../migrator/run-migrations.js';
```

old:

```ts
  if (options.runMigrations ?? cfg.runMigrations) {
    await runMigrations(cfg.url, {
      logger,
      applicationName: app.serviceName,
      ...(options.migrationsFolder === undefined
        ? {}
        : { migrationsFolder: options.migrationsFolder }),
    });
  }
```

new:

```ts
  if (options.runMigrations ?? cfg.runMigrations) {
    // The platform set first, then the app's domain sets in order, all under one advisory lock.
    await runMigrations(cfg.url, {
      migrations: withPlatformMigrations(options.migrations ?? []),
      logger,
      applicationName: app.serviceName,
    });
  }
```

`libs/database/src/database.module.ts`, old:

```ts
import { DatabaseHealthIndicator } from './health/database.health.js';
```

new:

```ts
import { DatabaseHealthIndicator } from './health/database.health.js';
import { withPlatformMigrations } from './migrator/migration-sets.js';
```

old:

```ts
 * Pool settings come from the `database` config namespace; `application_name` = SERVICE_NAME.
 */
@Module({})
export class DatabaseModule {
  static forRootAsync<TSchema extends DrizzleSchema>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
    const transactional = resolveTransactionalOptions(options.transactional);
```

new:

```ts
 * Pool settings come from the `database` config namespace; `application_name` = SERVICE_NAME.
 * With `runMigrations` / DATABASE_RUN_MIGRATIONS, boot applies `platformMigrations` and then
 * `options.migrations` in order, under one advisory lock, before the pool opens.
 */
@Module({})
export class DatabaseModule {
  static forRootAsync<TSchema extends DrizzleSchema>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
    // Checked when the module is defined, not at the first migrating boot: a set listed twice or a
    // shared bookkeeping table then fails every test that builds the app module.
    withPlatformMigrations(options.migrations ?? []);
    const transactional = resolveTransactionalOptions(options.transactional);
```

- [ ] **Step 9: Remove the combined history and the package CLI, export the helper**

```bash
git rm -r libs/database/src/migrations libs/database/src/migrate.ts
```

`libs/database/package.json`, old:

```json
    "clean": "rimraf dist coverage",
    "db:migrate": "node --env-file-if-exists=../../.env dist/migrate.js",
    "db:migrate:dev": "node --env-file-if-exists=../../.env --conditions=@repo/source --import @swc-node/register/esm-register src/migrate.ts"
  },
```

new:

```json
    "clean": "rimraf dist coverage"
  },
```

`libs/database/src/index.ts`, old (header):

```ts
 * @platform/database — PostgreSQL for the whole monorepo: postgres.js pool + Drizzle ORM (global
 * `DatabaseModule`), CLS-propagated transactions (`@Transactional()`), drizzle-kit migrations
 * with an advisory-locked runner (boot or `migrate.ts` CLI), a readiness contributor and
 * uuidv7 keyset-pagination helpers. Domain `*.schema.ts` files live in the domain packages.
```

new:

```ts
 * @platform/database — PostgreSQL for the whole monorepo: postgres.js pool + Drizzle ORM (global
 * `DatabaseModule`), CLS-propagated transactions (`@Transactional()`), migration sets (the
 * platform set first, then each domain's own drizzle-kit history) applied by an advisory-locked
 * runner at boot or by each app's `migrate.ts` (`runMigrationsCli`), a readiness contributor and
 * uuidv7 keyset-pagination helpers. Domain `*.schema.ts` files and histories live in the domains.
```

and old `export * from './health/database.health.js';` → new:

```ts
export * from './health/database.health.js';
export * from './migrator/migrate-cli.js';
```

(Root `db:migrate` still points at the removed `@platform/database` script until persistence-5 adds the app CLIs;
this is inside the documented window.)

- [ ] **Step 10: Run the unit project**

Run: `npx vitest run --project database`
Expected: PASS.

- [ ] **Step 11: Add the fixture sets and an app-style CLI entry for the integration spec**

`libs/database/test/fixtures/fixture-sets.ts`:

```ts
import { join } from 'node:path';
import type { DatabaseMigrationSet } from '../../src/database.types.js';
import { MIGRATIONS_TABLE } from '../../src/migrator/migrations.constants.js';

/** drizzle-kit output of widgets.schema.ts (README "Tests"), bookkeeping in public.__drizzle_migrations. */
export const widgetsMigrations: DatabaseMigrationSet = {
  name: 'widgets',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: 'public',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * A second, hand-written history whose journal `when` is OLDER than every widgets entry. It is
 * applied only because it has its own bookkeeping table: drizzle skips files older than the last
 * row of the table it writes to.
 */
export const gadgetsMigrations: DatabaseMigrationSet = {
  name: 'gadgets',
  folder: join(import.meta.dirname, 'gadgets', 'migrations'),
  migrationsSchema: 'gadgets',
  migrationsTable: MIGRATIONS_TABLE,
};
```

`libs/database/test/fixtures/gadgets/migrations/0000_create_gadgets.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS "gadgets";--> statement-breakpoint
CREATE TABLE "gadgets"."gadgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL
);
```

`libs/database/test/fixtures/gadgets/migrations/meta/_journal.json`:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1700000000000,
      "tag": "0000_create_gadgets",
      "breakpoints": true
    }
  ]
}
```

`libs/database/test/fixtures/migrate.ts`:

```ts
import 'reflect-metadata';
import { runMigrationsCli } from '../../src/migrator/migrate-cli.js';
import { gadgetsMigrations, widgetsMigrations } from './fixture-sets.js';

/* An app-style `migrate.ts` over the fixture sets; database.int-spec.ts spawns it. */
await runMigrationsCli([widgetsMigrations, gadgetsMigrations]);
```

- [ ] **Step 12: Update the integration spec for sets**

In `libs/database/test/database.int-spec.ts`:

old (import of `../src/index.js`, lines 15-27): add `type DatabaseMigrationSet,` and `platformMigrations,` to the
named imports, and after it add:

```ts
import { gadgetsMigrations, widgetsMigrations } from './fixtures/fixture-sets.js';
```

old (lines 36-38):

```ts
const PACKAGE_ROOT = join(import.meta.dirname, '..');
const FIXTURE_MIGRATIONS = join(import.meta.dirname, 'fixtures', 'migrations');
const schema = { widgets };
```

new:

```ts
const PACKAGE_ROOT = join(import.meta.dirname, '..');
const schema = { widgets };
```

old (`migrationRows`, lines 107-116):

```ts
  const migrationRows = async (url: string): Promise<number> => {
    const client = postgres(url, { max: 1, onnotice: noop });
    try {
      const [row] = await client<{ count: number }[]>`
        select count(*)::int as count from public.__drizzle_migrations`;
```

new:

```ts
  const migrationRows = async (url: string, set: DatabaseMigrationSet): Promise<number> => {
    const client = postgres(url, { max: 1, onnotice: noop });
    try {
      const [row] = await client<{ count: number }[]>`
        select count(*)::int as count
        from ${client(set.migrationsSchema)}.${client(set.migrationsTable)}`;
```

Replace the `describe('runMigrations()', …)` and `describe('migrate.ts CLI', …)` blocks (lines 132-189) with:

```ts
  describe('runMigrations()', () => {
    it('applies each migration exactly once when replicas race, then releases the lock', async () => {
      const url = await createDatabase('race');
      const migrations = [widgetsMigrations, gadgetsMigrations];
      const runs = await Promise.all(
        [1, 2, 3].map(() =>
          runMigrations(url, { migrations, lockPollIntervalMs: 50, logger: silent }),
        ),
      );
      expect(sumBy(runs, 'applied')).toBe(3);
      expect(runs.every((run) => run.total === 3)).toBe(true);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
      const [locks] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_locks
        where locktype = 'advisory' and objid = ${MIGRATIONS_ADVISORY_LOCK_ID}`;
      expect(locks?.count).toBe(0);

      const rerun = await runMigrations(url, { migrations, logger: silent });
      expect(rerun).toMatchObject({ applied: 0, total: 3 });
    });

    it('gives each set its own bookkeeping table, so a set with OLDER timestamps still applies', async () => {
      const url = await createDatabase('sets');
      const summary = await runMigrations(url, {
        migrations: [widgetsMigrations, gadgetsMigrations],
        logger: silent,
      });
      expect(summary.sets.map(({ name, applied }) => ({ name, applied }))).toEqual([
        { name: 'widgets', applied: 2 },
        { name: 'gadgets', applied: 1 },
      ]);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
      expect(await migrationRows(url, gadgetsMigrations)).toBe(1);
    });
  });

  describe("runMigrationsCli() (the body of every app's migrate.ts)", () => {
    const cli = (url: string, ...args: string[]) =>
      execFileAsync(
        process.execPath,
        [
          '--conditions=@repo/source',
          '--import',
          '@swc-node/register/esm-register',
          'test/fixtures/migrate.ts',
          ...args,
        ],
        { cwd: PACKAGE_ROOT, env: { ...process.env, DATABASE_URL: url }, timeout: 90_000 },
      );

    it('applies the platform set, then the given sets, and exits 0; a second run is a no-op', async () => {
      const url = await createDatabase('cli');
      const first = await cli(url);
      expect(first.stdout).toContain('Done: 4 applied, 4 total (platform, widgets, gadgets)');
      const second = await cli(url);
      expect(second.stdout).toContain('Done: 0 applied, 4 total (platform, widgets, gadgets)');
      expect(await migrationRows(url, platformMigrations)).toBe(1);
      expect(await migrationRows(url, widgetsMigrations)).toBe(2);
    });

    it('exits 1 on an unknown flag (the removed --migrations-folder)', async () => {
      await expect(
        cli('postgres://app:app@127.0.0.1:1/app', '--migrations-folder', 'x'),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('--migrations-folder') as unknown,
      });
    });

    it('exits 1 with the config error for an invalid DATABASE_URL', async () => {
      await expect(cli('mysql://nope')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_URL') as unknown,
      });
    });
  });
```

old (boot module, lines 205-209):

```ts
          DatabaseModule.forRootAsync({
            schema,
            runMigrations: true,
            migrationsFolder: FIXTURE_MIGRATIONS,
          }),
```

new:

```ts
          // The platform set runs first and creates schema `app`. Connected as role `app`, the
          // default search_path ("$user", public) then starts with `app`, so the unqualified
          // widgets table lands there; every query below is unqualified too.
          DatabaseModule.forRootAsync({
            schema,
            runMigrations: true,
            migrations: [widgetsMigrations],
          }),
```

- [ ] **Step 13: Run the integration project (needs Docker)**

Run: `INTEGRATION=1 npx vitest run --project database:int`
Expected: PASS (race, separate tables, CLI x3, boot, GUCs, uuidv7, transactions, keyset, health, shutdown).

- [ ] **Step 14: Format and run the repository gate**

Run: `bunx biome check --write libs/database && bun run check`
Expected: PASS.

Run: `grep -rn -e 'migrationsFolder' -e 'MIGRATIONS_SCHEMA' -e 'DEFAULT_MIGRATIONS_FOLDER' --include='*.ts' apps domains libs`
Expected: only `libs/database/src/migrator/run-migrations.ts` (`migrationsFolder: set.folder`, drizzle's own option
key).

- [ ] **Step 15: Commit**

```bash
git add libs/database
git commit -F- <<'EOF'
feat(database): apply the platform set and domain migration sets under one lock

- runMigrations takes sets and applies exactly them, in order, on one session under
  one advisory lock, each with its own bookkeeping table
- runMigrationsCli: the body of every app's migrate.ts (platform set first)
- DatabaseModule.forRootAsync({ migrations }) validates the sets and runs the
  platform set first at boot; the combined public history and src/migrate.ts are gone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-5: Apps declare their migration sets for boot and `migrate.ts`

**Files:**

- Modify: `libs/database/src/database.types.ts` (`migrations` required), `libs/database/src/drizzle/drizzle.factory.ts`,
  `libs/database/src/database.module.ts` (drop `?? []`)
- Create: `apps/monolith/src/database.migrations.ts`, `apps/identity-service/src/database.migrations.ts`,
  `apps/billing-service/src/database.migrations.ts`
- Create: `apps/monolith/src/migrate.ts`, `apps/identity-service/src/migrate.ts`, `apps/billing-service/src/migrate.ts`
- Modify: `apps/monolith/src/app.module.ts:33,66`, `apps/identity-service/src/app.module.ts:12,36-38`,
  `apps/billing-service/src/app.module.ts:12,35-37`
- Modify: `apps/monolith/package.json`, `apps/identity-service/package.json`, `apps/billing-service/package.json`
  (`scripts`), root `package.json` (`db:migrate`)
- Modify: `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts:15-47,105-115,237,247,255,265,301`
- Modify: `libs/database/README.md` (intro, Public API rows, Usage, Migrations, Tests, Gotchas; not the TLS paragraph or `## Environment`), `domains/identity/README.md:240-242`
- Test: `apps/monolith/src/database.migrations.spec.ts`, `apps/identity-service/src/database.migrations.spec.ts`,
  `apps/billing-service/src/database.migrations.spec.ts`, `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts`

**Interfaces:**

- Consumes: `identityMigrations` (persistence-2), `billingMigrations` (persistence-3), `runMigrationsCli`,
  `DatabaseModule.forRootAsync({ migrations })` (persistence-4).
- Produces:
  - `DatabaseModuleOptions.migrations: readonly DatabaseMigrationSet[]` (required)
  - `DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[]` per app: monolith `[identityMigrations, billingMigrations]`,
    identity-service `[identityMigrations]`, billing-service `[billingMigrations]`
  - `apps/<app>/src/migrate.ts` (→ `dist/migrate.js`), app scripts `db:migrate`, `db:migrate:dev`
  - root `db:migrate` = `bun run --filter @app/monolith db:migrate:dev`

- [ ] **Step 1: Write the failing app specs**

`apps/monolith/src/database.migrations.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (monolith)', () => {
  it('owns identity then billing; @platform/database adds the platform set first', () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['identity', 'billing']);
  });
});
```

`apps/identity-service/src/database.migrations.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (identity-service)', () => {
  it("owns the identity schema only: billing's tables are never created here", () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['identity']);
  });
});
```

`apps/billing-service/src/database.migrations.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (billing-service)', () => {
  it("owns the billing schema only: identity's tables are never created here", () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['billing']);
  });
});
```

Run: `npx vitest run --project monolith --project identity-service --project billing-service database.migrations`
Expected: FAIL x3: `Failed to load url ./database.migrations.js`.

- [ ] **Step 2: Declare each app's sets**

`apps/monolith/src/database.migrations.ts`:

```ts
import { billingMigrations } from '@domain/billing';
import { identityMigrations } from '@domain/identity';
import type { DatabaseMigrationSet } from '@platform/database';

/**
 * The Postgres migration sets the monolith owns, in order (`platformMigrations` always runs first).
 * One list for both paths: `AppModule` at boot (DATABASE_RUN_MIGRATIONS) and `migrate.ts`.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [
  identityMigrations,
  billingMigrations,
];
```

`apps/identity-service/src/database.migrations.ts`:

```ts
import { identityMigrations } from '@domain/identity';
import type { DatabaseMigrationSet } from '@platform/database';

/**
 * The Postgres migration sets identity-service owns (`platformMigrations` always runs first).
 * One list for both paths: `AppModule` at boot (DATABASE_RUN_MIGRATIONS) and `migrate.ts`.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [identityMigrations];
```

`apps/billing-service/src/database.migrations.ts`:

```ts
import { billingMigrations } from '@domain/billing';
import type { DatabaseMigrationSet } from '@platform/database';

/**
 * The Postgres migration sets billing-service owns (`platformMigrations` always runs first).
 * One list for both paths: `AppModule` at boot (DATABASE_RUN_MIGRATIONS) and `migrate.ts`.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [billingMigrations];
```

Run: `npx vitest run --project monolith --project identity-service --project billing-service database.migrations`
Expected: PASS x3.

- [ ] **Step 3: Make `migrations` required**

`libs/database/src/database.types.ts`, old:

```ts
   * DATABASE_RUN_MIGRATIONS is on. Omitted: the platform set alone.
   */
  migrations?: readonly DatabaseMigrationSet[];
```

new:

```ts
   * DATABASE_RUN_MIGRATIONS is on. `[]` when the process owns no tables.
   */
  migrations: readonly DatabaseMigrationSet[];
```

`libs/database/src/drizzle/drizzle.factory.ts`: `withPlatformMigrations(options.migrations ?? [])` →
`withPlatformMigrations(options.migrations)`.
`libs/database/src/database.module.ts`: `withPlatformMigrations(options.migrations ?? []);` →
`withPlatformMigrations(options.migrations);`.

Run: `bun run typecheck`
Expected: FAIL only at the three `DatabaseModule.forRootAsync({ schema: … })` calls in `apps/*/src/app.module.ts` and
the two in `users.repository.int-spec.ts` (`Property 'migrations' is missing`). Steps 4 and 6 fix them.

- [ ] **Step 4: Wire the sets into the three app modules**

`apps/monolith/src/app.module.ts`: after `import { KafkaProducerModule } from '@platform/transport';` add
`import { DATABASE_MIGRATIONS } from './database.migrations.js';`, and old:

```ts
    DatabaseModule.forRootAsync({ schema: DATABASE_SCHEMA }),
```

new:

```ts
    DatabaseModule.forRootAsync({ schema: DATABASE_SCHEMA, migrations: DATABASE_MIGRATIONS }),
```

`apps/identity-service/src/app.module.ts`: same import after `import { KafkaProducerModule } from '@platform/transport';`, and old:

```ts
    // Migrations run at boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked, so replicas
    // starting together apply them once).
    DatabaseModule.forRootAsync({ schema: identitySchema }),
```

new:

```ts
    // The platform set, then identity's history (DATABASE_MIGRATIONS, shared with migrate.ts), at
    // boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked: replicas starting together apply them once).
    DatabaseModule.forRootAsync({ schema: identitySchema, migrations: DATABASE_MIGRATIONS }),
```

`apps/billing-service/src/app.module.ts`: same import after `import { KafkaProducerModule } from '@platform/transport';`, and old:

```ts
    // Migrations run at boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked). Also provides
    // the transactional CLS plugin behind the webhook handler's @Transactional().
    DatabaseModule.forRootAsync({ schema: billingSchema }),
```

new:

```ts
    // The platform set, then billing's history (DATABASE_MIGRATIONS, shared with migrate.ts), at boot
    // when DATABASE_RUN_MIGRATIONS=true (advisory-locked). Also provides the transactional CLS plugin
    // behind the webhook handler's @Transactional().
    DatabaseModule.forRootAsync({ schema: billingSchema, migrations: DATABASE_MIGRATIONS }),
```

- [ ] **Step 5: Add each app's migration CLI and scripts**

`apps/monolith/src/migrate.ts`:

```ts
import 'reflect-metadata';
import { runMigrationsCli } from '@platform/database';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/*
 * One-off migration job: `node dist/migrate.js` in this app's image (docker compose `run`, a k8s
 * Job / initContainer) or `bun run --filter @app/monolith db:migrate[:dev]` (root `db:migrate`).
 * Applies the platform set, then DATABASE_MIGRATIONS, and sets the exit code (0 = schema current).
 * `reflect-metadata` first: the domain packages that export the sets declare decorated classes.
 */
await runMigrationsCli(DATABASE_MIGRATIONS);
```

`apps/identity-service/src/migrate.ts`:

```ts
import 'reflect-metadata';
import { runMigrationsCli } from '@platform/database';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/*
 * One-off migration job: `node dist/migrate.js` in this app's image (docker compose `run`, a k8s
 * Job / initContainer) or `bun run --filter @app/identity-service db:migrate[:dev]`. Applies the
 * platform set, then DATABASE_MIGRATIONS, and sets the exit code (0 = schema current).
 * `reflect-metadata` first: the domain package that exports the set declares decorated classes.
 */
await runMigrationsCli(DATABASE_MIGRATIONS);
```

`apps/billing-service/src/migrate.ts`:

```ts
import 'reflect-metadata';
import { runMigrationsCli } from '@platform/database';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/*
 * One-off migration job: `node dist/migrate.js` in this app's image (docker compose `run`, a k8s
 * Job / initContainer) or `bun run --filter @app/billing-service db:migrate[:dev]`. Applies the
 * platform set, then DATABASE_MIGRATIONS, and sets the exit code (0 = schema current).
 * `reflect-metadata` first: the domain package that exports the set declares decorated classes.
 */
await runMigrationsCli(DATABASE_MIGRATIONS);
```

In each of `apps/monolith/package.json`, `apps/identity-service/package.json`, `apps/billing-service/package.json`, old:

```json
    "start:prod": "node --import ./dist/instrument.js dist/main.js",
```

new:

```json
    "start:prod": "node --import ./dist/instrument.js dist/main.js",
    "db:migrate": "node --env-file-if-exists=../../.env --env-file-if-exists=.env dist/migrate.js",
    "db:migrate:dev": "node --env-file-if-exists=../../.env --env-file-if-exists=.env --conditions=@repo/source --import @swc-node/register/esm-register src/migrate.ts",
```

Root `package.json`, old:

```json
    "db:migrate": "bun run --filter @platform/database db:migrate:dev",
```

new:

```json
    "db:migrate": "bun run --filter @app/monolith db:migrate:dev",
```

- [ ] **Step 6: Point identity's integration spec at its own set and schema**

In `domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts`:

old:

```ts
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';
```

new:

```ts
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { identityMigrations } from './identity.migrations.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';
```

old:

```ts
 * DrizzleUsersRepository / DrizzleSessionsRepository against a real PostgreSQL 18, through the
 * real DatabaseModule, which applies the REAL generated migrations (@platform/database
 * src/migrations) at boot. Opt-in (needs Docker):
```

new:

```ts
 * DrizzleUsersRepository / DrizzleSessionsRepository against a real PostgreSQL 18, through the
 * real DatabaseModule, which applies the platform set and identity's REAL generated history
 * (./migrations, schema `identity`) at boot, like identity-service. Opt-in (needs Docker):
```

old: `    DatabaseModule.forRootAsync({ schema: identitySchema, runMigrations: true }),` → new:

```ts
    DatabaseModule.forRootAsync({
      schema: identitySchema,
      migrations: [identityMigrations],
      runMigrations: true,
    }),
```

old: `    DatabaseModule.forRootAsync({ schema: identitySchema, postgres: { max: 1 } }),` → new:

```ts
    DatabaseModule.forRootAsync({
      schema: identitySchema,
      migrations: [identityMigrations],
      postgres: { max: 1 },
    }),
```

Replace the test `boot applied the initial migration (identity + billing tables, enums)` (lines 105-115) with:

```ts
  it("boot applied the platform set and identity's history only, into their own schemas", async () => {
    const tables = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('app', 'identity', 'billing')`);
    // identity-service never creates billing's tables: each app applies only its own sets.
    expect(tables.map((row) => row.name).toSorted()).toEqual([
      'app.__drizzle_migrations',
      'identity.__drizzle_migrations',
      'identity.sessions',
      'identity.users',
    ]);
    const enums = await db.execute<{ name: string }>(sql`
      select n.nspname || '.' || t.typname as name
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typname in ('user_role', 'payment_status') and n.nspname <> 'public'`);
    expect(enums.map((row) => row.name)).toEqual(['identity.user_role']);
    const [trgm] = await db.execute<{ schema: string }>(sql`
      select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_trgm'`);
    expect(trgm?.schema).toBe('public');
  });
```

and these literal replacements:

```text
/"users"\."id" = \$1/                                         → /"identity"\."users"\."id" = \$1/
select indexdef from pg_indexes where indexname = 'users_search_trgm_idx'
→ select indexdef from pg_indexes where schemaname = 'identity' and indexname = 'users_search_trgm_idx'
explain select id from users                                  → explain select id from identity.users
insert into users (email, password_hash, display_name)        → insert into identity.users (email, password_hash, display_name)
delete from users where id = ${user.id}                       → delete from identity.users where id = ${user.id}
```

`domains/identity/README.md` (line 242):

```text
applies the generated `@platform/database` migrations, then covers the repositories: the hash-free
→ applies the platform set and identity's own history (schema `identity`), then covers the repositories: the hash-free
```

- [ ] **Step 7: Update the package README for the final API (targeted: keep the TLS paragraph and `## Environment`)**

`libs/database/README.md` also carries lane D's TLS paragraph (between the intro and `## Public API`) and its
`## Environment` section: leave both untouched. Replace only the blocks below.

Intro, old:

```markdown
PostgreSQL for the monorepo. It provides a tuned **postgres.js** pool, **Drizzle ORM** (a global
`DatabaseModule`), transactions that propagate through CLS (`@Transactional()`), drizzle-kit
migrations applied by an **advisory-locked** runner (at boot or from the `migrate.ts` CLI), a
readiness contributor, and **uuidv7 keyset-pagination** helpers.

Domain tables live in the domain packages as `*.schema.ts` files (`domains/identity`, `domains/billing`). This package
owns the connection, the migration history and the tooling.
```

new:

```markdown
PostgreSQL for the monorepo. It provides a tuned **postgres.js** pool, **Drizzle ORM** (a global
`DatabaseModule`), transactions that propagate through CLS (`@Transactional()`), **migration sets** applied by an
**advisory-locked** runner (at boot, or by each app's `migrate.ts` through `runMigrationsCli`), a readiness
contributor, and **uuidv7 keyset-pagination** helpers.

Domain tables live in the domain packages, each in its own Postgres schema with its own drizzle-kit config and
migration history (`domains/identity`, `domains/billing`). This package owns the connection, the runner, the
**platform set** (schema `app`, extensions) and the rule that the platform set always runs first.
```

Public API table: replace the rows whose first cell is listed on the left with the rows on the right (prettier
realigns the columns in Step 10):

```text
`DatabaseModule.forRootAsync<S>(options: DatabaseModuleOptions<S>): DynamicModule`
→ | `DatabaseModule.forRootAsync<S>(options: DatabaseModuleOptions<S>): DynamicModule` | module (global) | Pool + Drizzle handle, transactional CLS plugin, migrations on boot, health indicator. Validates `migrations` when called |

`DatabaseModuleOptions<S>`
→ | `DatabaseModuleOptions<S>` | interface | `{ schema: S; migrations: readonly DatabaseMigrationSet[]; runMigrations?; transactional?: boolean \| DatabaseTransactionalOptions; postgres?: PostgresOptions }` |

`runMigrations(url, options?): Promise<MigrationRunSummary>`
→ | `runMigrations(url, options): Promise<MigrationRunSummary>` | fn | Exactly `options.migrations`, in order: single-session client + `pg_try_advisory_lock` polling + drizzle `migrate()` per set |

`RunMigrationsOptions`, `MigrationRunSummary`, `DEFAULT_MIGRATIONS_FOLDER`
→ | `RunMigrationsOptions`, `MigrationRunSummary`, `MigrationSetSummary` | types | `{ migrations, logger?, applicationName?, lockTimeoutMs?, lockPollIntervalMs? }` → `{ sets: [{ name, folder, total, applied }], total, applied }` |
  | `runMigrationsCli(migrations, args?)` | fn | Body of every app's `src/migrate.ts`: config from env, platform set + `migrations`, JSON log lines, `process.exitCode` |

`MIGRATIONS_SCHEMA` (`public`), `MIGRATIONS_TABLE` (`__drizzle_migrations`), `MIGRATIONS_ADVISORY_LOCK_ID`
→ | `MIGRATIONS_TABLE` (`__drizzle_migrations`), `MIGRATIONS_ADVISORY_LOCK_ID` | consts | The bookkeeping table name of every set; the one lock key |
```

Usage block, old:

```ts
// app.module.ts
import { identitySchema } from '@domain/identity'; // the domain's tables + relations record
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] }),
    DatabaseModule.forRootAsync({ schema: identitySchema }), // monolith: { ...identitySchema, ...billingSchema }
  ],
})
export class AppModule {}
```

new:

```ts
// apps/identity-service/src/database.migrations.ts — one list for AppModule and migrate.ts
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [identityMigrations];

// app.module.ts
import { identitySchema } from '@domain/identity'; // the domain's tables + relations record
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] }),
    // monolith: { ...identitySchema, ...billingSchema } and [identityMigrations, billingMigrations]
    DatabaseModule.forRootAsync({ schema: identitySchema, migrations: DATABASE_MIGRATIONS }),
  ],
})
export class AppModule {}

// migrate.ts — the release job (`node dist/migrate.js`)
import 'reflect-metadata';
await runMigrationsCli(DATABASE_MIGRATIONS);
```

Migrations: replace everything from the line `Migrations:` down to (and including) the paragraph that ends
`In production, prefer running the CLI as a one-off job.` (just above `## Environment`) with:

````markdown
## Migrations

| Set | Postgres schema | Files | Produced by |
| --- | --- | --- | --- |
| `platformMigrations` | `app` | `libs/database/src/platform/migrations` | hand-written ([Platform migration set](#platform-migration-set)) |
| `identityMigrations` | `identity` | `domains/identity/src/infrastructure/persistence/migrations` | `domains/identity/drizzle.config.ts` |
| `billingMigrations` | `billing` | `domains/billing/src/infrastructure/persistence/migrations` | `domains/billing/drizzle.config.ts` |

- **Order.** `DatabaseModule` (with `runMigrations` / `DATABASE_RUN_MIGRATIONS`) and `runMigrationsCli` apply
  `withPlatformMigrations(migrations)`: the platform set, then the app's sets in array order, under ONE advisory lock
  (`MIGRATIONS_ADVISORY_LOCK_ID`) on one dedicated connection. identity-service and billing-service can share a
  database and boot together: their runs are serialised.
- **One bookkeeping table per set** (`<schema>.__drizzle_migrations`). drizzle's migrator compares file timestamps only
  with the newest row of the table it writes to, so two histories in one table would silently skip the older one's
  files. `withPlatformMigrations` rejects a shared table.
- Each set's pending files run in one transaction (all-or-nothing per set); a set that already ran stays applied when
  a later set fails.

```bash
bun run db:generate                                    # drizzle-kit generate in every domain (commit the output)
bun run --filter @domain/identity db:generate --name <change>
bun run db:migrate                                     # the monolith's src/migrate.ts from sources (root .env)
bun run --filter @app/identity-service db:migrate      # an app's dist/migrate.js (after build): the release job
bun run db:studio                                      # Drizzle Studio per domain (identity 4983, billing 4984)
```

`runMigrationsCli` logs one JSON object per line (`ConsoleLogger({ json: true })`, what log shippers ingest from
deploy jobs); `LOG_PRETTY=true` (default in development) switches to coloured text. Exit code 0 = schema current,
1 = failure (an unknown flag included).

A domain's first migration comes from `bun run --filter @domain/<x> db:generate --name init`. drizzle-kit writes
`CREATE SCHEMA "<x>";` first, but the migrator has already created that schema for `<x>.__drizzle_migrations`, so
change that line to `CREATE SCHEMA IF NOT EXISTS "<x>";` (the domain's `*.migrations.spec.ts` checks it). Every other
generated file is committed as generated. Never edit an applied migration.

Set `DATABASE_RUN_MIGRATIONS=true` (or `runMigrations: true`) to migrate at boot. In production, prefer each app's
`dist/migrate.js` as a one-off job.
````

Tests, old:

```markdown
- Unit (`bunx vitest run --project database`) needs no database. `test/fake-sql.ts` fakes the postgres.js pool
  (`unsafe`, `begin`, `end`), so drizzle's real session code runs: module wiring, `@Transactional()` commit and
  rollback, boot retries, the migration lock and health are all covered.
- Integration (`INTEGRATION=1 bunx vitest run --project database:int`) uses `postgres:18.6-alpine3.24` through
  testcontainers. It covers concurrent `runMigrations`, the CLI, boot migrations, startup GUCs, `uuidv7()` defaults,
  transactions, keyset paging, health and shutdown. The fixtures in `test/fixtures/migrations` are real drizzle-kit
  output: `drizzle-kit generate --dialect=postgresql --schema=./test/fixtures/widgets.schema.ts --out=./test/fixtures/migrations --casing=snake_case`.
```

new:

```markdown
- Unit (`bunx vitest run --project database`) needs no database. `test/fake-sql.ts` fakes the postgres.js pool
  (`unsafe`, `begin`, `end`), so drizzle's real session code runs: module wiring, `@Transactional()` commit and
  rollback, boot retries, the platform-first rule, the per-set runner under one lock, the CLI and health are covered.
- Integration (`INTEGRATION=1 bunx vitest run --project database:int`) uses `postgres:18.6-alpine3.24` through
  testcontainers. It covers concurrent `runMigrations` over two sets, separate bookkeeping tables (`gadgets`, a set
  with older timestamps, still applies), the CLI (`test/fixtures/migrate.ts`, an app-style entry), boot migrations,
  startup GUCs, `uuidv7()` defaults, transactions, keyset paging, health and shutdown. `test/fixtures/migrations` is
  real drizzle-kit output (`drizzle-kit generate --dialect=postgresql --schema=./test/fixtures/widgets.schema.ts
  --out=./test/fixtures/migrations --casing=snake_case`); `test/fixtures/gadgets/migrations` is hand-written.
```

Gotchas, old:

```markdown
- `*.schema.ts` files may import only `drizzle-orm*` and relative files, because drizzle-kit loads them with its own
  loader. `casing: 'snake_case'` must match in `drizzle.config.ts` and at runtime. Raw SQL still uses snake_case.
```

new:

```markdown
- `*.schema.ts` files may import only `drizzle-orm*` and relative files, because drizzle-kit loads them with its own
  loader. Declare tables with `pgSchema('<x>').table(...)` and export the `pgSchema` object (drizzle-kit emits
  `CREATE SCHEMA` only for exports). `casing: 'snake_case'` must match in every `drizzle.config.ts` and at runtime.
  Raw SQL uses snake_case and schema-qualified names (`identity.users`, `ARRAY['user']::identity.user_role[]`).
- The compose and testcontainers role is `app`, and the platform set creates schema `app`: the default `search_path`
  (`"$user", public`) then starts with `app`, so unqualified DDL run as that role lands in `app`. Qualify names in
  hand-written SQL.
```

old:

```markdown
- `migrate()` runs every pending migration in **one transaction**, so `CREATE INDEX CONCURRENTLY` is impossible.
  A migration whose journal timestamp is older than the last applied one is **silently skipped**: regenerate after
  merges and run `drizzle-kit check` in CI.
```

new:

```markdown
- `migrate()` runs a set's pending migrations in **one transaction**, so `CREATE INDEX CONCURRENTLY` is impossible.
  A migration whose journal timestamp is older than the last applied one **of the same set** is **silently
  skipped**: regenerate after merges and run `drizzle-kit check` in CI.
```

and delete the last bullet:

```markdown
- `drizzle.config.ts` drops globs that match nothing, so `drizzle-kit check/studio` work before any domain
  schema exists. `generate` still reports "No schema files found".
```

- [ ] **Step 8: Run unit, e2e and integration projects**

Run: `npx vitest run --project database --project monolith --project identity-service --project billing-service --project identity --project billing --project monolith:e2e --project identity-service:e2e --project billing-service:e2e`
Expected: PASS.

Run (needs Docker): `INTEGRATION=1 npx vitest run --project identity:int --project database:int`
Expected: PASS, including `boot applied the platform set and identity's history only` and `search uses the pg_trgm
GIN index (users_search_trgm_idx)` (the gate for the pg_trgm placement: testcontainers runs no init script).

- [ ] **Step 9: Build and check the shipped files**

Run: `bun run build && for f in apps/monolith/dist/migrate.js apps/identity-service/dist/migrate.js apps/billing-service/dist/migrate.js domains/identity/dist/infrastructure/persistence/migrations/meta/_journal.json domains/billing/dist/infrastructure/persistence/migrations/0000_init.sql libs/database/dist/platform/migrations/0000_init.sql; do test -f "$f" || echo "missing $f"; done`
Expected: build succeeds; no `missing` line.

- [ ] **Step 10: Format and run the repository gate**

Run: `bunx biome check --write apps/monolith/src apps/identity-service/src apps/billing-service/src libs/database domains/identity/src && bunx prettier --write libs/database/README.md domains/identity/README.md && bun run check`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add libs/database apps/monolith/src apps/identity-service/src apps/billing-service/src \
  apps/monolith/package.json apps/identity-service/package.json apps/billing-service/package.json package.json \
  domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts domains/identity/README.md
git commit -F- <<'EOF'
refactor(repo): apps declare their migration sets for boot and migrate.ts

- DATABASE_MIGRATIONS per app (monolith: identity, billing; identity-service:
  identity; billing-service: billing), shared by AppModule and src/migrate.ts
- DatabaseModuleOptions.migrations is required; db:migrate runs the monolith CLI
- identity's integration spec boots its own set and checks the identity schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-6: billing's baseline proven on PostgreSQL

**Files:**

- Create: `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts`
- Modify: `domains/billing/package.json` (`devDependencies`), `bun.lock`
- Modify: `docs/TESTING.md:233` (add a row after the identity int-spec row)
- Test: `domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts` (project `billing:int`)

**Interfaces:**

- Consumes: `billingMigrations`, `billingSchema`, `BillingSchema` (persistence-3), `DatabaseModule.forRootAsync({ schema, migrations })` (persistence-5).
- Produces: the `billing:int` integration project content (picked up by `bun run test:int` in CI).

- [ ] **Step 1: Add the testcontainers devDependency**

`domains/billing/package.json` `devDependencies`: after `"@nestjs/testing": "catalog:",` add
`"@testcontainers/postgresql": "catalog:",`. Then run `bun install` (expected: success, `bun.lock` changes).

- [ ] **Step 2: Write the integration spec**

`domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts`:

```ts
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateId, isUuidV7 } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { billingMigrations } from './billing.migrations.js';
import { type BillingSchema, billingSchema } from './billing.schema.js';

/*
 * Billing's generated history against a real PostgreSQL 18, through the DatabaseModule wiring
 * billing-service boots: the platform set, then billingMigrations, into the `billing` schema.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int
 * Set INTEGRATION_DATABASE_URL to use an existing throwaway database instead of testcontainers.
 */

const IMAGE = 'postgres:18.6-alpine3.24';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    DatabaseModule.forRootAsync({
      schema: billingSchema,
      migrations: [billingMigrations],
      runMigrations: true,
    }),
  ],
})
class BillingPersistenceModule {}

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing migrations on PostgreSQL 18', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplicationContext;
  let db: DrizzleDB<BillingSchema>;

  beforeAll(async () => {
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
    vi.stubEnv('SERVICE_NAME', 'billing-int');
    app = await NestFactory.createApplicationContext(BillingPersistenceModule, { logger: false });
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it("creates billing's tables and enum in the billing schema, and none of identity's", async () => {
    const tables = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('app', 'billing', 'identity')`);
    expect(tables.map((row) => row.name).toSorted()).toEqual([
      'app.__drizzle_migrations',
      'billing.__drizzle_migrations',
      'billing.payments',
      'billing.stripe_events',
    ]);
    const [status] = await db.execute<{ labels: string }>(sql`
      select string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'billing' and t.typname = 'payment_status'`);
    expect(status?.labels).toBe('pending,succeeded,failed,expired');
  });

  it('carries every index of the former 0000 and 0002 migrations', async () => {
    // billing.__drizzle_migrations (the migrator's SERIAL PRIMARY KEY) is not part of the history.
    const indexes = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'billing' and tablename in ('payments', 'stripe_events')`);
    expect(indexes.map((row) => row.indexname).toSorted()).toEqual([
      'payments_pkey',
      'payments_stripe_checkout_session_id_unique',
      'payments_user_id_id_idx',
      'payments_user_id_idempotency_key_uq',
      'stripe_events_pkey',
      'stripe_events_processed_at_idx',
    ]);
  });

  it('the DB defaults (uuidv7 id, pending status) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; status: string }>(sql`
      insert into billing.payments (user_id, price_id, quantity)
      values (${generateId()}, 'price_int', 1) returning id, status`);
    expect(isUuidV7(row?.id)).toBe(true);
    expect(row?.status).toBe('pending');
  });
});
```

- [ ] **Step 3: Run it (needs Docker)**

Run: `INTEGRATION=1 npx vitest run --project billing:int`
Expected: PASS (3 tests). Without `INTEGRATION=1` the suite is skipped.

- [ ] **Step 4: List it in the testing guide**

`docs/TESTING.md`: after the `users.repository.int-spec.ts` row add

```markdown
| [`domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts`](../domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts) | `billing:int` | Docker (testcontainers), **or** `INTEGRATION_DATABASE_URL` pointing at an existing throwaway database | billing's generated history after the platform set: tables, enum and indexes in schema `billing`, DB defaults |
```

Run: `bunx biome check --write domains/billing && bunx prettier --write docs/TESTING.md && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts domains/billing/package.json bun.lock docs/TESTING.md
git commit -F- <<'EOF'
test(billing): prove the billing baseline on PostgreSQL 18

Boots DatabaseModule with billingMigrations like billing-service and checks the
billing schema's tables, enum, indexes and defaults.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task persistence-7: Documentation, config comments and the local reset note

All edits are targeted replacements (lanes D, F and others edit neighbouring lines of these files).

**Files:**

- Modify: `README.md:37,41,112-116,319,385-387` (+ a new note after line 116)
- Modify: `docs/DEVELOPMENT.md:88,186,227-231,340,412-428,495` (+ one troubleshooting row)
- Modify: `docs/DOCKER.md:209-215,432`, `docs/RELEASING.md:133,147,156`, `docs/CONFIGURATION.md:32,64,177`,
  `docs/TESTING.md:232-233`, `docs/PERFORMANCE.md:144`
- Modify: `apps/identity-service/README.md:24,60`, `apps/billing-service/README.md:27,56`, `apps/monolith/README.md:61`
- Modify: `domains/identity/README.md:51,53,61,78`, `domains/billing/README.md:41,51`
- Modify: `.env.example:81`, `apps/identity-service/.env.example:19-21`, `apps/billing-service/.env.example:20-22`
- Modify: `docker-compose.yml:71-72`, `docker/postgres/init/01-extensions.sql:2-3,7`
- Test: `bun run check` (prettier + biome), `node scripts/check-env-example.mjs`

**Interfaces:**

- Consumes: everything above (names and commands as produced by persistence-1..6).
- Produces: none (docs only).

- [ ] **Step 1: README: layout rows, the migrate note and the local reset note**

`README.md`:

```text
(line 37, PostgreSQL 18 row, 2nd cell)
`libs/database` (postgres.js pool, health, migrator), `libs/database/src/migrations/*.sql`, `docker/postgres`
→ `libs/database` (postgres.js pool, health, migration runner, platform set `libs/database/src/platform/migrations`), `docker/postgres`

(line 37, 3rd cell)
identity users/sessions, billing payments: `domains/identity/src/infrastructure/persistence`, `domains/billing/src/infrastructure/persistence`
→ identity users/sessions (schema `identity`), billing payments (schema `billing`), each with its own `migrations/`: `domains/identity/src/infrastructure/persistence`, `domains/billing/src/infrastructure/persistence`

(line 41, Drizzle ORM row)
`drizzle-kit` (`db:generate`, `db:studio`)
→ `drizzle-kit` per domain (`domains/*/drizzle.config.ts`: `db:generate`, `db:studio`)

(line 319, layout block)
│   ├── database/                  # Drizzle + postgres.js, migrations, keyset pagination
→ │   ├── database/                  # Drizzle + postgres.js, migration runner + platform set, keyset pagination

(line 385) | `db:generate` | generate a Drizzle migration from the schema (`drizzle-kit generate`) |
→ | `db:generate` | generate each domain's Drizzle migration from its schema (`drizzle-kit generate` in `domains/identity`, `domains/billing`) |
(line 386) | `db:migrate` | apply the Drizzle migrations (root `.env` `DATABASE_URL`) |
→ | `db:migrate` | apply the platform set, then identity's and billing's histories (the monolith's `migrate.ts`, root `.env` `DATABASE_URL`) |
(line 387) | `db:studio` | Drizzle Studio |
→ | `db:studio` | Drizzle Studio per domain (identity on port 4983, billing on 4984) |
```

old (lines 112-113):

```markdown
- `bun run db:migrate` runs `libs/database/src/migrate.ts` against the `DATABASE_URL` of the root `.env`. It is
  optional on a dev machine: every app `.env.example` that owns Postgres tables sets `DATABASE_RUN_MIGRATIONS=true`, so
```

new:

```markdown
- `bun run db:migrate` runs the monolith's `src/migrate.ts` (the platform set, then identity's and billing's
  histories) against the `DATABASE_URL` of the root `.env`. It is
  optional on a dev machine: every app `.env.example` that owns Postgres tables sets `DATABASE_RUN_MIGRATIONS=true`, so
```

and insert after the bullet that ends `(`CASSANDRA_RUN_MIGRATIONS=true`).`:

```markdown
- **A local database from before the per-domain schemas.** Identity's and billing's tables now live in the
  `identity` and `billing` Postgres schemas, each with its own history starting at `0000_init`; nothing moves the old
  `public` tables. The apps still boot (they create the new schemas), but users and payments created before are left
  behind in `public`. Reset once with `docker compose --profile '*' down -v` (it deletes every local volume: Postgres,
  Cassandra, Kafka, Redis and the buckets), then `bun run docker:infra`.
```

- [ ] **Step 2: DEVELOPMENT.md: the database section and the new-domain steps**

Replace the whole `## Database migrations (Postgres / Drizzle)` section (lines 412-428, up to `## Cassandra CQL
migrations`) with:

```markdown
## Database migrations (Postgres / Drizzle)

Each Postgres-backed context owns a Postgres **schema** and its own **migration history**:

| Set        | Schema     | History (`NNNN_name.sql` + `meta/`)                          | drizzle-kit config                   | Bookkeeping table               |
| ---------- | ---------- | ------------------------------------------------------------ | ------------------------------------ | ------------------------------- |
| platform   | `app`      | `libs/database/src/platform/migrations` (hand-written)       | none                                 | `app.__drizzle_migrations`      |
| identity   | `identity` | `domains/identity/src/infrastructure/persistence/migrations` | `domains/identity/drizzle.config.ts` | `identity.__drizzle_migrations` |
| billing    | `billing`  | `domains/billing/src/infrastructure/persistence/migrations`  | `domains/billing/drizzle.config.ts`  | `billing.__drizzle_migrations`  |

- Tables are declared on an exported `pgSchema('<x>')` in the domain's `*.schema.ts`, with `casing: 'snake_case'`
  (the casing the runtime `drizzle()` uses). Raw SQL qualifies names (`identity.users`).
- One bookkeeping table per set is mandatory: drizzle's migrator only applies files newer than the **last** row of
  its table, so two histories sharing a table would silently skip the older one's files. `DatabaseModule` rejects two
  sets with one table.
- **Order.** `DatabaseModule.forRootAsync({ schema, migrations })` and each app's `src/migrate.ts` apply the platform
  set first (it cannot be left out), then the app's sets in array order, all under one advisory lock. Each app lists
  its sets once, in `src/database.migrations.ts`: the monolith `[identityMigrations, billingMigrations]`,
  identity-service `[identityMigrations]`, billing-service `[billingMigrations]`.

| Command                                  | What it does                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run db:generate`                    | `drizzle-kit generate` in every domain that has a config: a new SQL migration from that domain's schema diff. Review the SQL, then commit it with `meta/`.                  |
| `bun run db:migrate`                     | The monolith's `src/migrate.ts` from **sources** (swc-node, `@repo/source`) with the root `.env` and `apps/monolith/.env`: the platform set, identity, billing.              |
| `bun run --filter @app/<app> db:migrate` | The same from the app's `dist/migrate.js` (needs `bun run build`), with that app's sets. This is the production release job. See [DOCKER.md](DOCKER.md).                    |
| `bun run db:studio`                      | Drizzle Studio per domain against `DATABASE_URL`: identity on port 4983, billing on 4984.                                                                                   |

Notes:

- `DATABASE_RUN_MIGRATIONS=true` (set in the per-app `.env` of the monolith, identity-service and billing-service) applies the sets at boot under a Postgres **advisory lock**, so replicas and services that boot together apply each file once. In production, set it to `false` and run each app image's migrate job.
- Migrations are forward-only. Write expand/contract changes (add a nullable column → backfill → enforce) so the old and new versions of the code can run side by side during a rollout.
- One domain at a time: `bun run --filter @domain/identity db:generate --name <change>`. A hand-written domain migration: add `--custom` for an empty file registered in that domain's journal.
- **A new history** starts with `bun run --filter @domain/<x> db:generate --name init`. Change its first statement from `CREATE SCHEMA "<x>";` to `CREATE SCHEMA IF NOT EXISTS "<x>";`: the migrator creates the schema first, for `<x>.__drizzle_migrations`. It is the only hand edit of generated SQL, and the domain's `*.migrations.spec.ts` checks it.
- SQL that belongs to no domain (extensions; grants and functions from B3) goes in the platform set: add `NNNN_name.sql` and its `meta/_journal.json` entry by hand ([libs/database/README.md](../libs/database/README.md#platform-migration-set)).
- CI runs `bun run db:generate` and fails if it produces a diff or a new untracked file under `domains/*/src/infrastructure/persistence/migrations`. A `*.schema.ts` change without its migration cannot merge.
```

Other DEVELOPMENT.md replacements:

```text
(line 88) `bun run --filter @platform/database db:migrate`  →  `bun run --filter @app/<app> db:migrate`

(line 186) Never edit either output by hand.
→ Never edit either output by hand, apart from the one-line `CREATE SCHEMA IF NOT EXISTS` edit of a domain's first migration ([migrations](#database-migrations-postgres--drizzle)).

(line 340) `DatabaseModule.forRootAsync({ schema: ordersSchema })`
→ `DatabaseModule.forRootAsync({ schema: ordersSchema, migrations: DATABASE_MIGRATIONS })`

(line 495, drift row) `libs/database/src/migrations`  →  `domains/<domain>/src/infrastructure/persistence/migrations`
```

old (lines 227-231):

```markdown
**4. Persistence (Postgres).** Put the tables in `src/infrastructure/persistence/orders.schema.ts` and export an `ordersSchema` object, then:

- add `'../../domains/orders/src/**/*.schema.ts'` to `SCHEMA_GLOBS` in `libs/database/drizzle.config.ts` (one migration history for every context),
- merge the schema into the app's Drizzle schema: `const DATABASE_SCHEMA = { ...identitySchema, ...billingSchema, ...ordersSchema }` in `apps/monolith/src/app.module.ts`,
- run `bun run db:generate` and commit the new SQL plus `meta/` snapshot (see [migrations](#database-migrations-postgres--drizzle)).
```

new:

```markdown
**4. Persistence (Postgres).** Put the tables in `src/infrastructure/persistence/orders.schema.ts`, declared on an exported `ordersPgSchema = pgSchema('orders')`, and export an `ordersSchema` object, then:

- copy `domains/billing/drizzle.config.ts` (`schemaFilter: ['orders']`, `migrations: { schema: 'orders', table: '__drizzle_migrations' }`), the package's `db:generate` / `db:studio` scripts (pick a free studio port) and its `drizzle-kit` devDependency,
- export `ordersMigrations` from `src/infrastructure/persistence/orders.migrations.ts` (copy `billing.migrations.ts` and its spec),
- run `bun run --filter @domain/orders db:generate --name init`, change the first statement of the new `0000_init.sql` to `CREATE SCHEMA IF NOT EXISTS "orders";`, and commit the SQL plus `meta/` (see [migrations](#database-migrations-postgres--drizzle)),
- merge the schema into the app's Drizzle schema (`const DATABASE_SCHEMA = { ...identitySchema, ...billingSchema, ...ordersSchema }` in `apps/monolith/src/app.module.ts`) and add `ordersMigrations` to the app's `src/database.migrations.ts`.
```

After the line 340 bullet (`src/app.module.ts`: …) add:

```markdown
- `src/database.migrations.ts` (`DATABASE_MIGRATIONS = [ordersMigrations]`), `src/migrate.ts` (`import 'reflect-metadata'`, then `await runMigrationsCli(DATABASE_MIGRATIONS)`) and the `db:migrate` / `db:migrate:dev` scripts: copy them from `apps/billing-service`.
```

Add this row to the troubleshooting table, after the `CI "Generated artefacts drift" fails` row:

```markdown
| Users or payments created before the per-domain schemas are missing | The tables moved from `public` to the `identity` and `billing` schemas with fresh histories; the old `public` tables are orphaned. Reset once: `docker compose --profile '*' down -v` (deletes every local volume), then `bun run docker:infra`. |
```

- [ ] **Step 3: DOCKER.md, RELEASING.md, CONFIGURATION.md, TESTING.md, PERFORMANCE.md**

`docs/DOCKER.md`, old (lines 209-214):

```markdown
- **Postgres**: `docker/postgres/init/01-extensions.sql` (first start only) adds `pg_stat_statements` and `pg_trgm`.
  Tables come from the Drizzle migrations (`libs/database/src/migrations`), applied at boot under an advisory lock
  (`DATABASE_RUN_MIGRATIONS=true`). In production, run them as a release job with the same image:
  `docker compose run --rm --no-deps -w /app/libs/database identity-service dist/migrate.js` (Kubernetes: a Job
  with `workingDir: /app/libs/database`, `args: [dist/migrate.js]`) and set `DATABASE_RUN_MIGRATIONS=false`. The
  image's entrypoint is `node`, so the args replace only the default `CMD`. Release flow: [RELEASING.md](RELEASING.md).
```

new:

```markdown
- **Postgres**: `docker/postgres/init/01-extensions.sql` (first start only) adds `pg_stat_statements` and `pg_trgm`.
  Tables come from the Drizzle migration sets, applied at boot under one advisory lock
  (`DATABASE_RUN_MIGRATIONS=true`): `@platform/database`'s platform set (schema `app`, `pg_trgm`), then the app's own
  domain histories (identity-service: `identity`; billing-service: `billing`; monolith: both). In production, run
  them as a release job with the same image, from the app's folder (the image's `WORKDIR`):
  `docker compose run --rm --no-deps identity-service dist/migrate.js` (Kubernetes: a Job with
  `args: [dist/migrate.js]`) and set `DATABASE_RUN_MIGRATIONS=false`. The image's entrypoint is `node`, so the args
  replace only the default `CMD`. Release flow: [RELEASING.md](RELEASING.md).
```

and on line 432 replace the token `` `libs/database/src/migrations` `` with
`` `domains/*/src/infrastructure/persistence/migrations` ``.

`docs/RELEASING.md`:

```text
(line 133) then `dist/migrate.js` from the same image)
→ then each app image's own `dist/migrate.js`: the platform set plus that app's domain histories)
(line 147, prose in the verify row) `libs/database/src/migrations`
→ `domains/*/src/infrastructure/persistence/migrations`
(line 156, shell command) libs/database/src/migrations
→ 'domains/*/src/infrastructure/persistence/migrations/*'
```

`docs/CONFIGURATION.md`:

```text
(line 32) migration CLI (`libs/database/src/migrate.ts`)
→ migration CLIs (`apps/<app>/src/migrate.ts`, through `runMigrationsCli`)
(line 64) and, for the root file, by `bun run db:migrate`
→ and, for the root file and `apps/monolith/.env`, by `bun run db:migrate`
(line 177, DATABASE_RUN_MIGRATIONS description)
Apply the Drizzle migrations at boot under a Postgres advisory lock; otherwise run `bun run db:migrate`.
→ Apply the platform migration set and the app's domain sets at boot under a Postgres advisory lock; otherwise run the app's `migrate.ts` (`bun run db:migrate`, or `dist/migrate.js` in the image).
```

`docs/TESTING.md`:

```text
(line 232, database:int Covers cell) migrations, PG18-native `uuidv7()`, `@Transactional()`
→ migration sets (one lock, one bookkeeping table per set), the CLI, PG18-native `uuidv7()`, `@Transactional()`
(line 233, identity:int Covers cell) which applies the real generated migrations at boot
→ which applies the platform set and identity's own history at boot (schema `identity`)
```

`docs/PERFORMANCE.md:144`: `` `execute 8un1sm59my3: insert into "users" …` `` → `` `execute 8un1sm59my3: insert into "identity"."users" …` ``.

- [ ] **Step 4: App and domain READMEs**

```text
apps/identity-service/README.md
(line 24) `DatabaseModule.forRootAsync({ schema: identitySchema })` | … boot-time migrations
→ `DatabaseModule.forRootAsync({ schema: identitySchema, migrations: DATABASE_MIGRATIONS })` | … boot-time migrations (platform set + identity)
(line 60) advisory-locked; set `false` when a `bun run db:migrate` job owns it
→ advisory-locked (platform set + identity); set `false` when a `dist/migrate.js` job owns it

apps/billing-service/README.md
(line 27) `DatabaseModule.forRootAsync({ schema: billingSchema })`
→ `DatabaseModule.forRootAsync({ schema: billingSchema, migrations: DATABASE_MIGRATIONS })`
(line 56) advisory-locked; the history is shared with identity (one `0000_init`)
→ advisory-locked: the platform set, then billing's own history (schema `billing`)

apps/monolith/README.md
(line 61) apply the drizzle migrations at boot (advisory-locked)
→ apply the platform set, identity and billing migrations at boot (advisory-locked)

domains/identity/README.md (lines 51 and 61)
DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema } })
→ DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema }, migrations: [identityMigrations, billingMigrations] })
domains/identity/README.md (lines 53 and 78)
DatabaseModule.forRootAsync({ schema: identitySchema })
→ DatabaseModule.forRootAsync({ schema: identitySchema, migrations: [identityMigrations] })

domains/billing/README.md (line 41)
DatabaseModule.forRootAsync({ schema: billingSchema }),
→ DatabaseModule.forRootAsync({ schema: billingSchema, migrations: [billingMigrations] }),
domains/billing/README.md (line 51)
DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema } }),
→ DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema }, migrations: [identityMigrations, billingMigrations] }),
```

- [ ] **Step 5: Env examples, compose and the init script comments**

`.env.example:81`, old:

```dotenv
# Run Drizzle migrations at boot (advisory-locked); otherwise `bun run db:migrate`
```

new:

```dotenv
# Run the Drizzle migrations at boot (platform set, then the app's domain sets; advisory-locked);
# otherwise `bun run db:migrate`
```

`apps/identity-service/.env.example`, old:

```dotenv
# Apply the shared Drizzle migrations (libs/database/src/migrations) at boot, under a Postgres
# advisory lock (replicas booting together apply them once). Set false when a separate
# `bun run db:migrate` job owns migrations.
```

new:

```dotenv
# Apply the platform set and identity's Drizzle history (schema identity) at boot, under a Postgres
# advisory lock (replicas booting together apply them once). Set false when a separate
# `node dist/migrate.js` job owns migrations.
```

`apps/billing-service/.env.example`, old:

```dotenv
# Apply the shared Drizzle migrations (libs/database/src/migrations) at boot, under a Postgres
# advisory lock (replicas booting together apply them once). Set false when a separate
# `bun run db:migrate` job owns migrations.
```

new:

```dotenv
# Apply the platform set and billing's Drizzle history (schema billing) at boot, under a Postgres
# advisory lock (replicas booting together apply them once). Set false when a separate
# `node dist/migrate.js` job owns migrations.
```

`docker-compose.yml:71-72`, old:

```yaml
  # Advisory-locked, so concurrent replicas/services are safe. Production: run it as a job
  # (`docker compose run --rm -w /app/libs/database identity-service dist/migrate.js`).
```

new:

```yaml
  # Advisory-locked, so concurrent replicas/services are safe. Each app applies the platform set plus
  # its own domain sets. Production: run them as a job per app image
  # (`docker compose run --rm --no-deps identity-service dist/migrate.js`).
```

`docker/postgres/init/01-extensions.sql`, old (lines 2-3):

```sql
-- Schema objects are NOT created here: the apps own them through Drizzle migrations
-- (@platform/database, advisory-locked; DATABASE_RUN_MIGRATIONS=true in compose).
```

new:

```sql
-- Schema objects are NOT created here: the apps own them through Drizzle migration sets
-- (@platform/database's platform set, then each domain's history; advisory-locked; DATABASE_RUN_MIGRATIONS=true in compose).
```

old (line 7): `-- Trigram GIN indexes for the identity user search (ILIKE '%q%'); see identity.schema.ts.`
new: `-- Trigram GIN indexes for the identity user search (ILIKE '%q%'); the platform migration set creates it too (IF NOT EXISTS).`

- [ ] **Step 6: Format and run the gates**

Run:
`bunx prettier --write README.md docs/DEVELOPMENT.md docs/DOCKER.md docs/RELEASING.md docs/CONFIGURATION.md docs/TESTING.md docs/PERFORMANCE.md apps/identity-service/README.md apps/billing-service/README.md apps/monolith/README.md domains/identity/README.md domains/billing/README.md docker-compose.yml && node scripts/check-env-example.mjs && bun run check`
Expected: PASS (`check-env-example` unchanged: no variable was added or removed).

Run: `grep -rn -e 'libs/database/src/migrations' -e 'libs/database/src/migrate.ts' -e 'SCHEMA_GLOBS' README.md docs apps domains libs .github docker-compose.yml .env.example | grep -v 'docs/superpowers/'`
Expected: no output.

- [ ] **Step 7 (optional, needs Docker, DELETES local data): check the README reset path end to end**

Run: `docker compose --profile '*' down -v && bun run docker:infra && bun run db:migrate && bun run db:migrate`
Expected: the first `db:migrate` ends with `Done: 3 applied, 3 total (platform, identity, billing)`, the second with
`Done: 0 applied, 3 total (platform, identity, billing)`.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/DEVELOPMENT.md docs/DOCKER.md docs/RELEASING.md docs/CONFIGURATION.md docs/TESTING.md \
  docs/PERFORMANCE.md apps/identity-service/README.md apps/billing-service/README.md apps/monolith/README.md \
  domains/identity/README.md domains/billing/README.md .env.example apps/identity-service/.env.example \
  apps/billing-service/.env.example docker-compose.yml docker/postgres/init/01-extensions.sql
git commit -F- <<'EOF'
docs(repo): document per-domain schemas, migration sets and the local reset

- DEVELOPMENT, DOCKER, RELEASING, CONFIGURATION and TESTING describe the platform
  set, per-domain histories, per-app migrate.ts and the new CI drift paths
- README: one docker compose down -v after moving to per-domain schemas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
