import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { validateAllEnv } from '../all-config.js';
import { type OutboxConfig, outboxConfig } from './outbox.config.js';

describe('outbox config', () => {
  it('has the six defaults', () => {
    expect(outboxConfig.parse({})).toEqual({
      relayEnabled: true,
      pollIntervalMs: 500,
      batchSize: 100,
      lockTtlMs: 15_000,
      maxBackoffMs: 30_000,
      retentionHours: 168,
    } satisfies OutboxConfig);
    expect(validateAllEnv({}).outbox.batchSize).toBe(100);
  });

  it('reads every variable', () => {
    expect(
      outboxConfig.parse({
        OUTBOX_RELAY_ENABLED: 'false',
        OUTBOX_POLL_INTERVAL_MS: '50',
        OUTBOX_BATCH_SIZE: '500',
        OUTBOX_LOCK_TTL_MS: '300000',
        OUTBOX_MAX_BACKOFF_MS: '50',
        OUTBOX_RETENTION_HOURS: '8760',
      }),
    ).toEqual({
      relayEnabled: false,
      pollIntervalMs: 50,
      batchSize: 500,
      lockTtlMs: 300_000,
      maxBackoffMs: 50,
      retentionHours: 8_760,
    } satisfies OutboxConfig);
  });

  it.each([
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_BATCH_SIZE', '501'],
    ['OUTBOX_POLL_INTERVAL_MS', '49'],
    ['OUTBOX_POLL_INTERVAL_MS', '60001'],
    ['OUTBOX_LOCK_TTL_MS', '999'],
    ['OUTBOX_LOCK_TTL_MS', '300001'],
    ['OUTBOX_RETENTION_HOURS', '0'],
    ['OUTBOX_RETENTION_HOURS', '8761'],
    ['OUTBOX_RELAY_ENABLED', 'yes'],
  ])('rejects %s=%s', (key, value) => {
    const error = errorOf(() => outboxConfig.parse({ [key]: value }));
    expect(error.issues.map((issue) => issue.path[0])).toContain(key);
  });

  it('rejects a maximum backoff below the poll interval', () => {
    const error = errorOf(() =>
      outboxConfig.parse({ OUTBOX_POLL_INTERVAL_MS: '1000', OUTBOX_MAX_BACKOFF_MS: '999' }),
    );
    expect(error.issues.map((issue) => issue.path[0])).toEqual(['OUTBOX_MAX_BACKOFF_MS']);
    expect(() =>
      outboxConfig.parse({ OUTBOX_POLL_INTERVAL_MS: '1000', OUTBOX_MAX_BACKOFF_MS: '1000' }),
    ).not.toThrow();
  });
});
