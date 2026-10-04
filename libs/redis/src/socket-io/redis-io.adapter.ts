import { type RedisConfig, redisConfig } from '@app/config';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { joinKey } from '../keys/key.util.js';
import {
  attachRedisErrorLogger,
  closeRedisClient,
  createRedisClient,
  redactRedisUrl,
  waitForRedisReady,
} from '../redis.factory.js';

// @nestjs/platform-socket.io pins its own socket.io copy: derive the types from IoAdapter so they
// always match the server Nest creates (research nest-http §4 / §14.10 — duplicate socket.io types).
type IoServer = ReturnType<IoAdapter['createIOServer']>;
export type IoServerOptions = NonNullable<Parameters<IoAdapter['createIOServer']>[1]>;

/**
 * Throughput-oriented socket.io defaults (each gateway's own options win):
 * websocket-only (no long-polling → no sticky sessions behind a load balancer), no
 * per-message deflate (CPU > bandwidth for small messages), 1 MB max frame.
 */
export const DEFAULT_IO_SERVER_OPTIONS: Readonly<Partial<IoServerOptions>> = {
  transports: ['websocket'],
  perMessageDeflate: false,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1_000_000,
};

export interface RedisIoAdapterOptions {
  /** Merged over `DEFAULT_IO_SERVER_OPTIONS`, under each gateway's `@WebSocketGateway()` options. */
  serverOptions?: Partial<IoServerOptions>;
  /** Pub/sub channel prefix. Default `${REDIS_KEY_PREFIX}:socket.io` (isolates apps sharing Redis). */
  key?: string;
  /** Timeout for cross-node requests (`fetchSockets`, `serverSideEmit` acks). Default 5000 ms. */
  requestsTimeoutMs?: number;
}

/**
 * socket.io adapter that fans broadcasts / room emits out to every replica through Redis pub/sub
 * (`@socket.io/redis-adapter`). Two dedicated ioredis connections: pub (auto-pipelined commands)
 * and sub (subscriber mode). `maxRetriesPerRequest: null` because the adapter never awaits its
 * `publish()` calls — a rejected publish would be an unhandled rejection; queued is safer.
 *
 * Note: socket.io `connectionStateRecovery` is not supported by the Redis adapter.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly config: RedisConfig,
    private readonly adapterOptions: RedisIoAdapterOptions = {},
  ) {
    super(app); // passing the app attaches socket.io to Nest's (Fastify) HTTP server
  }

  /** Opens both connections (fails after `REDIS_CONNECT_TIMEOUT_MS`). Idempotent. */
  async connectToRedis(): Promise<void> {
    if (this.adapterConstructor) return;
    const name = joinKey(this.config.keyPrefix, 'socket.io');
    const pub = createRedisClient(this.config, {
      connectionName: `${name}:pub`,
      maxRetriesPerRequest: null,
    });
    const sub = pub.duplicate({ connectionName: `${name}:sub`, enableAutoPipelining: false });
    attachRedisErrorLogger(sub, `${name}:sub`); // listeners are not copied by duplicate()
    this.clients.push(pub, sub);
    try {
      const label = `socket.io adapter ${redactRedisUrl(this.config.url)}`;
      await Promise.all([
        waitForRedisReady(pub, this.config.connectTimeoutMs, label),
        waitForRedisReady(sub, this.config.connectTimeoutMs, label),
      ]);
    } catch (error) {
      for (const client of this.clients.splice(0)) client.disconnect();
      throw error;
    }
    this.adapterConstructor = createAdapter(pub, sub, {
      key: this.adapterOptions.key ?? name,
      requestsTimeout: this.adapterOptions.requestsTimeoutMs ?? 5_000,
    });
  }

  override createIOServer(port: number, options?: IoServerOptions): IoServer {
    // socket.io's ServerOptions marks every field required; the merge is a partial override that
    // socket.io completes with its own defaults.
    const server = super.createIOServer(port, {
      ...DEFAULT_IO_SERVER_OPTIONS,
      ...this.adapterOptions.serverOptions,
      ...options,
    } as IoServerOptions);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      this.logger.warn(
        'RedisIoAdapter.connectToRedis() was not awaited — broadcasts stay local to this replica',
      );
    }
    return server;
  }

  /** Called once by Nest after every gateway server is closed — the right moment to QUIT. */
  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.allSettled(this.clients.splice(0).map((client) => closeRedisClient(client)));
    this.adapterConstructor = undefined;
  }
}

/**
 * `app.useWebSocketAdapter(await createRedisIoAdapter(app))` — reads `redisConfig` from the app
 * container (loaded by `RedisModule`), connects, and returns the adapter.
 */
export async function createRedisIoAdapter(
  app: INestApplication,
  options?: RedisIoAdapterOptions,
): Promise<RedisIoAdapter> {
  const config = app.get<RedisConfig>(redisConfig.KEY);
  const adapter = new RedisIoAdapter(app, config, options);
  await adapter.connectToRedis();
  return adapter;
}
