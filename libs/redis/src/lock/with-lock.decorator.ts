import { assertLockArgs } from './distributed-lock.service.js';
import { getLockRunner } from './lock-registry.js';

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

const isMethod = (value: unknown): value is AnyMethod => typeof value === 'function';

/**
 * Copies reflect-metadata from the original method to the wrapper. `@Cron()`, `@Interval()`,
 * `@OnEvent()`… store their metadata ON the function object, so without this the decorator order
 * would matter (`@WithLock` above `@Cron` would silently unregister the cron).
 */
function copyMetadata(from: AnyMethod, to: AnyMethod): void {
  for (const key of Reflect.getOwnMetadataKeys(from)) {
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, from), to);
  }
}

/**
 * Runs the decorated (async) method only on the replica that wins the distributed lock
 * `${prefix}:lock:${resource}`; the others skip it (the method then resolves `undefined`).
 * Meant for `@Cron()` jobs, which fire on every replica:
 *
 * ```ts
 * @Cron(CronExpression.EVERY_HOUR, { name: 'purge-sessions', waitForCompletion: true })
 * @WithLock('identity:purge-sessions', 60_000)
 * async purge(): Promise<void> { … }
 * ```
 *
 * Pick a TTL longer than the job's typical runtime (it is auto-extended while the job runs).
 * Resolution goes through a module-scoped holder set by `DistributedLockService.onModuleInit` —
 * the method throws if `RedisModule` was never initialised in this process.
 */
export function WithLock(resource: string, ttlMs: number): MethodDecorator {
  assertLockArgs(resource, ttlMs);
  return (_target, propertyKey, descriptor) => {
    const original: unknown = descriptor.value;
    if (!isMethod(original)) {
      throw new TypeError(`@WithLock() can only decorate methods (${String(propertyKey)})`);
    }
    const withLock: AnyMethod = async function (this: unknown, ...args: unknown[]) {
      const runner = getLockRunner();
      if (!runner) {
        throw new Error(
          `@WithLock("${resource}") on ${String(propertyKey)}: DistributedLockService is not initialised — import RedisModule.forRootAsync()`,
        );
      }
      const outcome = await runner.using(resource, ttlMs, async () => original.apply(this, args));
      return outcome.acquired ? outcome.result : undefined;
    };
    copyMetadata(original, withLock);
    Object.defineProperty(withLock, 'name', { value: original.name });
    // `Object.assign` keeps the generic descriptor type intact without an unsafe cast.
    Object.assign(descriptor, { value: withLock });
  };
}
