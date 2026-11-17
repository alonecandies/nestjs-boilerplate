import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  getPrincipal,
  PermissionDeniedException,
  type Principal,
  PrincipalPermissions,
} from '@platform/common';
import { getOrCreateCounter } from '@platform/observability';
import {
  appliedRlsContextOf,
  assertRlsContextCurrent,
  RlsContextError,
  type RlsContextInput,
} from './rls-context.js';
import { transactionClientOf } from './transaction-client.js';

/**
 * The closed list of elevations without a permission to check (spec §9, B3 rulings):
 * `tenant-bootstrap` (the tenant was created in the same transaction), `verified-invitation` (a
 * verified invitation token), `membership-activity` (the member's own `last_active_at` touch).
 */
export const ELEVATION_REASONS = Object.freeze([
  'tenant-bootstrap',
  'verified-invitation',
  'membership-activity',
] as const);
export type ElevationReason = (typeof ELEVATION_REASONS)[number];

/** `PermissionDeniedException.code` of every refused elevation. */
export const ELEVATION_DENIED = 'ELEVATION_DENIED';
export const DB_RLS_ELEVATIONS_TOTAL = 'db_rls_elevations_total';

/** The only two statements elevation sends: constants, nothing interpolated. */
const ELEVATED_ON = "SET LOCAL app.elevated = 'on'";
const ELEVATED_OFF = "SET LOCAL app.elevated = 'off'";

type ElevationKind = 'permission' | 'justified';

/**
 * Elevation of one transaction, keyed by the context object BEGIN applied (its savepoints share
 * it; a RequiresNew transaction has its own): `permanent` after `elevate()` (on until COMMIT),
 * `justified` = the `justified()` calls still running.
 */
interface ElevationState {
  permanent: boolean;
  justified: number;
}
const states = new WeakMap<RlsContextInput, ElevationState>();
const stateOf = (context: RlsContextInput): ElevationState => {
  let state = states.get(context);
  if (state === undefined) {
    state = { permanent: false, justified: 0 };
    states.set(context, state);
  }
  return state;
};

const denied = (message: string): PermissionDeniedException =>
  new PermissionDeniedException(message, { code: ELEVATION_DENIED });

const isElevationReason = (value: unknown): value is ElevationReason =>
  (ELEVATION_REASONS as readonly unknown[]).includes(value);

/** The open runtime transaction of a principal with a tenant, whose applied context is current. */
interface OpenTransaction {
  readonly principal: Principal;
  readonly tenantId: string;
  readonly tx: unknown;
  readonly context: RlsContextInput;
}

function openTransaction(): OpenTransaction {
  const principal = getPrincipal();
  if (principal === undefined) {
    throw new RlsContextError('RLS_NO_PRINCIPAL', 'RLS elevation: no principal in CLS');
  }
  let host: TransactionHost | undefined;
  try {
    host = TransactionHost.getInstance();
  } catch {
    host = undefined; // ClsPluginTransactional not registered: no transaction can be open.
  }
  if (host === undefined || !host.isTransactionActive()) {
    throw new RlsContextError(
      'RLS_NO_TRANSACTION',
      'RLS elevation: needs an open runtime transaction (it lasts until COMMIT)',
    );
  }
  const tx: unknown = host.tx;
  const context = appliedRlsContextOf(tx);
  assertRlsContextCurrent(context);
  if (context === undefined) {
    // assertRlsContextCurrent already threw; this narrows the type.
    throw new RlsContextError('RLS_CONTEXT_STALE', 'RLS elevation: no applied context');
  }
  const { tenantId } = principal;
  if (tenantId === null) {
    throw denied('RLS elevation needs a tenant: it never reaches beyond the current tenant');
  }
  return { principal, tenantId, tx, context };
}

async function send(tx: unknown, statement: typeof ELEVATED_ON | typeof ELEVATED_OFF) {
  await transactionClientOf(tx).unsafe(statement).simple();
}

/**
 * Turns `app.elevated` on in the open runtime transaction (spec §8.1, B3-9): policies then let
 * the unit of work read or write other members' rows of the SAME tenant. Elevation never changes
 * `app.tenant_id`, so it never crosses tenants.
 *
 * - `elevate(permission)` checks in TypeScript that the principal holds `permission`
 *   (`PrincipalPermissions`, bound by `RbacModule.forRoot()`), then sends
 *   `SET LOCAL app.elevated = 'on'`: on until COMMIT. Citus propagates it to the worker
 *   connections the transaction already opened.
 * - `justified(reason, work)` is elevation without a permission, for a closed list of reasons;
 *   on for `work` only. Callable only from `*.elevated.ts` files (`scripts/check-boundaries.mjs`).
 *
 * Both need a principal with a tenant, an open transaction and a current context; every refusal
 * happens before anything is sent. Each elevation is logged and counted
 * (`db_rls_elevations_total{kind,name}`).
 */
@Injectable()
export class RlsElevation {
  private readonly logger = new Logger(RlsElevation.name);
  private readonly elevations = getOrCreateCounter({
    name: DB_RLS_ELEVATIONS_TOTAL,
    help: 'RLS elevations of runtime transactions, by kind (permission or justified) and name',
    labelNames: ['kind', 'name'] as const,
  });

  constructor(
    @Optional()
    @Inject(PrincipalPermissions)
    private readonly permissions?: PrincipalPermissions,
  ) {}

  /**
   * Asserts in TypeScript that the principal holds `permission`, then SET LOCAL app.elevated = 'on'
   * until COMMIT.
   * @throws PermissionDeniedException code ELEVATION_DENIED (not held, undeclared, no tenant)
   * @throws RlsContextError RLS_NO_PRINCIPAL | RLS_NO_TRANSACTION | RLS_CONTEXT_STALE
   * @throws Error when no `PrincipalPermissions` is bound (import `RbacModule.forRoot()`)
   */
  async elevate(permission: string): Promise<void> {
    if (typeof permission !== 'string' || permission.length === 0) {
      throw denied('RLS elevation needs a permission name');
    }
    const open = openTransaction();
    if (this.permissions === undefined) {
      throw new Error(
        'RLS elevation: PrincipalPermissions is not bound (import RbacModule.forRoot())',
      );
    }
    if (!this.permissions.of(open.principal).includes(permission)) {
      throw denied(`RLS elevation refused: the principal does not hold ${permission}`);
    }
    await send(open.tx, ELEVATED_ON);
    stateOf(open.context).permanent = true;
    this.record('permission', permission, open);
  }

  /**
   * Elevation without a permission, on for `work` only ('off' again in finally, unless an
   * `elevate()` of the same transaction keeps it on). Callable from `*.elevated.ts` only.
   * @throws PermissionDeniedException code ELEVATION_DENIED (a reason outside ELEVATION_REASONS,
   *   no tenant), RlsContextError as `elevate`; rethrows what `work` throws
   */
  async justified<T>(reason: ElevationReason, work: () => Promise<T>): Promise<T> {
    if (!isElevationReason(reason)) {
      throw denied('RLS elevation refused: not a justified elevation reason');
    }
    const open = openTransaction();
    const state = stateOf(open.context);
    if (!state.permanent && state.justified === 0) await send(open.tx, ELEVATED_ON);
    state.justified += 1;
    this.record('justified', reason, open);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      state.justified -= 1;
      // An aborted transaction refuses the 'off' too; it rolls back anyway. Keep work's error.
      if (!state.permanent && state.justified === 0) {
        await send(open.tx, ELEVATED_OFF).catch(() => undefined);
      }
      throw error;
    }
    state.justified -= 1;
    if (!state.permanent && state.justified === 0) await send(open.tx, ELEVATED_OFF);
    return result;
  }

  private record(
    kind: ElevationKind,
    name: string,
    { principal, tenantId }: OpenTransaction,
  ): void {
    this.elevations.inc({ kind, name });
    this.logger.log({ elevation: name, kind, userId: principal.userId, tenantId }, 'RLS elevation');
  }
}
