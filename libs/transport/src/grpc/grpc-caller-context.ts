import { CLS_PRINCIPAL, isPrincipal, pickDefined } from '@platform/common';
import type { ClsService } from 'nestjs-cls';
import { correlationIdFromCls, requestIdFromCls } from '../context/transport-context.js';
import type { RpcCallerContext } from './grpc-metadata.js';
import { rpcCallerOf } from './grpc-principal.js';

/**
 * Caller context for an outgoing gRPC call, built from the current nestjs-cls context:
 * - `requestId` = `cls.getId()`. At the edge this is the HTTP request id; inside a service it
 *   is the id adopted by `GrpcContextInterceptor`, so it follows service→service hops.
 * - `correlationId` = the chain's correlation id (see `correlationIdFromCls`).
 * - `userId`, `tenantId`, `roles`, `staff` come from the CLS principal; never from request headers.
 * - an override with another `userId` drops the principal's tenant, roles and staff flag.
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
    }
  }
  return { ...context, ...pickDefined(overrides) };
}
