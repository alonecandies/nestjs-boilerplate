import { computeBackoffDelay, withTimeout } from '@app/common';
import type { RedisConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { throttle } from 'lodash-es';

/**
 * Overrides accepted by `createRedisClient`. `keyPrefix` is banned (BullMQ rejects prefixed
 * connections, redlock/Lua would double-prefix — use `RedisKeyService`) and `replyMapping` is fixed
 * to the v5-compatible `legacy` shapes every consumer in this repo expects.
 */
export type RedisClientOverrides = Omit<RedisOptions, 'keyPrefix' | 'replyMapping'>;

/** Upper bound of the reconnect backoff. */
export const REDIS_MAX_RECONNECT_DELAY_MS = 5_000;

/** Reconnect forever with capped exponential backoff + full jitter (no thundering herd on failover). */
export function redisRetryStrategy(attempt: number): number {
  return computeBackoffDelay(attempt, {
    minDelayMs: 100,
    maxDelayMs: REDIS_MAX_RECONNECT_DELAY_MS,
    factor: 2,
    jitter: true,
  });
}

/**
 * After a primary failover the old primary answers `READONLY`; `2` = reconnect AND resend the
 * failed command, so writes land on the new primary instead of surfacing errors.
 */
export function reconnectOnReadonly(error: Error): boolean | 2 {
  return error.message.startsWith('READONLY') ? 2 : false;
}

/** Hides the password of `redis://user:secret@host` URLs before they reach logs or errors. */
export function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid redis url>';
  }
}

const ERROR_LOG_INTERVAL_MS = 5_000;

/**
 * An unhandled `error` event crashes the process, so every client gets a listener. Logging is
 * throttled: ioredis emits one error per reconnect attempt and an outage would flood the logs.
 */
export function attachRedisErrorLogger(client: Redis, connectionName: string): void {
  const logger = new Logger(`Redis:${connectionName}`);
  const log = throttle(
    (error: Error): void => {
      logger.error(`${error.message} (status: ${client.status})`);
    },
    ERROR_LOG_INTERVAL_MS,
    { trailing: false },
  );
  client.on('error', log);
}

/**
 * Creates an ioredis 6 client tuned for throughput on the request path:
 * - `enableAutoPipelining`: commands issued in the same tick share one write (big win under load),
 * - bounded `maxRetriesPerRequest` so requests fail instead of hanging during an outage,
 * - capped-backoff reconnects + READONLY failover handling, TCP keep-alive, `noDelay`.
 *
 * It connects immediately (`lazyConnect: false`); use `waitForRedisReady` to fail fast at boot.
 * Blocking/queue connections need `maxRetriesPerRequest: null` (BullMQ builds its own).
 */
export function createRedisClient(
  config: RedisConfig,
  overrides: RedisClientOverrides = {},
): Redis {
  if ('keyPrefix' in overrides) {
    throw new TypeError('ioredis keyPrefix is not supported — build keys with RedisKeyService');
  }
  const options: RedisClientOverrides = {
    connectionName: config.keyPrefix,
    enableAutoPipelining: true,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    connectTimeout: config.connectTimeoutMs,
    lazyConnect: false,
    enableOfflineQueue: true,
    keepAlive: 30_000,
    noDelay: true,
    retryStrategy: redisRetryStrategy,
    reconnectOnError: reconnectOnReadonly,
    ...overrides,
  };
  const client = new Redis(config.url, options);
  attachRedisErrorLogger(client, options.connectionName ?? 'redis');
  return client;
}

/**
 * Resolves once the client is `ready`, rejects after `timeoutMs` (or if the client ends first).
 * Unlike `events.once(client, 'ready')` it tolerates transient connection errors while Redis is
 * still starting (e.g. docker compose boot order) instead of failing on the first ECONNREFUSED.
 */
export function waitForRedisReady(
  client: Redis,
  timeoutMs: number,
  label = 'Redis',
): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  if (client.status === 'end') {
    return Promise.reject(new Error(`${label}: connection is already closed`));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('end', onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`${label}: connection ended before it became ready`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: not ready after ${timeoutMs}ms (status: ${client.status})`));
    }, timeoutMs);
    client.once('ready', onReady);
    client.once('end', onEnd);
  });
}

/**
 * Graceful close: `QUIT` flushes pending replies first, then we wait for the socket to actually
 * end (ioredis still reports `ready` when the QUIT reply arrives). Falls back to a hard
 * `disconnect()` when Redis is unreachable or doesn't answer within `timeoutMs`, so shutdown can
 * never hang on it. Clients that never connected (`lazyConnect`) are just discarded.
 */
export async function closeRedisClient(client: Redis, timeoutMs = 2_000): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }
  const ended = new Promise<void>((resolve) => {
    client.once('end', () => {
      resolve();
    });
  });
  try {
    await withTimeout(Promise.all([client.quit(), ended]), timeoutMs, 'Redis QUIT timed out');
  } catch {
    client.disconnect();
  }
}
