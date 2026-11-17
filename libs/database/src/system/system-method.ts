/**
 * `pre-auth`: runs anywhere (a login or register lookup, before there is a principal);
 * `system`: requires `SystemContext.isActive()` (crons, relays, maintenance consumers).
 */
export type SystemMethodScope = 'pre-auth' | 'system';

/** One named door to the `app_system` pool; each domain pins its list (spec §9 numbering). */
export interface SystemMethod {
  readonly name: string;
  readonly scope: SystemMethodScope;
}

const SCOPES: readonly SystemMethodScope[] = ['pre-auth', 'system'];
/** `<repository>.<method>`, both camelCase identifiers (`sessions.deleteExpired`). */
const METHOD_NAME = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;

/** Every method `defineSystemMethod` made: `SystemDatabase.run` refuses any other object. */
const defined = new WeakSet<SystemMethod>();

/** @throws TypeError when `name` is not `<repository>.<method>` or `scope` is unknown */
export function defineSystemMethod(name: string, scope: SystemMethodScope): SystemMethod {
  if (typeof name !== 'string' || !METHOD_NAME.test(name)) {
    throw new TypeError('defineSystemMethod: the name must be <repository>.<method> (camelCase)');
  }
  if (!SCOPES.includes(scope)) {
    throw new TypeError(`defineSystemMethod: the scope must be one of ${SCOPES.join(', ')}`);
  }
  const method: SystemMethod = Object.freeze({ name, scope });
  defined.add(method);
  return method;
}

/** True only for an object returned by `defineSystemMethod` (package-internal). */
export function isDefinedSystemMethod(method: unknown): method is SystemMethod {
  return typeof method === 'object' && method !== null && defined.has(method as SystemMethod);
}
