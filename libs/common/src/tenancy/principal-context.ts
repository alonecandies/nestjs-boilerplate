import { ClsServiceManager } from 'nestjs-cls';
import { UnauthenticatedException } from '../errors/domain.exception.js';
import { isPrincipal, type Principal, TenancyErrorCode } from './principal.js';

/** CLS key of the request principal (spec §7). */
export const CLS_PRINCIPAL: unique symbol = Symbol('app:principal');

/**
 * nestjs-cls keeps ONE ClsService per process: `ClsServiceManager.getClsService()` is the same
 * instance DI hands out (`ClsModule` provides it with `useValue`), so these helpers need no module
 * and work in guards, interceptors, handlers and B3's transaction adapter alike.
 */
const cls = () => ClsServiceManager.getClsService();

export function getPrincipal(): Principal | undefined {
  const store = cls();
  return store.isActive() ? store.get<Principal | undefined>(CLS_PRINCIPAL) : undefined;
}

export function requirePrincipal(): Principal {
  const principal = getPrincipal();
  if (principal === undefined) {
    throw new UnauthenticatedException('Authentication required', {
      code: TenancyErrorCode.PRINCIPAL_MISSING,
    });
  }
  return principal;
}

export function setPrincipal(principal: Principal): void {
  const store = cls();
  if (!store.isActive()) throw new Error('setPrincipal() needs an active CLS context');
  store.set(CLS_PRINCIPAL, principal);
}

/** Runs `fn` in a child context that inherits the parent store, with `principal` set. */
export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  const store = cls();
  return store.run({ ifNested: 'inherit' }, () => {
    store.set(CLS_PRINCIPAL, principal);
    return fn();
  });
}

/**
 * The principals this process's own access-token verification wrote (`writePrincipal` in
 * `@platform/auth`). Outside a gRPC call, only such a principal leaves on a gRPC call
 * (`@platform/transport`), in plain headers and in a signed principal assertion: one adopted from
 * an event envelope or from gRPC metadata, or set with `runWithPrincipal`, is never marked, so the
 * edge never vouches for it. The mark is on the object
 * itself, so an equal copy is unmarked.
 */
const tokenVerified = new WeakSet<Principal>();

/**
 * Marks `principal` as written by this process's own token verification, and returns it. Only a
 * frozen principal (`createPrincipal`) can be marked: a mark on a mutable object would vouch for
 * whatever it later holds, and one on a frozen object that is not a principal would vouch for
 * something no principal check accepts.
 * @throws TypeError for an object that is not a frozen principal
 */
export function markTokenVerified(principal: Principal): Principal {
  if (!isPrincipal(principal) || !Object.isFrozen(principal) || !Object.isFrozen(principal.roles)) {
    throw new TypeError('Only a frozen principal (createPrincipal) can be marked token-verified');
  }
  tokenVerified.add(principal);
  return principal;
}

/** True only for a principal `markTokenVerified` marked. */
export function isTokenVerified(value: unknown): value is Principal {
  return typeof value === 'object' && value !== null && tokenVerified.has(value as Principal);
}
