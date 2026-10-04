import { databaseConfig } from '@app/config';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPostgresOptions,
  describePostgresUrl,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  isTransientConnectionError,
} from './postgres-options.js';

const cfg = databaseConfig.parse({
  DATABASE_URL: 'postgres://app:secret@db.internal:6543/appdb',
  DATABASE_POOL_MAX: '12',
  DATABASE_STATEMENT_TIMEOUT_MS: '5000',
  DATABASE_PREPARE: 'false',
});

describe('buildPostgresOptions', () => {
  it('maps the database namespace onto postgres.js options (seconds vs ms)', () => {
    const onNotice = vi.fn();
    const options = buildPostgresOptions(cfg, { applicationName: 'identity-service', onNotice });
    expect(options).toMatchObject({
      max: 12,
      idle_timeout: 30,
      max_lifetime: 1800,
      connect_timeout: 10,
      prepare: false,
      onnotice: onNotice,
      connection: {
        application_name: 'identity-service',
        statement_timeout: 5000,
        idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
        TimeZone: 'UTC',
      },
    });
  });

  it('treats 0 as "disabled" instead of passing a degenerate 0 to postgres.js', () => {
    const zero = databaseConfig.parse({
      DATABASE_IDLE_TIMEOUT_SEC: '0',
      DATABASE_MAX_LIFETIME_SEC: '0',
    });
    const options = buildPostgresOptions(zero, { applicationName: 'app' });
    expect(options.idle_timeout).toBeUndefined();
    expect(options.max_lifetime).toBeNull();
    expect(typeof options.onnotice).toBe('function');
  });

  it('deep-merges overrides last without dropping the startup GUCs', () => {
    const options = buildPostgresOptions(
      cfg,
      { applicationName: 'app' },
      { max: 1, ssl: 'require', connection: { lock_timeout: 3000 } },
    );
    expect(options.max).toBe(1);
    expect(options.ssl).toBe('require');
    expect(options.connection).toMatchObject({
      application_name: 'app',
      statement_timeout: 5000,
      lock_timeout: 3000,
    });
  });
});

describe('isTransientConnectionError', () => {
  it.each(['ECONNREFUSED', 'CONNECT_TIMEOUT', '57P03', '53300'])('retries %s', (code) => {
    expect(isTransientConnectionError(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it.each(['28P01', '3D000', '42P01', undefined])('does not retry %s', (code) => {
    expect(isTransientConnectionError(Object.assign(new Error('x'), { code }))).toBe(false);
  });

  it('handles non-errors', () => {
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError('ECONNREFUSED')).toBe(false);
  });
});

describe('describePostgresUrl', () => {
  it('never leaks credentials', () => {
    expect(describePostgresUrl(cfg.url)).toBe('db.internal:6543/appdb');
    expect(describePostgresUrl('postgres://u:p@localhost/app')).toBe('localhost:5432/app');
    expect(describePostgresUrl('not a url')).toBe('<invalid DATABASE_URL>');
  });
});
