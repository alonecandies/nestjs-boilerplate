import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import type { DrizzleDB } from './drizzle.types.js';
import {
  DrizzlePostgresTransactionalAdapter,
  normalizeTxConfig,
} from './drizzle-transactional.adapter.js';

describe('normalizeTxConfig', () => {
  it('drops configs without an effective setting', () => {
    expect(normalizeTxConfig(undefined)).toBeUndefined();
    expect(normalizeTxConfig({})).toBeUndefined();
    expect(normalizeTxConfig({ isolationLevel: undefined, accessMode: undefined })).toBeUndefined();
  });

  it('keeps real settings (without the undefined keys)', () => {
    expect(normalizeTxConfig({ isolationLevel: 'serializable', accessMode: undefined })).toEqual({
      isolationLevel: 'serializable',
    });
    expect(normalizeTxConfig({ deferrable: false })).toEqual({ deferrable: false });
  });
});

describe('DrizzlePostgresTransactionalAdapter', () => {
  const setup = (): {
    sql: ReturnType<typeof createFakeSql>;
    options: ReturnType<DrizzlePostgresTransactionalAdapter['optionsFactory']>;
  } => {
    const sql = createFakeSql(() => []);
    const db = drizzle({ client: sql as never }) as unknown as DrizzleDB;
    const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
    return { sql, options: adapter.optionsFactory(db) };
  };

  it('keeps the connection token and fallback instance of the stock adapter', () => {
    const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
    expect(adapter.connectionToken).toBe('DB');
    const db = { transaction: vi.fn() } as unknown as DrizzleDB;
    expect(adapter.optionsFactory(db).getFallbackInstance()).toBe(db);
  });

  it('opens a plain BEGIN for an empty merged config (no bare "set transaction")', async () => {
    const { sql, options } = setup();
    const setClient = vi.fn();
    await options.wrapWithTransaction({}, async () => 'done', setClient);
    expect(sql.queries).toEqual(['begin', 'commit']);
    expect(setClient).toHaveBeenCalledTimes(1);
  });

  it('still sends SET TRANSACTION for real settings', async () => {
    const { sql, options } = setup();
    await options.wrapWithTransaction(
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
      async () => undefined,
      vi.fn(),
    );
    expect(sql.queries).toEqual([
      'begin',
      'set transaction isolation level repeatable read read only',
      'commit',
    ]);
  });
});
