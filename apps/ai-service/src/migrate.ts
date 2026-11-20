import 'reflect-metadata';
import { runMigrationsCli } from '@platform/database';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

/*
 * One-off migration job: `node dist/migrate.js` in this app's image (docker compose `run`, a k8s
 * Job / initContainer) or `bun run --filter @app/ai-service db:migrate[:dev]`. Applies the platform
 * set, then DATABASE_MIGRATIONS, and sets the exit code (0 = schema current).
 * `reflect-metadata` first: the domain package that exports the set declares decorated classes.
 */
await runMigrationsCli(DATABASE_MIGRATIONS);
