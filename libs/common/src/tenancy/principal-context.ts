import { ClsServiceManager } from 'nestjs-cls';
import { UnauthenticatedException } from '../errors/domain.exception.js';
import { type Principal, TenancyErrorCode } from './principal.js';

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
