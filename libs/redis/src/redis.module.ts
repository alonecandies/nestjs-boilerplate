import { type AppConfig, appConfig, type RedisConfig, redisConfig } from '@app/config';
import {
  type DynamicModule,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { Redlock } from '@sesamecare-oss/redlock';
import type { Redis } from 'ioredis';
import { RedisHealthIndicator } from './health/redis.health.js';
import { RedisKeyService } from './keys/redis-key.service.js';
import { DistributedLockService, REDLOCK_SETTINGS } from './lock/distributed-lock.service.js';
import {
  InjectRedis,
  InjectRedisSubscriber,
  REDIS_CLIENT,
  REDIS_MODULE_OPTIONS,
  REDIS_SUBSCRIBER,
  REDLOCK,
} from './redis.constants.js';
import {
  attachRedisErrorLogger,
  closeRedisClient,
  createRedisClient,
  type RedisClientOverrides,
  redactRedisUrl,
  waitForRedisReady,
} from './redis.factory.js';

export interface RedisModuleOptions {
  /**
   * Shown in `CLIENT LIST` (`<name>` / `<name>:sub`) — invaluable when several services share one
   * Redis. Default: `SERVICE_NAME` (app config), else `REDIS_KEY_PREFIX`.
   */
  connectionName?: string;
  /** Extra ioredis options merged over the defaults (e.g. `tls`, `username`, `db`). */
  clientOptions?: RedisClientOverrides;
  /**
   * Block boot until the main connection is ready (max `REDIS_CONNECT_TIMEOUT_MS`) so a missing
   * Redis fails the deployment loudly instead of degrading every request. Default `true`.
   */
  waitForReady?: boolean;
}

async function createMainClient(
  config: RedisConfig,
  options: RedisModuleOptions,
  app: AppConfig | undefined,
): Promise<Redis> {
  const client = createRedisClient(config, {
    connectionName: options.connectionName ?? app?.serviceName ?? config.keyPrefix,
    ...options.clientOptions,
  });
  if (options.waitForReady ?? true) {
    try {
      await waitForRedisReady(client, config.connectTimeoutMs, redactRedisUrl(config.url));
    } catch (error) {
      client.disconnect(); // stop the background reconnect loop of the failed client
      throw error;
    }
  }
  return client;
}

/**
 * The subscriber is a `duplicate()` with `lazyConnect`: it opens a socket only on the first
 * SUBSCRIBE, has no per-request retry limit (subscriptions must survive outages) and no
 * auto-pipelining. ioredis re-subscribes automatically after reconnects.
 */
function createSubscriber(main: Redis): Redis {
  const connectionName = `${main.options.connectionName ?? 'redis'}:sub`;
  const subscriber = main.duplicate({
    connectionName,
    lazyConnect: true,
    enableAutoPipelining: false,
    maxRetriesPerRequest: null,
  });
  attachRedisErrorLogger(subscriber, connectionName);
  return subscriber;
}

/**
 * Closes both connections in `onApplicationShutdown`. Nest runs shutdown hooks of global modules
 * LAST, so consumers (lock releases, queue drains…) can still use Redis in their own hooks.
 */
@Injectable()
export class RedisShutdownHook implements OnApplicationShutdown {
  constructor(
    @InjectRedis() private readonly client: Redis,
    @InjectRedisSubscriber() private readonly subscriber: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([closeRedisClient(this.subscriber), closeRedisClient(this.client)]);
  }
}

const redisProviders: Provider[] = [
  {
    provide: REDIS_CLIENT,
    inject: [redisConfig.KEY, REDIS_MODULE_OPTIONS, { token: appConfig.KEY, optional: true }],
    useFactory: createMainClient,
  },
  { provide: REDIS_SUBSCRIBER, inject: [REDIS_CLIENT], useFactory: createSubscriber },
  {
    provide: REDLOCK,
    inject: [REDIS_CLIENT],
    useFactory: (client: Redis): Redlock => new Redlock([client], REDLOCK_SETTINGS),
  },
  RedisKeyService,
  DistributedLockService,
  RedisHealthIndicator,
  RedisShutdownHook,
];

/**
 * Global Redis infrastructure: `REDIS_CLIENT` (ioredis 6, auto-pipelined), `REDIS_SUBSCRIBER`,
 * `RedisKeyService`, `DistributedLockService` (+ `@WithLock`) and `RedisHealthIndicator`.
 * Import once in the root module; feature modules just inject.
 */
@Module({})
export class RedisModule {
  static forRootAsync(options: RedisModuleOptions = {}): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      // TerminusModule supplies HealthIndicatorService for RedisHealthIndicator.
      imports: [ConfigModule.forFeature(redisConfig), TerminusModule],
      providers: [{ provide: REDIS_MODULE_OPTIONS, useValue: options }, ...redisProviders],
      exports: [
        REDIS_CLIENT,
        REDIS_SUBSCRIBER,
        REDLOCK,
        RedisKeyService,
        DistributedLockService,
        RedisHealthIndicator,
      ],
    };
  }
}
