import { globSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './src/migrator/migrations.constants.js';

/*
 * drizzle-kit config (`bun run db:generate | db:studio` in this package, or from the root).
 * One migration history for every Postgres-backed bounded context: tables from all domain
 * `*.schema.ts` files are diffed together into ./src/migrations (shipped to dist by SWC copyFiles).
 *
 * - Paths are resolved relative to THIS file, then made cwd-relative (what drizzle-kit expects),
 *   so the config works from any working directory. drizzle-kit loads configs as CJS via tsx:
 *   `import.meta.url` is polyfilled but `import.meta.dirname` is not.
 * - Globs that match nothing are dropped (a domain lib may not have tables yet); drizzle-kit
 *   itself aborts when a pattern matches no file.
 * - Reading process.env here is a documented exception to the "config only via @app/config" rule.
 */
const SCHEMA_GLOBS = ['../identity/src/**/*.schema.ts', '../billing/src/**/*.schema.ts'];

const here = fileURLToPath(new URL('.', import.meta.url));
const fromCwd = (path: string): string =>
  relative(process.cwd(), fileURLToPath(new URL(path, import.meta.url))) || '.';

const schemaFiles = globSync(SCHEMA_GLOBS, { cwd: here }).sort().map(fromCwd);
if (schemaFiles.length === 0) {
  console.warn(
    `[drizzle.config] no schema files match ${SCHEMA_GLOBS.join(', ')} — nothing to generate yet`,
  );
}

export default defineConfig({
  dialect: 'postgresql',
  // With no files at all, hand drizzle-kit the raw globs so `generate` fails with its own clear
  // "No schema files found" message; `migrate`/`studio`/`check` don't need a schema.
  schema: schemaFiles.length > 0 ? schemaFiles : SCHEMA_GLOBS.map(fromCwd),
  out: fromCwd('./src/migrations'),
  // MUST equal the runtime `drizzle({ casing })` in DatabaseModule.
  casing: 'snake_case',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app' },
  migrations: { schema: MIGRATIONS_SCHEMA, table: MIGRATIONS_TABLE },
  strict: true,
  verbose: true,
});
