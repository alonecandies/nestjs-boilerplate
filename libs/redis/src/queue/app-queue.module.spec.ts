import { appConfig, redisConfig } from '@app/config';
import { describe, expect, it } from 'vitest';
import { redisRetryStrategy } from '../redis.factory.js';
import { AppQueueModule, createQueueOptions, DEFAULT_JOB_OPTIONS } from './app-queue.module.js';

const redis = redisConfig.parse({ REDIS_URL: 'redis://localhost:6399/1', REDIS_KEY_PREFIX: 'svc' });

describe('createQueueOptions', () => {
  it('builds BullMQ-safe connection options (no per-request retry limit, no keyPrefix)', () => {
    const options = createQueueOptions(redis, appConfig.parse({ SERVICE_NAME: 'notifications' }));
    expect(options.connection).toMatchObject({
      url: 'redis://localhost:6399/1',
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectionName: 'notifications:bull',
      retryStrategy: redisRetryStrategy,
    });
    expect(options.connection).not.toHaveProperty('keyPrefix');
    expect(options.prefix).toBe('bull');
    expect(options.defaultJobOptions).toEqual(DEFAULT_JOB_OPTIONS);
  });

  it('deep-merges job option overrides and honours a custom prefix', () => {
    const options = createQueueOptions(redis, undefined, {
      prefix: 'jobs',
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
    });
    expect(options.prefix).toBe('jobs');
    expect(options.connection).toMatchObject({ connectionName: 'svc:bull' });
    expect(options.defaultJobOptions).toEqual({
      attempts: 2,
      backoff: { type: 'fixed', delay: 500 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5); // defaults not mutated
  });

  it('registers BullModule.forRootAsync', () => {
    const dynamic = AppQueueModule.forRootAsync();
    expect(dynamic.module).toBe(AppQueueModule);
    expect(dynamic.imports).toHaveLength(1);
  });
});
