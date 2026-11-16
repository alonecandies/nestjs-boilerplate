import { createPrincipal, type Principal } from '@platform/common';
import type { IncomingRpcContext, RpcCallerContext } from './grpc-metadata.js';

/**
 * The principal a gRPC caller asserted in metadata (spec §7). The gateway authenticated the user and
 * forwards `x-user-id`, `x-tenant-id`, `x-user-roles` and `x-staff` on every call; services trust them
 * only inside the mesh (gRPC mTLS, or GRPC_ALLOW_INSECURE behind a mesh that does mTLS).
 * - no `x-user-id` → `undefined` (anonymous: register, login, a signed third-party webhook);
 * - no `x-tenant-id` → a user-scoped principal (roles and staff need a tenant, so they are dropped);
 * - anything malformed → `UnauthenticatedException` `INVALID_PRINCIPAL` (fail closed).
 */
export function principalFromRpcCaller(caller: IncomingRpcContext): Principal | undefined {
  if (caller.userId === undefined) return undefined;
  if (caller.tenantId === undefined)
    return createPrincipal({ userId: caller.userId, tenantId: null });
  return createPrincipal({
    userId: caller.userId,
    tenantId: caller.tenantId,
    roles: caller.roles,
    staff: caller.staff,
  });
}

/** What an outgoing call asserts for `principal`. `staff` only when true. */
export function rpcCallerOf(principal: Principal): RpcCallerContext {
  return {
    userId: principal.userId,
    ...(principal.tenantId === null ? {} : { tenantId: principal.tenantId }),
    ...(principal.roles.length === 0 ? {} : { roles: [...principal.roles] }),
    ...(principal.staff ? { staff: true } : {}),
  };
}
