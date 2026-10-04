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
