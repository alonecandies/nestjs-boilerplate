import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImmudbClient } from '@platform/immudb';
import { PostLedgerEntryHandler } from '../../application/commands/post-ledger-entry/post-ledger-entry.handler.js';
import { ProcessLedgerPostingHandler } from '../../application/commands/process-ledger-posting/process-ledger-posting.handler.js';
import { LedgerService } from '../../application/ledger/ledger.service.js';
import { LedgerPort } from '../../application/ports/ledger.port.js';
import { LedgerSystemRepository } from '../../application/repositories/ledger.system-repository.js';
import { LedgerReceiptsRepository } from '../../application/repositories/ledger-receipts.repository.js';
import { DrizzleLedgerSystemRepository } from '../persistence/drizzle-ledger.system-repository.js';
import { DrizzleLedgerReceiptsRepository } from '../persistence/drizzle-ledger-receipts.repository.js';
import { StripeModule } from '../stripe/stripe.module.js';
import { DisabledLedger } from './disabled-ledger.js';
import { ImmudbLedgerAdapter } from './immudb-ledger.adapter.js';
import { type LedgerConfig, ledgerConfig } from './ledger.config.js';

/**
 * `LedgerPort` for this process: `ImmudbLedgerAdapter` over the global `ImmudbModule`'s client
 * while `LEDGER_ENABLED=true` (the app imports `ImmudbModule.forRootAsync(...)` then, outbox plan
 * Task 14; boot fails naming it when it is missing), otherwise `DisabledLedger` (every call
 * `LEDGER_DISABLED`, and no immudb client is needed).
 */
export function createLedgerPort(cfg: LedgerConfig, immudb: ImmudbClient | undefined): LedgerPort {
  if (!cfg.enabled) return new DisabledLedger();
  if (immudb === undefined) {
    throw new Error(
      'LEDGER_ENABLED=true needs ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }) in the app',
    );
  }
  return new ImmudbLedgerAdapter(immudb);
}

/**
 * Billing's ledger (L-12): `LedgerPort` (above), `LedgerService` (the ledger tenant rule, the only
 * caller of `post`/`getEntry`/`balances`), the posting commands `PostLedgerEntryCommand` and
 * `ProcessLedgerPostingCommand`, and the ledger repositories they write receipts with. Self-
 * contained over the apps' global modules (`DatabaseModule` for the runtime and system pools,
 * `CqrsModule.forRoot()`, nestjs-cls) and its own Stripe adapter; imported by
 * `BillingMessagingModule`. Exports `LedgerPort` and `LedgerService`.
 */
@Module({
  imports: [ConfigModule.forFeature(ledgerConfig), StripeModule.forRootAsync()],
  providers: [
    {
      provide: LedgerPort,
      inject: [ledgerConfig.KEY, { token: ImmudbClient, optional: true }],
      useFactory: createLedgerPort,
    },
    LedgerService,
    PostLedgerEntryHandler,
    ProcessLedgerPostingHandler,
    { provide: LedgerReceiptsRepository, useClass: DrizzleLedgerReceiptsRepository },
    { provide: LedgerSystemRepository, useClass: DrizzleLedgerSystemRepository },
  ],
  exports: [LedgerPort, LedgerService],
})
export class BillingLedgerModule {}
