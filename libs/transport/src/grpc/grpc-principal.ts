import {
  createPrincipal,
  type Principal,
  TenancyErrorCode,
  UnauthenticatedException,
} from '@platform/common';
import type { GrpcPrincipalAssertionMode } from '@platform/config';
import type { IncomingRpcContext, RpcCallerContext } from './grpc-metadata.js';
import type { PrincipalAssertionCheck } from './grpc-principal-assertion.js';

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

/**
 * The principal of one incoming call under `GRPC_PRINCIPAL_ASSERTION` (`check` is
 * `assessPrincipalAssertion`'s result, `undefined` in `off` or for an anonymous call):
 * - `off` and `warn`: the plain headers (`principalFromRpcCaller`), whatever the assertion says;
 * - `enforce`: no user and no assertion → anonymous (`undefined`); a valid assertion → the principal
 *   of its signed claims alone, through the same `createPrincipal` rules; anything else (no
 *   assertion beside `x-user-id`, expired, invalid, another key, or plain headers that differ from
 *   the claims) → `UnauthenticatedException` `INVALID_PRINCIPAL`, with no `details`: the caller
 *   learns nothing about why. A mesh peer without the edge's private key thus cannot assert a user,
 *   a tenant, roles or the staff flag.
 */
export function principalForRpcCall(
  caller: IncomingRpcContext,
  mode: GrpcPrincipalAssertionMode,
  check: PrincipalAssertionCheck | undefined,
): Principal | undefined {
  if (mode !== 'enforce') return principalFromRpcCaller(caller);
  if (check === undefined) return undefined;
  if (check.outcome !== 'valid') {
    // No details: the refusal can reach a public 401 body through the gateway. The outcome stays
    // in this service's log and in grpc_principal_assertions_total.
    throw new UnauthenticatedException('Invalid principal', {
      code: TenancyErrorCode.INVALID_PRINCIPAL,
    });
  }
  return principalFromRpcCaller({ ...check.caller });
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
