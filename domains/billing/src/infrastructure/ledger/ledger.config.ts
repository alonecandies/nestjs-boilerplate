import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zBool, zInt } from '@platform/config';
import { z } from 'zod';

/**
 * The ledger switches (ledger design §6.2). `LEDGER_NAMESPACE` is a code constant, never env:
 * changing it would re-key every entry.
 */
export const ledgerEnvSchema = z
  .object({
    // Off by default: webhooks still record receipts and payment transitions but write no
    // billing.ledger-posting.v1 row, the consumer and ImmudbModule are not registered and the
    // reconcile cron does nothing. Enabling it later backfills through one explicit-window
    // reconciliation (R4).
    LEDGER_ENABLED: zBool(false),
    // Window of the hourly reconciliation: [now - lookback, now - grace). 1 hour to 30 days.
    LEDGER_RECONCILE_LOOKBACK_HOURS: zInt(72, { min: 1, max: 720 }),
    // R5: verify postings against the trusted state held in Postgres (dual proof).
    LEDGER_VERIFY: zBool(false),
  })
  .transform((env) => ({
    enabled: env.LEDGER_ENABLED,
    reconcileLookbackHours: env.LEDGER_RECONCILE_LOOKBACK_HOURS,
    verify: env.LEDGER_VERIFY,
  }));

/** The immudb ledger: posting, reconciliation lookback, verification (owned by billing). */
export const ledgerConfig = defineConfigNamespace('ledger', ledgerEnvSchema);
export type LedgerConfig = ConfigType<typeof ledgerConfig>;
