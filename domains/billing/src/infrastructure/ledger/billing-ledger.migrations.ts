import { join } from 'node:path';
import type { ImmudbMigrationSource } from '@platform/immudb';

/** The ledger's immudb tables; apps pass it to `ImmudbModule.forRootAsync({ migrations })`. */
export const billingLedgerMigrations: ImmudbMigrationSource = {
  name: 'billing-ledger',
  dir: join(import.meta.dirname, 'migrations'),
};
