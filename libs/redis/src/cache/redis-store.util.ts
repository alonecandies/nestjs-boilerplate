import KeyvRedis from '@keyv/redis';
import type { Cache } from 'cache-manager';
import { noop } from 'lodash-es';

/** The slice of node-redis' client / cluster / sentinel API needed to open the connection. */
interface OpenableRedisConnection {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
}

/**
 * Opens the connection of every `@keyv/redis` tier ONCE, eagerly — never through
 * `KeyvRedis#getClient()`. That method opens the client lazily on the first cache call, races the
 * connect against `connectionTimeout` and DESTROYS the client when Redis does not answer, so during
 * an outage every single cache call waits `connectionTimeout` (10 s by default) and re-registers
 * the client's event listeners (a leak).
 *
 * An opened node-redis client stays `isOpen` through its own reconnect loop (the reconnect
 * strategy never gives up), and with `disableOfflineQueue` (set by `createCacheOptions`) commands
 * fail immediately while it reconnects: a Redis outage degrades to L1 + loader at full speed and
 * the tier recovers by itself. Connect errors surface through the store's `error` event (logged,
 * throttled); `@nestjs/cache-manager` closes the connection in `onModuleDestroy`.
 *
 * @returns the number of connections it started opening.
 */
export function openRedisStores(cache: Pick<Cache, 'stores'>): number {
  let opened = 0;
  for (const store of cache.stores) {
    const adapter: unknown = (store as { store?: unknown }).store;
    if (!(adapter instanceof KeyvRedis)) continue;
    const connection: OpenableRedisConnection = adapter.client;
    if (connection.isOpen) continue;
    // Resolves once ready; it only rejects when the client is closed while still connecting.
    connection.connect().catch(noop);
    opened += 1;
  }
  return opened;
}
