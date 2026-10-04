import { Injectable, Logger } from '@nestjs/common';
import type DataLoader from 'dataloader';
import { sortBy } from 'lodash-es';
import type { GraphqlLoaders } from '../context/gql-context.js';

/** Builds a fresh loader. It is called at most once per GraphQL operation, on first use. */
export type DataLoaderFactory<K = unknown, V = unknown, C = K> = () => DataLoader<K, V, C>;

/**
 * Singleton registry of DataLoader factories. Domain modules register theirs at boot (for example
 * in `onModuleInit`), and the GraphQL context function asks for a fresh set per operation.
 *
 * This replaces REQUEST-scoped providers. Those would re-instantiate the whole resolver graph on
 * every request. Here only the loaders an operation actually touches are created. They sit behind
 * lazy getters on a shared prototype, so `createLoaders()` costs a single `Object.create()`,
 * however many loaders are registered.
 */
@Injectable()
export class DataLoaderRegistry {
  private readonly logger = new Logger(DataLoaderRegistry.name);
  private readonly factories = new Map<string, DataLoaderFactory>();
  private prototype: object = Object.freeze(Object.create(null) as object);

  /**
   * Registers `factory` under `name` (`@Loader(name)` / `ctx.loaders[name]`).
   * @throws Error when `name` is taken: two libs silently sharing a key is always a bug.
   */
  register<K, V, C = K>(name: string, factory: DataLoaderFactory<K, V, C>): void {
    if (this.factories.has(name)) {
      throw new Error(`DataLoader "${name}" is already registered`);
    }
    this.factories.set(name, factory);
    this.prototype = this.buildPrototype();
    this.logger.debug(`Registered DataLoader "${name}"`);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** Registered loader names, sorted. */
  names(): string[] {
    return sortBy([...this.factories.keys()]);
  }

  /**
   * A new, isolated set of loaders for one operation. Batching and caching then never leak across
   * requests (or users). Each loader is instantiated when it is first read.
   */
  createLoaders(): GraphqlLoaders {
    return Object.create(this.prototype) as GraphqlLoaders;
  }

  private buildPrototype(): object {
    const proto = Object.create(null) as object;
    for (const [name, factory] of this.factories) {
      Object.defineProperty(proto, name, {
        enumerable: true,
        get(this: object): DataLoader<unknown, unknown> {
          const loader = factory();
          // Shadow the getter with the instance, so later reads in the same operation hit it.
          Object.defineProperty(this, name, { value: loader, enumerable: true });
          return loader;
        },
      });
    }
    return Object.freeze(proto);
  }
}
