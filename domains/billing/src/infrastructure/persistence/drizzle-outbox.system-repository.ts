import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import { OutboxSystemRepository } from '@platform/outbox';
import type { BillingSchema } from './billing.schema.js';
import { BILLING_OUTBOX } from './billing-outbox.js';

/**
 * `billing.outbox` on the app_system pool: the relay's poll, mark and purge, and
 * `insertAsPlatform`, the only way a `PLATFORM_TENANT_ID` row enters the table (G-1). The shared
 * `OutboxSystemRepository`: one pinned `outbox.*` system method per call
 * (`BILLING_SYSTEM_METHODS.outbox`), inside `SystemContext`.
 */
@Injectable()
export class BillingOutboxSystemRepository extends OutboxSystemRepository {
  constructor(@InjectSystemDatabase() system: SystemDatabase<BillingSchema>) {
    super(BILLING_OUTBOX, system);
  }
}
