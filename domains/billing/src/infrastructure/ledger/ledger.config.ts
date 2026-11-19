import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zBool, zInt, zNodeEnv, zStr } from '@platform/config';
import { z } from 'zod';

/**
 * The ledger switches (ledger design §6.2). `LEDGER_NAMESPACE` is a code constant, never env:
 * changing it would re-key every entry. Production guard (outbox plan Task 17, D3): an enabled
 * ledger needs `LEDGER_VERIFY=true` and a pinned server signing key
 * (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY`, read here for its presence only: the immudb namespace owns
 * and validates it), unless `LEDGER_ALLOW_UNVERIFIED=true`. The namespace is loaded wherever the
 * ledger switch is read (the billing core, the ledger module), so such an app refuses to start.
 */
export const ledgerEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    // Off by default: webhooks still record receipts and payment transitions but write no
    // billing.ledger-posting.v1 row, the consumer and ImmudbModule are not registered and the
    // reconcile cron does nothing. Enabling it later backfills through one explicit-window
    // reconciliation (R4).
    LEDGER_ENABLED: zBool(false),
    // Window of the hourly reconciliation: [now - lookback, now - grace). 1 hour to 30 days.
    LEDGER_RECONCILE_LOOKBACK_HOURS: zInt(72, { min: 1, max: 720 }),
    // R5: verify postings against the trusted state held in Postgres (dual proof).
    LEDGER_VERIFY: zBool(false),
    // Production only: run an enabled ledger without R5 or without a pinned signing key.
    LEDGER_ALLOW_UNVERIFIED: zBool(false),
    IMMUDB_SERVER_SIGNING_PUBLIC_KEY: zStr(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production' || !env.LEDGER_ENABLED || env.LEDGER_ALLOW_UNVERIFIED) return;
    const missing = [
      ...(env.LEDGER_VERIFY ? [] : (['LEDGER_VERIFY'] as const)),
      ...(env.IMMUDB_SERVER_SIGNING_PUBLIC_KEY === undefined
        ? (['IMMUDB_SERVER_SIGNING_PUBLIC_KEY'] as const)
        : []),
    ];
    const [first] = missing;
    if (first === undefined) return;
    ctx.addIssue({
      code: 'custom',
      path: [first],
      message:
        'An enabled ledger is verified in production: set LEDGER_VERIFY=true and IMMUDB_SERVER_SIGNING_PUBLIC_KEY (the public key of immudb --signingKey), or LEDGER_ALLOW_UNVERIFIED=true to run it unverified',
    });
  })
  .transform((env) => ({
    enabled: env.LEDGER_ENABLED,
    reconcileLookbackHours: env.LEDGER_RECONCILE_LOOKBACK_HOURS,
    verify: env.LEDGER_VERIFY,
    allowUnverified: env.LEDGER_ALLOW_UNVERIFIED,
  }));

/** The immudb ledger: posting, reconciliation lookback, verification (owned by billing). */
export const ledgerConfig = defineConfigNamespace('ledger', ledgerEnvSchema);
export type LedgerConfig = ConfigType<typeof ledgerConfig>;
