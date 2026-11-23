import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ReanchorLedgerHandler,
  RerunLedgerReconciliationHandler,
} from '../../application/commands/reanchor-ledger/reanchor-ledger.handler.js';
import { LedgerSystemRepository } from '../../application/repositories/ledger.system-repository.js';
import { DrizzleLedgerSystemRepository } from '../persistence/drizzle-ledger.system-repository.js';
import { BillingLedgerModule } from './billing-ledger.module.js';
import { ledgerConfig, ledgerSettingsProvider } from './ledger.config.js';

/**
 * The audited re-anchor (audit fixes OPS-1): `ReanchorLedgerHandler` (and its `--reconcile-only`
 * re-run, `RerunLedgerReconciliationHandler`) over `BillingLedgerModule`
 * (its `LedgerPort` and `ReconcileLedgerCommand`) and its own `LedgerSystemRepository`. Imported
 * ONLY by the ledger-reanchor CLI's root module (`runLedgerReanchorCli`): no running app can
 * dispatch `ReanchorLedgerCommand`, so nothing but the CLI reaches `ledgerTrustedState.reanchor`
 * (pinned by reanchor-ledger.handler.spec.ts). Not exported from the package.
 */
@Module({
  imports: [ConfigModule.forFeature(ledgerConfig), BillingLedgerModule],
  providers: [
    ReanchorLedgerHandler,
    RerunLedgerReconciliationHandler,
    ledgerSettingsProvider,
    { provide: LedgerSystemRepository, useClass: DrizzleLedgerSystemRepository },
  ],
})
export class BillingLedgerReanchorModule {}
