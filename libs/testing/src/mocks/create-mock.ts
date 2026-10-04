import { type Mock, vi } from 'vitest';

/** `T` with every method replaced by a typed Vitest mock (non-function members keep their type). */
export type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K];
};

/**
 * Keys that must stay `undefined` so the mock isn't mistaken for something it is not:
 * - `then`: otherwise `await mock` / returning it from an async factory treats it as a thenable
 *   and hangs (Nest awaits `useFactory` results);
 * - `asymmetricMatch` / `$$typeof` / `nodeType` / `toJSON`: probed by `expect`, pretty-format,
 *   util.inspect and serializers.
 */
const TRANSPARENT_KEYS = new Set<PropertyKey>([
  'then',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
  'toJSON',
  '@@__IMMUTABLE_ITERABLE__@@',
  '@@__IMMUTABLE_RECORD__@@',
]);

/**
 * The class every mock appears to be an instance of. Reflection-based explorers read a provider's
 * prototype and `constructor`: Nest GraphQL's `ResolversExplorerService` scans the prototype's
 * methods and calls `Reflect.getMetadata(key, instance.constructor)`, and the CQRS and schedule
 * explorers do the same. With a `{}` target the prototype was `Object.prototype` (so `toString`
 * and friends were scanned) and `constructor` was `undefined`, which made `Reflect.getMetadata`
 * throw and crashed any app that boots `GraphQLModule`. This prototype is empty, so there is
 * nothing to scan, and its `constructor` is a real class without metadata.
 */
class MockedInstance {}

/**
 * Creates a mock of any class/interface: every property access lazily returns a (cached)
 * `vi.fn()`, so only the methods a test cares about need configuring:
 *
 * ```ts
 * const users = createMock<UsersPort>({ getUser: async () => user });
 * users.listUsers.mockResolvedValue(page);
 * Test.createTestingModule({ providers: [{ provide: UsersPort, useValue: users }] });
 * ```
 *
 * Function overrides are wrapped in `vi.fn(impl)` (so they are spy-able); other overrides are
 * returned as-is. Symbols (inspection hooks) read as `undefined`. Also usable as a Nest auto
 * mocker: `builder.useMocker(() => createMock())`.
 */
export function createMock<T extends object>(
  overrides: Partial<Record<keyof T, unknown>> = {},
): Mocked<T> {
  const members = new Map<PropertyKey, unknown>();
  for (const [key, value] of Object.entries(overrides)) {
    members.set(
      key,
      typeof value === 'function' && !vi.isMockFunction(value)
        ? vi.fn(value as (...args: unknown[]) => unknown)
        : value,
    );
  }

  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(_target, key) {
      if (members.has(key)) return members.get(key);
      if (key === 'constructor') return MockedInstance;
      if (typeof key === 'symbol' || TRANSPARENT_KEYS.has(key)) return undefined;
      const fn = vi.fn();
      members.set(key, fn);
      return fn;
    },
    set(_target, key, value: unknown) {
      members.set(key, value);
      return true;
    },
    has(_target, key) {
      return members.has(key);
    },
    deleteProperty(_target, key) {
      return members.delete(key);
    },
    ownKeys() {
      return [...members.keys()].filter((key): key is string | symbol => typeof key !== 'number');
    },
    getOwnPropertyDescriptor(_target, key) {
      return members.has(key)
        ? { value: members.get(key), writable: true, enumerable: true, configurable: true }
        : undefined;
    },
  };

  const target = Object.create(MockedInstance.prototype) as Record<PropertyKey, unknown>;
  return new Proxy<Record<PropertyKey, unknown>>(target, handler) as Mocked<T>;
}
