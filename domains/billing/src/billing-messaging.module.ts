import { Module } from '@nestjs/common';
import { BillingLedgerModule } from './infrastructure/ledger/billing-ledger.module.js';
import { LedgerPostingConsumer } from './presentation/messaging/ledger-posting.consumer.js';

/**
 * Billing's inbound Kafka events: `billing.ledger-posting.v1` → ledger entries
 * (`LedgerPostingConsumer`, L-12). Imported by the app that owns the billing tables only while
 * `LEDGER_ENABLED=true`, next to `ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] })`
 * (outbox plan Task 14); the app connects the consumer with `connectKafkaConsumer(app, { groupId })`,
 * and the topic and its `.dlq` must exist. Expects the apps' global modules of `BillingCoreModule`
 * (database pools, CQRS, nestjs-cls).
 */
@Module({
  imports: [BillingLedgerModule],
  controllers: [LedgerPostingConsumer],
})
export class BillingMessagingModule {}
