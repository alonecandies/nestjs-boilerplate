import { join } from 'node:path';
import type { CassandraMigrationSource } from '@app/cassandra';

/**
 * CQL migrations of the notifications context, for
 * `CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] })`.
 * The `.cql` files live next to this module; SWC `copyFiles` ships them to `dist`, and
 * `import.meta.dirname` resolves the folder in both `src` (dev/tests) and `dist` (prod).
 */
export const notificationsCassandraMigrations: CassandraMigrationSource = {
  dir: join(import.meta.dirname, 'migrations'),
};

/**
 * Lifetime of an inbox row in seconds (90 days). MUST equal `default_time_to_live` of
 * `001_create_notifications.cql` (asserted by the migrations spec): `markRead` writes its cell
 * with the row's remaining lifetime so it never outlives the row.
 */
export const NOTIFICATIONS_TTL_SEC = 7_776_000;
