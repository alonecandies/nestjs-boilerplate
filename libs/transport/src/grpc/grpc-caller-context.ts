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
  let principal: Principal | undefined;
  let incoming: IncomingRpcContext | undefined;
  if (cls?.isActive()) {
    // The principal written at the edge (JwtAuthGuard) or adopted from metadata (GrpcContextInterceptor)
    // travels on every hop: user, tenant, roles and staff (spec §7). An override naming ANOTHER user
    // gets none of them: a tenant and roles are only ever asserted for the user they belong to.
    const current = cls.get<unknown>(CLS_PRINCIPAL);
    if (
      isPrincipal(current) &&
      (overrides.userId === undefined || overrides.userId === current.userId)
    ) {
      Object.assign(context, rpcCallerOf(current));
      principal = current;
    }
    incoming = cls.get<IncomingRpcContext | undefined>(RPC_CLS_KEYS.CALLER);
  }
  const caller: RpcCallerContext = { ...context, ...pickDefined(overrides) };
  if (caller.principalAssertion === undefined && principal !== undefined) {
    const assertion = principalAssertionFor(caller, principal, incoming);
    if (assertion !== undefined) caller.principalAssertion = assertion;
  }
  return caller;
}

/**
 * The signed assertion for the CLS `principal`, sent as `x-principal-assertion`:
 * - inside a gRPC call (`incoming` set): the bytes the caller sent, unchanged, when they are for
 *   the same user. Such a process never signs: a principal adopted from metadata must not be
 *   laundered into a signature, even where a key is present;
 * - at the edge, with `GRPC_PRINCIPAL_SIGNING_KEY`, for the principal its own access-token
 *   verification wrote (`isTokenVerified`): a new assertion of that principal's claims
 *   (`rpcCallerOf`). They equal the plain headers, unless an override changed the tenant, roles or
 *   staff flag: a verifier then finds a `mismatch`, so an override never widens what is vouched for;
 * - otherwise none: an edge without a key, an anonymous call, an override naming another user, and
 *   every principal the edge did not verify from a token. That is the actor an event envelope names
 *   (`KafkaContextInterceptor`: anyone who can produce to Kafka writes it) and a principal set with
 *   `runWithPrincipal`; a consumer's call with it carries the plain headers only.
 * The local `GRPC_PRINCIPAL_ASSERTION` mode plays no part: it only governs verification.
 */
function principalAssertionFor(
  caller: RpcCallerContext,
  principal: Principal,
  incoming: IncomingRpcContext | undefined,
): string | undefined {
  if (caller.userId !== principal.userId) return undefined;
  if (incoming !== undefined) {
    return incoming.userId === principal.userId ? incoming.principalAssertion : undefined;
  }
  if (!isTokenVerified(principal)) return undefined;
  const signingKey = principalAssertionSettings().signingKey;
  const asserted = assertedCallerOf(rpcCallerOf(principal));
  return signingKey === undefined || asserted === undefined
    ? undefined
    : signPrincipalAssertion(asserted, signingKey);
}
