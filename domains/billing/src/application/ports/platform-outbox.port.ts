import type { OutboxRecord } from '@platform/outbox';

/**
 * The one way a platform-money row (`PLATFORM_TENANT_ID`, which no principal can write) enters
 * `billing.outbox`: the webhook's payout postings, inside `SystemContext`. Bound to
 * `BillingOutboxSystemRepository.insertAsPlatform` (the app_system pool) by `BillingCoreModule`
 * (`useExisting`).
 */
export abstract class PlatformOutboxPort {
  /**
   * Inserts the records with `ON CONFLICT DO NOTHING`; returns how many rows are new (the same ids
   * again return 0).
   * @throws OutboxError `OUTBOX_TENANT_MISMATCH` before any SQL when a record has another tenant
   */
  abstract insertAsPlatform(records: readonly OutboxRecord[]): Promise<number>;
}
