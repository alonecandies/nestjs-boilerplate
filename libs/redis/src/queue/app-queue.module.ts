import { type AppConfig, appConfig, type RedisConfig, redisConfig } from '@app/config';
import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { DefaultJobOptions, QueueOptions } from 'bullmq';
import { merge } from 'lodash-es';
import { reconnectOnReadonly, redisRetryStrategy } from '../redis.factory.js';

/** BullMQ key prefix (`bull:<queue>:…`). Producers and workers in different services must agree. */
export const DEFAULT_QUEUE_PREFIX = 'bull';

/**
 * Job defaults: 5 attempts with exponential backoff (2s, 4s, 8s…) and bounded retention so Redis
 * memory does not grow with every completed/failed job. Override per queue/job as needed.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<DefaultJobOptions> = Object.freeze({
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
});

export interface AppQueueModuleOptions {
  /** Default `DEFAULT_QUEUE_PREFIX`. */
  prefix?: string;
  /** Deep-merged over `DEFAULT_JOB_OPTIONS`. */
  defaultJobOptions?: DefaultJobOptions;
}

/** BullMQ root options; exported for tests and for apps composing their own BullModule setup. */
export function createQueueOptions(
  redis: RedisConfig,
  app: AppConfig | undefined,
  options: AppQueueModuleOptions = {},
): QueueOptions {
  return {
    // BullMQ builds its own ioredis connections from these options (one per Queue / Worker /
    // QueueEvents). Blocking worker connections REQUIRE maxRetriesPerRequest: null, and keyPrefix
    // is rejected — namespacing is BullMQ's `prefix` (research data-libs §3.6, §7.25).
    connection: {
      url: redis.url,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: redis.connectTimeoutMs,
      connectionName: `${app?.serviceName ?? redis.keyPrefix}:bull`,
      retryStrategy: redisRetryStrategy,
      reconnectOnError: reconnectOnReadonly,
    },
    prefix: options.prefix ?? DEFAULT_QUEUE_PREFIX,
    defaultJobOptions: merge({}, DEFAULT_JOB_OPTIONS, options.defaultJobOptions),
  };
}

/**
 * Global BullMQ 6 connection + job defaults. Feature modules then call
 * `BullModule.registerQueue({ name })` and use `@InjectQueue()` / `@Processor()`.
 *
 * BullMQ 6 reminders: custom `jobId`s must not contain `:` nor be integer strings; the legacy
 * `repeat` API is gone (use `queue.upsertJobScheduler`).
 */
@Module({})
export class AppQueueModule {
  static forRootAsync(options: AppQueueModuleOptions = {}): DynamicModule {
    return {
      module: AppQueueModule,
      imports: [
        BullModule.forRootAsync({
          imports: [ConfigModule.forFeature(redisConfig)],
          inject: [redisConfig.KEY, { token: appConfig.KEY, optional: true }],
          useFactory: (redis: RedisConfig, app?: AppConfig): QueueOptions =>
            createQueueOptions(redis, app, options),
        }),
      ],
      exports: [BullModule],
    };
  }
}
