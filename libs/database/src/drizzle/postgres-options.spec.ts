import { databaseConfig } from '@platform/config';
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
    const options = buildPostgresOptions(cfg, { applicationName: 'orders-service', onNotice });
    expect(options).toMatchObject({
      max: 12,
      idle_timeout: 30,
      max_lifetime: 1800,
      connect_timeout: 10,
      prepare: false,
      onnotice: onNotice,
      connection: {
        application_name: 'orders-service',
        statement_timeout: 5000,
        idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
        TimeZone: 'UTC',
      },
    });
  });

  it('sends all four startup parameters without a pooler (DATABASE_POOLER=none)', () => {
    expect(cfg.pooler).toBe('none');
    const { connection } = buildPostgresOptions(cfg, { applicationName: 'orders-service' });
    expect(Object.keys(connection ?? {}).sort()).toEqual([
      'TimeZone',
      'application_name',
      'idle_in_transaction_session_timeout',
      'statement_timeout',
    ]);
  });

  it('behind PgBouncer drops both timeouts (rejected as startup parameters; role settings)', () => {
    const pooled = databaseConfig.parse({
      DATABASE_URL: 'postgres://app_runtime:secret@pgbouncer:6432/app',
      DATABASE_POOLER: 'pgbouncer',
    });
    const options = buildPostgresOptions(pooled, { applicationName: 'orders-service' });
    expect(options.connection).toEqual({ application_name: 'orders-service', TimeZone: 'UTC' });
    expect(options.connection).not.toHaveProperty('statement_timeout');
    expect(options.connection).not.toHaveProperty('idle_in_transaction_session_timeout');
    // prepare stays as configured: PgBouncer 1.26 tracks prepared statements.
    expect(options.prepare).toBe(true);
  });

  it('builds the system pool from systemPoolMax with a :system application_name', () => {
    const both = databaseConfig.parse({
      DATABASE_POOL_MAX: '12',
      DATABASE_SYSTEM_POOL_MAX: '3',
      DATABASE_POOLER: 'pgbouncer',
    });
    const system = buildPostgresOptions(both, {
      applicationName: 'orders-service',
      pool: 'system',
    });
    expect(system.max).toBe(3);
    expect(system.connection).toEqual({
      application_name: 'orders-service:system',
      TimeZone: 'UTC',
    });
    const runtime = buildPostgresOptions(both, {
      applicationName: 'orders-service',
      pool: 'runtime',
    });
    expect(runtime.max).toBe(12);
    expect(runtime.connection).toMatchObject({ application_name: 'orders-service' });
    const direct = buildPostgresOptions(cfg, { applicationName: 'app', pool: 'system' });
    expect(direct.max).toBe(5);
    expect(direct.connection).toMatchObject({
      application_name: 'app:system',
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
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
