import 'reflect-metadata';
import { runMigrationsCli } from '../../src/migrator/migrate-cli.js';
import { gadgetsMigrations, widgetsMigrations } from './fixture-sets.js';

/* An app-style `migrate.ts` over the fixture sets; database.int-spec.ts spawns it. */
await runMigrationsCli([widgetsMigrations, gadgetsMigrations]);
