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
