import { Logger } from '@nestjs/common';
import {
  CLS_PRINCIPAL,
  isPrincipal,
  isTokenVerified,
  type Principal,
  pickDefined,
} from '@platform/common';
import type { ClsService } from 'nestjs-cls';
import {
  correlationIdFromCls,
  RPC_CLS_KEYS,
  requestIdFromCls,
} from '../context/transport-context.js';
import {
  assertedCallerOf,
  type IncomingRpcContext,
  type RpcCallerContext,
} from './grpc-metadata.js';
import { rpcCallerOf } from './grpc-principal.js';
import { principalAssertionSettings, signPrincipalAssertion } from './grpc-principal-assertion.js';

/**
 * Caller context for an outgoing gRPC call, built from the current nestjs-cls context:
 * - `requestId` = `cls.getId()`. At the edge this is the HTTP request id; inside a service it
 *   is the id adopted by `GrpcContextInterceptor`, so it follows service→service hops.
 * - `correlationId` = the chain's correlation id (see `correlationIdFromCls`).
 * - `userId`, `tenantId`, `roles`, `staff` and `principalAssertion` only for a CLS principal this
 *   process can vouch for (`isVouchable`); never from request headers. Any other principal (an
 *   event's actor, one set with `runWithPrincipal`) makes the call anonymous, in every
 *   `GRPC_PRINCIPAL_ASSERTION` mode, so what goes out in plain headers is exactly what could be
 *   signed.
 *
 * `overrides` can set the request and correlation ids. Its caller fields never widen what is
 * sent: a `userId` must name the vouched principal's user, or the call is anonymous;
 * `tenantId`, `roles`, `staff` and `principalAssertion` are ignored. Whenever a principal or an
 * override is dropped, a throttled warning says so, without naming the user.
 */
export function callerContextFromCls(
  cls: ClsService | undefined,
  overrides: RpcCallerContext = {},
): RpcCallerContext {
  const caller: RpcCallerContext = pickDefined({
    requestId: overrides.requestId ?? requestIdFromCls(cls),
    correlationId: overrides.correlationId ?? correlationIdFromCls(cls),
  });
  let principal: Principal | undefined;
  let incoming: IncomingRpcContext | undefined;
  let unvouched = false;
  if (cls?.isActive()) {
    const current = cls.get<unknown>(CLS_PRINCIPAL);
    incoming = cls.get<IncomingRpcContext | undefined>(RPC_CLS_KEYS.CALLER);
    if (isPrincipal(current)) {
      if (isVouchable(current, incoming)) principal = current;
      else unvouched = true;
    }
  }
  const userOverridden = overrides.userId !== undefined && overrides.userId !== principal?.userId;
  // One reason per call: a dropped principal explains an override that then had nothing to cover.
  if (unvouched) UNVOUCHED_PRINCIPAL.record();
  else if (userOverridden || IGNORED_OVERRIDES.some((key) => overrides[key] !== undefined)) {
    OVERRIDE_DROPPED.record();
  }
  if (userOverridden) principal = undefined;
  if (principal === undefined) return caller;
  // Computed once: the plain headers and the claims an edge signs are the same value.
  const claims = rpcCallerOf(principal);
  Object.assign(caller, claims);
  const assertion = principalAssertionFor(claims, incoming);
  if (assertion !== undefined) caller.principalAssertion = assertion;
  return caller;
}

/** Caller fields an override can never set: only a vouchable principal supplies them. */
const IGNORED_OVERRIDES = ['tenantId', 'roles', 'staff', 'principalAssertion'] as const;

/**
 * True when this process can vouch for the CLS `principal`:
 * - inside a gRPC call (`incoming` set): the principal of that call, i.e. one naming the incoming
 *   caller's user;
 * - at the edge: a principal this process's own access-token verification wrote
 *   (`isTokenVerified`).
 * Every other principal is not: the actor an event envelope names (`KafkaContextInterceptor`:
 * anyone who can produce to Kafka writes it) and a principal set with `runWithPrincipal`.
 */
function isVouchable(principal: Principal, incoming: IncomingRpcContext | undefined): boolean {
  return incoming === undefined ? isTokenVerified(principal) : incoming.userId === principal.userId;
}

/**
 * The signed assertion of a vouchable principal's `claims`, sent as `x-principal-assertion`:
 * - inside a gRPC call: the bytes the caller sent, unchanged. Such a process never signs: a
 *   principal adopted from metadata must not be laundered into a signature, even where a key is
 *   present;
 * - at the edge, with `GRPC_PRINCIPAL_SIGNING_KEY`: a new assertion of exactly the claims that
 *   travel in plain headers; without a key (an old gateway's setup), none.
 * The local `GRPC_PRINCIPAL_ASSERTION` mode plays no part: it only governs verification.
 */
function principalAssertionFor(
  claims: RpcCallerContext,
  incoming: IncomingRpcContext | undefined,
): string | undefined {
  if (incoming !== undefined) return incoming.principalAssertion;
  const signingKey = principalAssertionSettings().signingKey;
  const asserted = assertedCallerOf(claims);
  return signingKey === undefined || asserted === undefined
    ? undefined
    : signPrincipalAssertion(asserted, signingKey);
}

/** One warning line per minute at most for each reason, with the number held back. */
const CALLER_DROP_WARNING_INTERVAL_MS = 60_000;

/**
 * A warning that the caller was dropped from an outgoing call. It names neither the user nor the
 * principal: the reason is enough to find the code path, and a lost token-verified mark on an edge
 * that holds a signing key shows up here instead of only as `missing` downstream.
 */
class CallerDropWarning {
  private static readonly logger = new Logger('GrpcCallerContext');
  private lastAt: number | undefined;
  private suppressed = 0;

  constructor(private readonly message: string) {}

  record(): void {
    const now = Date.now();
    // A clock that went back opens a new window instead of muting the warning until it catches up.
    if (
      this.lastAt !== undefined &&
      now >= this.lastAt &&
      now - this.lastAt < CALLER_DROP_WARNING_INTERVAL_MS
    ) {
      this.suppressed += 1;
      return;
    }
    const held = this.suppressed;
    this.lastAt = now;
    this.suppressed = 0;
    CallerDropWarning.logger.warn(
      held === 0 ? this.message : `${this.message} (${held} more since the last one)`,
    );
  }
}

const UNVOUCHED_PRINCIPAL = new CallerDropWarning(
  'Outgoing gRPC call sent as anonymous: the CLS principal was neither verified from an access token by this process nor received on the gRPC call it serves',
);
const OVERRIDE_DROPPED = new CallerDropWarning(
  'Outgoing gRPC call ignored a caller override: an override cannot name another user or set the tenant, roles, staff flag or assertion',
);
