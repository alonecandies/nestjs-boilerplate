import { CLS_PRINCIPAL, isPrincipal, pickDefined } from '@platform/common';
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
 * - `userId`, `tenantId`, `roles`, `staff` come from the CLS principal; never from request headers.
 * - an override with another `userId` drops the principal's tenant, roles and staff flag.
 * - `principalAssertion` (see `principalAssertionFor`).
 * `overrides` wins. The gateway uses it to pass the authenticated `req.user`.
 */
export function callerContextFromCls(
  cls: ClsService | undefined,
  overrides: RpcCallerContext = {},
): RpcCallerContext {
  const context: RpcCallerContext = pickDefined({
    requestId: requestIdFromCls(cls),
    correlationId: correlationIdFromCls(cls),
  });
  let principalUserId: string | undefined;
  let incoming: IncomingRpcContext | undefined;
  if (cls?.isActive()) {
    // The principal written at the edge (JwtAuthGuard) or adopted from metadata (GrpcContextInterceptor)
    // travels on every hop: user, tenant, roles and staff (spec §7). An override naming ANOTHER user
    // gets none of them: a tenant and roles are only ever asserted for the user they belong to.
    const principal = cls.get<unknown>(CLS_PRINCIPAL);
    if (
      isPrincipal(principal) &&
      (overrides.userId === undefined || overrides.userId === principal.userId)
    ) {
      Object.assign(context, rpcCallerOf(principal));
      principalUserId = principal.userId;
    }
    incoming = cls.get<IncomingRpcContext | undefined>(RPC_CLS_KEYS.CALLER);
  }
  const caller: RpcCallerContext = { ...context, ...pickDefined(overrides) };
  if (caller.principalAssertion === undefined && principalUserId !== undefined) {
    const assertion = principalAssertionFor(caller, principalUserId, incoming);
    if (assertion !== undefined) caller.principalAssertion = assertion;
  }
  return caller;
}

/**
 * The signed assertion for the CLS principal `principalUserId`, sent as `x-principal-assertion`:
 * - inside a gRPC call (`incoming` set): the bytes the caller sent, unchanged, when they are for
 *   the same user. Such a process never signs: a principal adopted from metadata must not be
 *   laundered into a signature, even where a key is present;
 * - at the edge, with `GRPC_PRINCIPAL_SIGNING_KEY`: a new assertion of exactly what the plain
 *   headers will carry (`assertedCallerOf`), so the two match;
 * - otherwise (an edge without a key, an anonymous call, an override naming another user): none.
 * The local `GRPC_PRINCIPAL_ASSERTION` mode plays no part: it only governs verification.
 */
function principalAssertionFor(
  caller: RpcCallerContext,
  principalUserId: string,
  incoming: IncomingRpcContext | undefined,
): string | undefined {
  if (caller.userId !== principalUserId) return undefined;
  if (incoming !== undefined) {
    return incoming.userId === principalUserId ? incoming.principalAssertion : undefined;
  }
  const signingKey = principalAssertionSettings().signingKey;
  const asserted = assertedCallerOf(caller);
  return signingKey === undefined || asserted === undefined
    ? undefined
    : signPrincipalAssertion(asserted, signingKey);
}
