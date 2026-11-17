import { getPrincipal, type Principal } from '@platform/common';

export interface PrincipalCall {
  /** `<name>.<method>` */
  readonly call: string;
  /** The CLS principal when the call was made (undefined: none). */
  readonly principal: Principal | undefined;
}

/**
 * Records, for every method call on the tracked doubles, the CLS principal it ran under: the unit
 * specs of the B3 flows assert that no repository call happens before the principal of its unit of
 * work is set. `track` wraps a double (the handler gets the wrapper; assertions keep using the
 * double itself).
 */
export function principalLog() {
  const calls: PrincipalCall[] = [];
  const track = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value: unknown = Reflect.get(object, key, receiver);
        if (typeof value !== 'function' || typeof key === 'symbol') return value;
        return (...args: unknown[]) => {
          calls.push({ call: `${name}.${key}`, principal: getPrincipal() });
          return (value as (...a: unknown[]) => unknown).apply(object, args);
        };
      },
    });
  /** The principal of each call, as `[call, userId, tenantId]` (undefined principal: `null`s). */
  const summary = (): [string, string | null, string | null][] =>
    calls.map(({ call, principal }) => [
      call,
      principal?.userId ?? null,
      principal?.tenantId ?? null,
    ]);
  return { calls, track, summary };
}
