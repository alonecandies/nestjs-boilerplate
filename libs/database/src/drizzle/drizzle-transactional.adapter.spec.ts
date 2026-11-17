import {
  CLS_PRINCIPAL,
  createPrincipal,
  type Principal,
  runWithPrincipal,
  SystemContext,
  setPrincipal,
} from '@platform/common';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import { getAppliedRlsContext } from '../rls/rls-context.js';
import type { DrizzleDB, DrizzleTransaction } from './drizzle.types.js';
import {
  DrizzlePostgresTransactionalAdapter,
  normalizeTxConfig,
} from './drizzle-transactional.adapter.js';
import { preferPreparedStatements } from './prepared-statements.js';

const USER = '0197a000-0000-7000-8000-00000000000a';
const OTHER_USER = '0197a000-0000-7000-8000-00000000000b';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const OTHER_TENANT = '0197a000-0000-7000-8000-0000000000b2';
const CONTEXT =
  `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
  `SET LOCAL app.elevated = 'off'`;

const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const cls = ClsServiceManager.getClsService();

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
  const setup = ({ prepared = false }: { prepared?: boolean } = {}) => {
    const sql = createFakeSql(() => []);
    const client = prepared ? preferPreparedStatements(sql as never) : sql;
    const db = drizzle({ client: client as never }) as unknown as DrizzleDB;
    const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
    return { sql, options: adapter.optionsFactory(db) };
  };
  type Options = ReturnType<typeof setup>['options'];

  /** One transaction whose work runs `select 2` on the transaction it was handed. */
  const transaction = (options: Options, config: Parameters<Options['wrapWithTransaction']>[0]) => {
    let tx: DrizzleTransaction | undefined;
    const setClient = vi.fn((client: unknown) => {
      tx = client as DrizzleTransaction;
    });
    const run = options.wrapWithTransaction(
      config,
      async () => {
        await tx?.execute(drizzleSql`select 2`);
        return 'done';
      },
      setClient,
    );
    return { run, setClient };
  };

  /** Keeps the transaction `setClient` receives (drizzle hands it over before the work runs). */
  const txHolder = () => {
    let held: DrizzleDB | undefined;
    return {
      set: (client?: DrizzleDB): void => {
        held = client;
      },
      get: (): DrizzleDB => {
        if (held === undefined) throw new Error('setClient was not called');
        return held;
      },
    };
  };

  it('keeps the connection token and fallback instance of the stock adapter', () => {
    const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
    expect(adapter.connectionToken).toBe('DB');
    const db = { transaction: vi.fn() } as unknown as DrizzleDB;
    expect(adapter.optionsFactory(db).getFallbackInstance()).toBe(db);
  });

  describe('the RLS context on BEGIN', () => {
    it('sends begin, then ONE simple-protocol context statement, then the work', async () => {
      const { sql, options } = setup();
      const { run, setClient } = runWithPrincipal(member, () => transaction(options, {}));
      await expect(run).resolves.toBe('done');
      expect(sql.queries).toEqual(['begin', CONTEXT, 'select 2', 'commit']);
      expect(sql.statements.filter((statement) => statement.simple)).toEqual([
        { text: CONTEXT, simple: true },
      ]);
      expect(setClient).toHaveBeenCalledTimes(1);
    });

    it('takes the simple protocol also through preferPreparedStatements (prepare: true)', async () => {
      const { sql, options } = setup({ prepared: true });
      const { run } = runWithPrincipal(member, () => transaction(options, undefined));
      await run;
      expect(sql.queries).toEqual(['begin', CONTEXT, 'select 2', 'commit']);
      expect(sql.statements[1]).toEqual({ text: CONTEXT, simple: true });
    });

    it('sends an empty tenant for a tenant-less principal', async () => {
      const { sql, options } = setup();
      const userOnly = createPrincipal({ userId: USER, tenantId: null });
      await runWithPrincipal(userOnly, () => transaction(options, {}).run);
      expect(sql.queries[1]).toBe(
        `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = ''; ` +
          `SET LOCAL app.elevated = 'off'`,
      );
    });

    it('keeps drizzle order with real settings: begin, set transaction, context, work', async () => {
      const { sql, options } = setup();
      const { run } = runWithPrincipal(member, () =>
        transaction(options, { isolationLevel: 'repeatable read', accessMode: 'read only' }),
      );
      await run;
      expect(sql.queries).toEqual([
        'begin',
        'set transaction isolation level repeatable read read only',
        CONTEXT,
        'select 2',
        'commit',
      ]);
    });

    it('rejects with RLS_NO_PRINCIPAL before BEGIN, with no CLS context or no principal in it', async () => {
      const { sql, options } = setup();
      await expect(transaction(options, {}).run).rejects.toMatchObject({
        name: 'RlsContextError',
        code: 'RLS_NO_PRINCIPAL',
      });
      await expect(cls.run(() => transaction(options, {}).run)).rejects.toMatchObject({
        code: 'RLS_NO_PRINCIPAL',
      });
      // SystemContext clears the principal (also under a parent that has one): no runtime work.
      await expect(
        runWithPrincipal(member, () =>
          SystemContext.run('fixture.job', () => transaction(options, {}).run),
        ),
      ).rejects.toMatchObject({ code: 'RLS_NO_PRINCIPAL' });
      expect(sql.begin).not.toHaveBeenCalled();
      expect(sql.queries).toEqual([]);
    });

    it('rejects an invalid principal before BEGIN (and never sends its text)', async () => {
      const { sql, options } = setup();
      // Built by hand: createPrincipal would refuse these values first.
      const forged = (userId: string, tenantId: string | null): Principal => ({
        userId,
        tenantId,
        roles: [],
        staff: false,
      });
      await expect(
        runWithPrincipal(
          forged("x'; SET ROLE app_owner; --", TENANT),
          () => transaction(options, {}).run,
        ),
      ).rejects.toMatchObject({ code: 'RLS_INVALID_USER_ID' });
      await expect(
        runWithPrincipal(
          forged(USER, '00000000-0000-0000-0000-000000000000'),
          () => transaction(options, {}).run,
        ),
      ).rejects.toMatchObject({ code: 'RLS_PLATFORM_TENANT' });
      expect(sql.begin).not.toHaveBeenCalled();
      expect(sql.queries).toEqual([]);
    });

    it('a savepoint sends no context statement', async () => {
      const { sql, options } = setup();
      const outer = txHolder();
      await runWithPrincipal(member, () =>
        options.wrapWithTransaction(
          {},
          () => options.wrapWithNestedTransaction({}, async () => 'inner', vi.fn(), outer.get()),
          outer.set,
        ),
      );
      expect(sql.queries).toEqual(['begin', CONTEXT, 'savepoint', 'release savepoint', 'commit']);
      expect(sql.statements.filter((statement) => statement.simple)).toHaveLength(1);
    });

    it('a savepoint under another principal rejects with RLS_CONTEXT_STALE and rolls back', async () => {
      const { sql, options } = setup();
      const outer = txHolder();
      const work = vi.fn(async () => 'inner');
      await expect(
        runWithPrincipal(member, () =>
          options.wrapWithTransaction(
            {},
            () =>
              runWithPrincipal(
                createPrincipal({ userId: OTHER_USER, tenantId: TENANT, roles: ['member'] }),
                () => options.wrapWithNestedTransaction({}, work, vi.fn(), outer.get()),
              ),
            outer.set,
          ),
        ),
      ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
      expect(work).not.toHaveBeenCalled();
      expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
    });

    it.each([
      [
        'another user',
        createPrincipal({ userId: OTHER_USER, tenantId: TENANT, roles: ['member'] }),
      ],
      ['another tenant', createPrincipal({ userId: USER, tenantId: OTHER_TENANT })],
      ['no tenant', createPrincipal({ userId: USER, tenantId: null })],
    ])(
      'setPrincipal to %s before COMMIT rolls back with RLS_CONTEXT_STALE',
      async (_label, next) => {
        const { sql, options } = setup();
        await expect(
          runWithPrincipal(member, () =>
            options.wrapWithTransaction(
              {},
              async () => {
                setPrincipal(next);
              },
              vi.fn(),
            ),
          ),
        ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
        expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
      },
    );

    it('clearing the principal before COMMIT rolls back too', async () => {
      const { sql, options } = setup();
      await expect(
        runWithPrincipal(member, () =>
          options.wrapWithTransaction(
            {},
            async () => {
              cls.set(CLS_PRINCIPAL, undefined);
            },
            vi.fn(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
      expect(sql.queries.at(-1)).toBe('rollback');
    });

    it('the same principal re-set (an equal value, other case) still commits', async () => {
      const { sql, options } = setup();
      await runWithPrincipal(member, () =>
        options.wrapWithTransaction(
          {},
          async () => {
            setPrincipal(
              createPrincipal({
                userId: USER.toUpperCase(),
                tenantId: TENANT.toUpperCase(),
                roles: ['admin'],
              }),
            );
          },
          vi.fn(),
        ),
      );
      expect(sql.queries).toEqual(['begin', CONTEXT, 'commit']);
    });

    it('getAppliedRlsContext() is undefined outside a transaction', async () => {
      const { options } = setup();
      expect(getAppliedRlsContext()).toBeUndefined();
      await runWithPrincipal(member, () => transaction(options, {}).run);
      expect(getAppliedRlsContext()).toBeUndefined();
      expect(runWithPrincipal(member, () => getAppliedRlsContext())).toBeUndefined();
    });
  });
});
