/**
 * DI token of the ledger switches application code reads (`LedgerSettings`). Bound to the `ledger`
 * config namespace (`ledgerConfig.KEY`, infrastructure/ledger/ledger.config.ts) by the modules
 * that load it: `BillingCoreModule`, `BillingLedgerModule` and `BillingLedgerReanchorModule`.
 */
export const LEDGER_SETTINGS = Symbol('LEDGER_SETTINGS');

/** The ledger switches (ledger design §6.2), as the `ledger` namespace parses them. */
export interface LedgerSettings {
  /** `LEDGER_ENABLED`: the webhook writes `billing.ledger-posting.v1` rows; the ledger runs. */
  readonly enabled: boolean;
  /** `LEDGER_RECONCILE_LOOKBACK_HOURS`: the hourly reconciliation's window. */
  readonly reconcileLookbackHours: number;
  /** `LEDGER_VERIFY`: reconciliation runs R5 (dual proof against the trusted state). */
  readonly verify: boolean;
  /** `LEDGER_ALLOW_UNVERIFIED`: production may run an enabled ledger without R5. */
  readonly allowUnverified: boolean;
}
