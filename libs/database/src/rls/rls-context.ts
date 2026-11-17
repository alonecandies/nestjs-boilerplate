import { TransactionHost } from '@nestjs-cls/transactional';
import { getPrincipal, isPlatformTenantId, type Principal } from '@platform/common';

/**
 * The RLS context of a runtime transaction (spec §8.1 as changed by the sharding design §7.1): on
 * BEGIN the transactional adapter sends `SET LOCAL app.user_id/app.tenant_id/app.elevated`, built
 * here from the CLS principal. `SET` takes no bound parameters, so this is the ONE place that
 * builds SQL from strings: only values that pass `RLS_UUID_PATTERN` ever reach it.
 */

/** A UUID, nothing before or after it. No `m`, `u` or `g` flag (`$` is the end of the input). */
export const RLS_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RlsContextInput {
  readonly userId: string;
  readonly tenantId: string | null;
}

export type RlsErrorCode =
  | 'RLS_INVALID_USER_ID'
  | 'RLS_INVALID_TENANT_ID'
  | 'RLS_PLATFORM_TENANT'
  | 'RLS_NO_PRINCIPAL'
  | 'RLS_CONTEXT_STALE'
  | 'RLS_NO_TRANSACTION';

/** Thrown before any SQL is sent. The message never echoes the refused value. */
export class RlsContextError extends Error {
  override readonly name = 'RlsContextError';

  constructor(
    readonly code: RlsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isRlsUuid = (value: unknown): value is string =>
  typeof value === 'string' && RLS_UUID_PATTERN.test(value);

/**
 * Exactly `SET LOCAL app.user_id = '<uuid>'; SET LOCAL app.tenant_id = '<uuid|>'; SET LOCAL
 * app.elevated = 'off'`, lower-cased. `tenantId: null` yields `''` (a user-scoped unit of work);
 * the platform tenant (the nil UUID) is refused as the tenant and as the user.
 * @throws RlsContextError RLS_INVALID_USER_ID | RLS_INVALID_TENANT_ID | RLS_PLATFORM_TENANT
 */
export function buildRlsContextSql(input: RlsContextInput): string {
  const { userId, tenantId } = (input ?? {}) as Partial<Record<keyof RlsContextInput, unknown>>;
  if (!isRlsUuid(userId) || isPlatformTenantId(userId)) {
    throw new RlsContextError('RLS_INVALID_USER_ID', 'RLS context: userId is not a user UUID');
  }
  if (tenantId !== null && !isRlsUuid(tenantId)) {
    throw new RlsContextError('RLS_INVALID_TENANT_ID', 'RLS context: tenantId is not a UUID');
  }
  if (isPlatformTenantId(tenantId)) {
    throw new RlsContextError(
      'RLS_PLATFORM_TENANT',
      'RLS context: the platform tenant is never a runtime tenant',
    );
  }
  const tenant = tenantId === null ? '' : tenantId.toLowerCase();
  return (
    `SET LOCAL app.user_id = '${userId.toLowerCase()}'; ` +
    `SET LOCAL app.tenant_id = '${tenant}'; ` +
    `SET LOCAL app.elevated = 'off'`
  );
}

/** The context a principal's unit of work runs under. Without a principal the adapter refuses. */
export function rlsContextOf(principal: Principal): RlsContextInput {
  return { userId: principal.userId, tenantId: principal.tenantId };
}

// ── what BEGIN sent (package-internal: the adapter records, the unit of work compares) ──────────

/**
 * Keyed by the drizzle transaction (and each savepoint) object, not by a CLS value: a CLS value is
 * inherited into `Propagation.NotSupported` children, which run outside the transaction.
 */
const applied = new WeakMap<object, RlsContextInput>();

/** @internal Records what BEGIN sent for `tx` (lower-cased, as sent). */
export function recordAppliedRlsContext(tx: object, context: RlsContextInput): void {
  applied.set(tx, context);
}

/** @internal What BEGIN sent for the transaction `tx` belongs to. */
export function appliedRlsContextOf(tx: unknown): RlsContextInput | undefined {
  return typeof tx === 'object' && tx !== null ? applied.get(tx) : undefined;
}

/** What BEGIN sent for the active transaction; undefined outside one (or before the host exists). */
export function getAppliedRlsContext(): RlsContextInput | undefined {
  let host: TransactionHost;
  try {
    host = TransactionHost.getInstance();
  } catch {
    return undefined; // ClsPluginTransactional not registered (yet): no transaction can be open.
  }
  return host.isTransactionActive() ? appliedRlsContextOf(host.tx) : undefined;
}

const normalized = (context: RlsContextInput): RlsContextInput => ({
  userId: context.userId.toLowerCase(),
  tenantId: context.tenantId === null ? null : context.tenantId.toLowerCase(),
});

/**
 * @internal Throws RLS_CONTEXT_STALE unless the CLS principal is the one `applied` was built from
 * (no principal, or no applied context, is stale too).
 */
export function assertRlsContextCurrent(context: RlsContextInput | undefined): void {
  const principal = getPrincipal();
  if (context === undefined || principal === undefined) {
    throw new RlsContextError(
      'RLS_CONTEXT_STALE',
      context === undefined
        ? 'RLS context: the transaction has no applied context'
        : 'RLS context: the principal was cleared inside the transaction',
    );
  }
  const current = normalized(rlsContextOf(principal));
  const sent = normalized(context);
  if (current.userId !== sent.userId || current.tenantId !== sent.tenantId) {
    throw new RlsContextError(
      'RLS_CONTEXT_STALE',
      'RLS context: the principal changed after BEGIN (one principal per transaction)',
    );
  }
}
