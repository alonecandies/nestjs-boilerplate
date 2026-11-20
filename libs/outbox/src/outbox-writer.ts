import { getPrincipal, isPlatformTenantId } from '@platform/common';
import type { EventContract, EventEnvelope } from '@platform/contracts';
import { type DrizzleTransactionHost, inUnitOfWork } from '@platform/database';
import {
  correlationIdFromCls,
  type KafkaProducer,
  type KafkaPublishOptions,
} from '@platform/transport';
import { ClsServiceManager } from 'nestjs-cls';
import { OutboxError } from './outbox.errors.js';
import type { OutboxFeature, OutboxRecord } from './outbox.types.js';

/**
 * Writes integration events to an outbox table in the transaction that changes the state they
 * report, so both commit or roll back together; the outbox relay publishes the rows afterwards.
 * Each domain subclasses it once (`class OrdersOutbox extends OutboxWriter {}`): the subclass is
 * the DI token, bound to that domain's `OutboxFeature`.
 *
 * Envelopes are built by `KafkaProducer.createRecord`, so a stored envelope is exactly what a
 * direct publish would have sent: uuidv7 id, `type` = topic, validated payload, and the tenant,
 * actor and correlation id defaulting from the CLS principal and request.
 */
export abstract class OutboxWriter {
  constructor(
    protected readonly feature: OutboxFeature,
    protected readonly txHost: DrizzleTransactionHost,
    protected readonly kafka: KafkaProducer,
  ) {}

  /**
   * A validated record, no SQL: it works with no transaction and no principal when
   * `options.tenantId` is given (the platform tenant included: the system repository writes
   * those). `tenantId`, `actorId` and `correlationId` default as `KafkaProducer.createRecord`.
   * @throws OutboxError `OUTBOX_TENANT_REQUIRED` when no tenant resolves (checked first)
   * @throws InvalidEventException when the contract rejects the payload
   */
  record<T>(
    contract: EventContract<T>,
    payload: NoInfer<T>,
    options: KafkaPublishOptions = {},
  ): OutboxRecord {
    return this.build(contract, payload, options).record;
  }

  /**
   * `record()` plus one plain INSERT (no RETURNING, no ON CONFLICT: the runtime role cannot read
   * the table, and a duplicate id fails the business transaction) in the caller's OPEN
   * transaction; it never opens one. The row's tenant is the principal's. Returns the envelope.
   * @throws OutboxError `OUTBOX_NO_TRANSACTION` outside a transaction (before anything else),
   *   `OUTBOX_PLATFORM_TENANT` for `options.tenantId` = the nil tenant, `OUTBOX_TENANT_REQUIRED`
   *   for a principal without a tenant, `OUTBOX_TENANT_MISMATCH` for another `options.tenantId`
   * @throws InvalidEventException when the contract rejects the payload (no SQL is sent)
   */
  async enqueue<T>(
    contract: EventContract<T>,
    payload: NoInfer<T>,
    options: KafkaPublishOptions = {},
  ): Promise<EventEnvelope<T>> {
    if (!this.inTransaction()) {
      throw new OutboxError(
        'OUTBOX_NO_TRANSACTION',
        `${this.feature.name} outbox: enqueue needs the open transaction of the state change`,
      );
    }
    const tenantId = this.principalTenant(options.tenantId);
    const { record, envelope } = this.build(contract, payload, { ...options, tenantId });
    await this.insert(record);
    return envelope;
  }

  /** Whether the caller's transaction is open. */
  protected inTransaction(): boolean {
    return this.txHost.isTransactionActive();
  }

  /** Stores one record in the open transaction (the in-memory fake overrides it). */
  protected async insert(record: OutboxRecord): Promise<void> {
    await inUnitOfWork(this.txHost, async (tx) => {
      await tx.insert(this.feature.table).values({
        tenantId: record.tenantId,
        id: record.id,
        topic: record.topic,
        key: record.key,
        envelope: record.envelope,
      });
    });
  }

  /** The tenant of a runtime row: the principal's, which `requested` may only repeat. */
  private principalTenant(requested: string | undefined): string {
    if (requested !== undefined && isPlatformTenantId(requested)) {
      throw new OutboxError(
        'OUTBOX_PLATFORM_TENANT',
        `${this.feature.name} outbox: platform-tenant rows are written by the system repository only`,
      );
    }
    const tenantId = getPrincipal()?.tenantId ?? null;
    if (tenantId === null) {
      throw new OutboxError(
        'OUTBOX_TENANT_REQUIRED',
        `${this.feature.name} outbox: enqueue needs a principal with a tenant`,
      );
    }
    if (requested !== undefined && requested.toLowerCase() !== tenantId.toLowerCase()) {
      throw new OutboxError(
        'OUTBOX_TENANT_MISMATCH',
        `${this.feature.name} outbox: options.tenantId is not the principal's tenant`,
      );
    }
    return tenantId;
  }

  private build<T>(
    contract: EventContract<T>,
    payload: NoInfer<T>,
    options: KafkaPublishOptions,
  ): { record: OutboxRecord; envelope: EventEnvelope<T> } {
    const principal = getPrincipal();
    const tenantId = options.tenantId ?? principal?.tenantId ?? undefined;
    if (tenantId === undefined) {
      throw new OutboxError(
        'OUTBOX_TENANT_REQUIRED',
        `${this.feature.name} outbox: a record needs a tenant (options.tenantId or the principal's)`,
      );
    }
    // The defaults are resolved here, from the process-wide CLS, so a producer built without a
    // ClsService (a test double) still yields what the injected one would.
    const { key, value } = this.kafka.createRecord(contract, payload, {
      ...options,
      tenantId,
      actorId: 'actorId' in options ? options.actorId : principal?.userId,
      correlationId:
        options.correlationId ?? correlationIdFromCls(ClsServiceManager.getClsService()),
    });
    return {
      record: { tenantId, id: value.id, topic: contract.topic, key, envelope: value },
      envelope: value,
    };
  }
}
