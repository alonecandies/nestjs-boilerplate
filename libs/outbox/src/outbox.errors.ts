export type OutboxErrorCode =
  | 'OUTBOX_NO_TRANSACTION'
  | 'OUTBOX_TENANT_REQUIRED'
  | 'OUTBOX_TENANT_MISMATCH'
  | 'OUTBOX_PLATFORM_TENANT';

/**
 * A misuse of the outbox writer: a programming error, never a client error (it renders as a 500).
 * - `OUTBOX_NO_TRANSACTION`: `enqueue` outside an open transaction (a row on its own would commit
 *   apart from the state change it reports).
 * - `OUTBOX_TENANT_REQUIRED`: no tenant for the record (no principal, or one without a tenant).
 * - `OUTBOX_TENANT_MISMATCH`: `options.tenantId` is not the principal's tenant.
 * - `OUTBOX_PLATFORM_TENANT`: the runtime writer was asked for a platform-tenant row (only the
 *   system repository writes those).
 */
export class OutboxError extends Error {
  override readonly name = 'OutboxError';

  constructor(
    readonly code: OutboxErrorCode,
    message: string,
  ) {
    super(message);
  }
}
