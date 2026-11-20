import 'reflect-metadata';
import { billingLedgerMigrations, ledgerConfig } from '@domain/billing';
import { runMigrationsCli } from '@platform/database';
import { runImmudbMigrationsCli } from '@platform/immudb';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/*
 * One-off migration job: `node dist/migrate.js` in this app's image (docker compose `run`, a k8s
 * Job / initContainer) or `bun run --filter @app/billing-service db:migrate[:dev]`. Applies the
 * platform set, then DATABASE_MIGRATIONS, and sets the exit code (0 = schema current).
 * With `LEDGER_ENABLED=true` it then provisions the immudb database and its INSERT/SELECT-only user
 * and applies billing's ledger migrations (needs `IMMUDB_ADMIN_PASSWORD`); skipped when Postgres
 * failed. A failure there rejects, which exits non-zero.
 * `reflect-metadata` first: the domain package that exports the set declares decorated classes.
 */
await runMigrationsCli(DATABASE_MIGRATIONS);
if ((process.exitCode ?? 0) === 0 && ledgerConfig.parse().enabled) {
  await runImmudbMigrationsCli([billingLedgerMigrations]);
}
