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
 * - anything malformed → `UnauthenticatedException` `INVALID_PRINCIPAL` (fail closed), with
 *   `createPrincipal`'s `details.reason` (`principalForRpcCall` strips it before a caller sees it).
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

/** The refusal a gRPC caller gets: no `details`, so it says nothing about why. */
const invalidPrincipal = (): UnauthenticatedException =>
  new UnauthenticatedException('Invalid principal', { code: TenancyErrorCode.INVALID_PRINCIPAL });

/** Told why `principalForRpcCall` refused a principal; never sent to the caller. */
export type PrincipalRefusalListener = (reason: string) => void;

/**
 * The principal of one incoming call under `GRPC_PRINCIPAL_ASSERTION` (`check` is
 * `assessPrincipalAssertion`'s result, `undefined` in `off` or for an anonymous call):
 * - `off` and `warn`: the plain headers (`principalFromRpcCaller`), whatever the assertion says;
 * - `enforce`: no user and no assertion → anonymous (`undefined`); a valid assertion → the principal
 *   of its signed claims alone, through the same `createPrincipal` rules; anything else (no
 *   assertion beside `x-user-id`, expired, invalid, another key, or plain headers that differ from
 *   the claims) → `UnauthenticatedException` `INVALID_PRINCIPAL`. A mesh peer without the edge's
 *   private key thus cannot assert a user, a tenant, roles or the staff flag.
 *
 * Every `INVALID_PRINCIPAL` it throws, in every mode, has no `details`: the caller learns nothing
 * about why, since the refusal can reach a public 401 through the gateway. When `createPrincipal`
 * rejects the headers or the signed claims, its reason goes to `onRefused` (the service's log) only.
 */
export function principalForRpcCall(
  caller: IncomingRpcContext,
  mode: GrpcPrincipalAssertionMode,
  check: PrincipalAssertionCheck | undefined,
  onRefused?: PrincipalRefusalListener,
): Principal | undefined {
  if (mode !== 'enforce') return principalWithoutReason(caller, onRefused);
  if (check === undefined) return undefined;
  // The outcome stays in this service's log and in grpc_principal_assertions_total.
  if (check.outcome !== 'valid') throw invalidPrincipal();
  return principalWithoutReason({ ...check.caller }, onRefused);
}

/** `principalFromRpcCaller`, with its `INVALID_PRINCIPAL` stripped of `details.reason`. */
function principalWithoutReason(
  caller: IncomingRpcContext,
  onRefused: PrincipalRefusalListener | undefined,
): Principal | undefined {
  try {
    return principalFromRpcCaller(caller);
  } catch (error) {
    if (
      !(error instanceof UnauthenticatedException) ||
      error.code !== TenancyErrorCode.INVALID_PRINCIPAL
    )
      throw error;
    const reason = error.details?.['reason'];
    onRefused?.(typeof reason === 'string' ? reason : 'invalid principal');
    throw invalidPrincipal();
  }
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
