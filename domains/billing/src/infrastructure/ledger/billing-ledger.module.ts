import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { type DrizzleTransactionHost, TransactionHost } from '@platform/database';
import { ImmudbClient } from '@platform/immudb';
import { KafkaProducer } from '@platform/transport';
import { PostLedgerEntryHandler } from '../../application/commands/post-ledger-entry/post-ledger-entry.handler.js';
import { ProcessLedgerPostingHandler } from '../../application/commands/process-ledger-posting/process-ledger-posting.handler.js';
import { R1InvariantCheck } from '../../application/commands/reconcile-ledger/checks/r1-invariant.js';
import { R2MutationCheck } from '../../application/commands/reconcile-ledger/checks/r2-mutation.js';
import { R3PaymentsCheck } from '../../application/commands/reconcile-ledger/checks/r3-payments.js';
import { R4StripeCheck } from '../../application/commands/reconcile-ledger/checks/r4-stripe.js';
import { R5VerificationCheck } from '../../application/commands/reconcile-ledger/checks/r5-verification.js';
import { ReconcileLedgerHandler } from '../../application/commands/reconcile-ledger/reconcile-ledger.handler.js';
import { LedgerService } from '../../application/ledger/ledger.service.js';
import { StripeOwnerResolver } from '../../application/ledger/stripe-owner-resolver.js';
import { LedgerPort } from '../../application/ports/ledger.port.js';
import { LedgerSystemRepository } from '../../application/repositories/ledger.system-repository.js';
import { LedgerReceiptsRepository } from '../../application/repositories/ledger-receipts.repository.js';
import { BILLING_OUTBOX, BillingOutbox } from '../persistence/billing-outbox.js';
import { DrizzleLedgerSystemRepository } from '../persistence/drizzle-ledger.system-repository.js';
import { DrizzleLedgerReceiptsRepository } from '../persistence/drizzle-ledger-receipts.repository.js';
import { ReconcileLedgerCron } from '../scheduling/reconcile-ledger.cron.js';
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
 * Billing's ledger (L-12, L-13): `LedgerPort` (above), `LedgerService` (the ledger tenant rule, the
 * only caller of `post`/`getEntry`/`balances` outside reconciliation), the posting commands
 * `PostLedgerEntryCommand` and `ProcessLedgerPostingCommand`, the ledger repositories they write
 * receipts with, and the reconciliation: `ReconcileLedgerCommand`, its checks (R1-R4, which read
 * `LedgerPort` across tenants inside `SystemContext`; R4 also lists Stripe's balance transactions
 * and re-enqueues missing postings into `billing.outbox`; R5, while `LEDGER_VERIFY=true`, advances
 * the trusted state by dual proof and verifies the new entries) and the hourly `ReconcileLedgerCron` (needs
 * `ScheduleModule.forRoot()` and `RedisModule` for its lock in the app; it does nothing while
 * `LEDGER_ENABLED=false`). Self-contained over the apps' global modules (`DatabaseModule` for the
 * runtime and system pools, `CqrsModule.forRoot()`, nestjs-cls, `KafkaProducerModule` for R4's
 * envelopes) and the Stripe adapter (`StripeModule.forRootAsync()`: the same module, so the same
 * client, as `BillingCoreModule`'s);
 * imported by `BillingMessagingModule`, which the apps load only while the ledger is enabled.
 * Exports `LedgerPort` and `LedgerService`.
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
    R1InvariantCheck,
    R2MutationCheck,
    R3PaymentsCheck,
    R4StripeCheck,
    R5VerificationCheck,
    // R4 resolves the owner of a missing transaction and builds its outbox record (`record()`,
    // no SQL: the system repository inserts it). This module's own writer instance: importing
    // OutboxModule.forFeature again would start a second relay of billing.outbox.
    StripeOwnerResolver,
    {
      provide: BillingOutbox,
      inject: [TransactionHost, KafkaProducer],
      useFactory: (txHost: DrizzleTransactionHost, kafka: KafkaProducer) =>
        new BillingOutbox(BILLING_OUTBOX, txHost, kafka),
    },
    ReconcileLedgerHandler,
    ReconcileLedgerCron,
    { provide: LedgerReceiptsRepository, useClass: DrizzleLedgerReceiptsRepository },
    { provide: LedgerSystemRepository, useClass: DrizzleLedgerSystemRepository },
  ],
  exports: [LedgerPort, LedgerService],
})
export class BillingLedgerModule {}
