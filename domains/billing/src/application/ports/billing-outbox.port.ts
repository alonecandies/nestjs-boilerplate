import type { EventContract, EventEnvelope } from '@platform/contracts';
import type { OutboxRecord } from '@platform/outbox';
import type { KafkaPublishOptions } from '@platform/transport';

/**
 * Billing's outbox writer as application code sees it: one integration event row in the caller's
 * open unit of work (`enqueue`), or the validated row without SQL (`record`, for a system
 * repository to insert). Bound to `BillingOutbox` (`@platform/outbox`'s `OutboxWriter` over
 * `billing.outbox`) by `BillingCoreModule` and `BillingLedgerModule` (`useExisting`, so a test
 * that overrides `BillingOutbox` overrides this port too).
 */
export abstract class BillingOutboxPort {
  /**
   * The validated row of one event (envelope id, topic, key, tenant): no SQL.
   * @throws InvalidEventException when the contract rejects the payload
   */
  abstract record<T>(
    contract: EventContract<T>,
    payload: NoInfer<T>,
    options?: KafkaPublishOptions,
  ): OutboxRecord;

  /**
   * `record()` plus its INSERT in the caller's OPEN transaction, under the principal's tenant;
   * returns the envelope.
   * @throws OutboxError `OUTBOX_NO_TRANSACTION` outside a transaction
   */
  abstract enqueue<T>(
    contract: EventContract<T>,
    payload: NoInfer<T>,
    options?: KafkaPublishOptions,
  ): Promise<EventEnvelope<T>>;
}
