import { Logger } from '@nestjs/common';
import { Propagation, TransactionHost } from '@nestjs-cls/transactional';
import {
  createPrincipal,
  type Principal,
  PrincipalPermissions,
  runWithPrincipal,
} from '@platform/common';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql, type FakeSqlHandler } from '../../test/fake-sql.js';
import type { DrizzleDB, DrizzleTransactionHost } from '../drizzle/drizzle.types.js';
import { DrizzlePostgresTransactionalAdapter } from '../drizzle/drizzle-transactional.adapter.js';
import { ELEVATION_REASONS, type ElevationReason, RlsElevation } from './rls-elevation.service.js';

const inc = vi.fn();
vi.mock('@platform/observability', () => ({
  getOrCreateCounter: () => ({ inc: (...args: unknown[]) => inc(...args) }),
}));

const USER = '0197a000-0000-7000-8000-00000000000a';
const OTHER_USER = '0197a000-0000-7000-8000-00000000000b';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const CONTEXT =
  `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
  `SET LOCAL app.elevated = 'off'`;
const ON = "SET LOCAL app.elevated = 'on'";
const OFF = "SET LOCAL app.elevated = 'off'";

const admin = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['admin'] });
const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const otherAdmin = createPrincipal({ userId: OTHER_USER, tenantId: TENANT, roles: ['admin'] });
const tenantless = createPrincipal({ userId: USER, tenantId: null });

/** admin ⊇ member, as the registry would resolve them; `orders:raed` is declared by nobody. */
class StubPermissions extends PrincipalPermissions {
  readonly of = vi.fn((principal: Principal): readonly string[] =>
    principal.roles.includes('admin') ? ['orders:approve', 'orders:read'] : ['orders:read'],
  );
}

/** A real TransactionHost (what ClsPluginTransactional provides) over the adapter and a fake pool. */
function setup(handler: FakeSqlHandler = () => []) {
  const sql = createFakeSql(handler);
  const db = drizzle({ client: sql as never }) as unknown as DrizzleDB;
  const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
  const txHost = new TransactionHost({
    ...adapter.optionsFactory(db),
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
  } as never) as unknown as DrizzleTransactionHost;
  const permissions = new StubPermissions();
  const elevation = new RlsElevation(permissions);
  /** `work` in a transaction opened as `principal`. */
  const inTransaction = <T>(principal: Principal, work: () => Promise<T>): Promise<T> =>
    runWithPrincipal(principal, () => txHost.withTransaction(work));
  return { sql, txHost, permissions, elevation, inTransaction };
}

describe('RlsElevation', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    inc.mockClear();
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
  });

  describe('elevate(permission)', () => {
    it('sends one constant SET LOCAL app.elevated = on (simple protocol) when the permission is held', async () => {
      const { sql, elevation, inTransaction } = setup();
      await inTransaction(admin, async () => {
        await elevation.elevate('orders:approve');
      });
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, 'commit']);
      expect(sql.statements.find((statement) => statement.text === ON)?.simple).toBe(true);
      expect(inc).toHaveBeenCalledTimes(1);
      expect(inc).toHaveBeenCalledWith({ kind: 'permission', name: 'orders:approve' });
      expect(log).toHaveBeenCalledWith(
        { elevation: 'orders:approve', kind: 'permission', userId: USER, tenantId: TENANT },
        'RLS elevation',
      );
    });

    it('stays on for the rest of the transaction and never touches app.tenant_id', async () => {
      const { sql, txHost, elevation, inTransaction } = setup();
      await inTransaction(admin, async () => {
        await elevation.elevate('orders:read');
        await txHost.tx.execute(drizzleSql`select 2`);
      });
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, 'select 2', 'commit']);
      expect(sql.queries.filter((query) => query.includes('app.tenant_id'))).toEqual([CONTEXT]);
    });

    it.each([
      ['a permission the principal does not hold', member, 'orders:approve'],
      ['an undeclared permission', admin, 'orders:raed'],
    ])('rejects %s (ELEVATION_DENIED) and sends nothing', async (_name, principal, permission) => {
      const { sql, elevation, inTransaction } = setup();
      await expect(
        inTransaction(principal, () => elevation.elevate(permission)),
      ).rejects.toMatchObject({ code: 'ELEVATION_DENIED', httpStatus: 403 });
      expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
      expect(inc).not.toHaveBeenCalled();
    });

    it('rejects a tenant-less principal even when its permissions would match (ELEVATION_DENIED)', async () => {
      const { sql, permissions, elevation, inTransaction } = setup();
      permissions.of.mockReturnValue(['orders:read']);
      await expect(
        inTransaction(tenantless, () => elevation.elevate('orders:read')),
      ).rejects.toMatchObject({ code: 'ELEVATION_DENIED' });
      expect(sql.queries).toEqual([
        'begin',
        `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = ''; SET LOCAL app.elevated = 'off'`,
        'rollback',
      ]);
    });

    it('rejects without a principal (RLS_NO_PRINCIPAL) and sends nothing', async () => {
      const { sql, elevation } = setup();
      await expect(elevation.elevate('orders:read')).rejects.toMatchObject({
        name: 'RlsContextError',
        code: 'RLS_NO_PRINCIPAL',
      });
      expect(sql.queries).toEqual([]);
    });

    it('rejects outside a transaction (RLS_NO_TRANSACTION) and sends nothing', async () => {
      const { sql, elevation } = setup();
      await expect(
        runWithPrincipal(admin, () => elevation.elevate('orders:read')),
      ).rejects.toMatchObject({ name: 'RlsContextError', code: 'RLS_NO_TRANSACTION' });
      expect(sql.queries).toEqual([]);
    });

    it('rejects outside a transaction under NotSupported too (RLS_NO_TRANSACTION)', async () => {
      const { sql, txHost, elevation } = setup();
      await expect(
        runWithPrincipal(admin, () =>
          txHost.withTransaction(() =>
            txHost.withTransaction(Propagation.NotSupported, () =>
              elevation.elevate('orders:read'),
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: 'RLS_NO_TRANSACTION' });
      expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
    });

    it('rejects a stale context (RLS_CONTEXT_STALE) and sends nothing', async () => {
      const { sql, elevation, inTransaction } = setup();
      await expect(
        inTransaction(admin, () =>
          runWithPrincipal(otherAdmin, () => elevation.elevate('orders:read')),
        ),
      ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
      expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
    });

    it('rejects when no PrincipalPermissions is bound and sends nothing', async () => {
      const { sql, inTransaction } = setup();
      const unbound = new RlsElevation(undefined);
      await expect(inTransaction(admin, () => unbound.elevate('orders:read'))).rejects.toThrow(
        /PrincipalPermissions is not bound/,
      );
      expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
    });

    it.each([[''], [undefined], [42]])(
      'rejects a non-permission argument %j (ELEVATION_DENIED) without asking for permissions',
      async (permission) => {
        const { sql, permissions, elevation, inTransaction } = setup();
        await expect(
          inTransaction(admin, () => elevation.elevate(permission as never)),
        ).rejects.toMatchObject({ code: 'ELEVATION_DENIED' });
        expect(permissions.of).not.toHaveBeenCalled();
        expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
      },
    );
  });

  describe('justified(reason, work)', () => {
    it('lists the closed set of reasons, frozen', () => {
      expect(ELEVATION_REASONS).toEqual([
        'tenant-bootstrap',
        'verified-invitation',
        'membership-activity',
      ]);
      expect(Object.isFrozen(ELEVATION_REASONS)).toBe(true);
    });

    it.each([
      ['an unknown reason', 'because'],
      ['a near miss', 'membership-activity '],
      ['a permission name', 'orders:read'],
      ['a non-string', 42],
    ])(
      'rejects %s (ELEVATION_DENIED) without running work or sending anything',
      async (_name, reason) => {
        const { sql, elevation, inTransaction } = setup();
        const work = vi.fn(async () => 'never');
        await expect(
          inTransaction(member, () => elevation.justified(reason as ElevationReason, work)),
        ).rejects.toMatchObject({ code: 'ELEVATION_DENIED' });
        expect(work).not.toHaveBeenCalled();
        expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
      },
    );

    it('sends on, runs work, sends off, and returns what work returned (no permission asked)', async () => {
      const { sql, txHost, permissions, elevation, inTransaction } = setup();
      const result = await inTransaction(member, async () => {
        const value = await elevation.justified('membership-activity', async () => {
          await txHost.tx.execute(drizzleSql`select 2`);
          return 'touched';
        });
        await txHost.tx.execute(drizzleSql`select 3`);
        return value;
      });
      expect(result).toBe('touched');
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, 'select 2', OFF, 'select 3', 'commit']);
      expect(
        sql.statements.filter((s) => s.text === ON || s.text === OFF).map((s) => s.simple),
      ).toEqual([true, true]);
      expect(permissions.of).not.toHaveBeenCalled();
      expect(inc).toHaveBeenCalledWith({ kind: 'justified', name: 'membership-activity' });
      expect(log).toHaveBeenCalledWith(
        { elevation: 'membership-activity', kind: 'justified', userId: USER, tenantId: TENANT },
        'RLS elevation',
      );
    });

    it('sends off also when work throws, and rethrows the error of work', async () => {
      const { sql, elevation, inTransaction } = setup();
      const boom = new Error('boom');
      await expect(
        inTransaction(member, async () => {
          await expect(
            elevation.justified('verified-invitation', async () => {
              throw boom;
            }),
          ).rejects.toBe(boom);
        }),
      ).resolves.toBeUndefined();
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, OFF, 'commit']);
    });

    it('rethrows the error of work when the off statement fails too (an aborted transaction)', async () => {
      const aborted = new Error('current transaction is aborted');
      const { sql, elevation, inTransaction } = setup((query) => {
        if (query === OFF) throw aborted;
        return [];
      });
      const boom = new Error('boom');
      await expect(
        inTransaction(member, () =>
          elevation.justified('tenant-bootstrap', async () => {
            throw boom;
          }),
        ),
      ).rejects.toBe(boom);
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, OFF, 'rollback']);
    });

    it('fails (and rolls back) when the off statement fails after work succeeded', async () => {
      const broken = new Error('connection lost');
      const { sql, elevation, inTransaction } = setup((query) => {
        if (query === OFF) throw broken;
        return [];
      });
      await expect(
        inTransaction(member, () => elevation.justified('tenant-bootstrap', async () => 'done')),
      ).rejects.toBe(broken);
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, OFF, 'rollback']);
    });

    it('refuses like elevate: no transaction, no principal, a stale context, a tenant-less principal', async () => {
      const { sql, elevation, inTransaction } = setup();
      const work = vi.fn(async () => 'never');
      await expect(elevation.justified('membership-activity', work)).rejects.toMatchObject({
        code: 'RLS_NO_PRINCIPAL',
      });
      await expect(
        runWithPrincipal(member, () => elevation.justified('membership-activity', work)),
      ).rejects.toMatchObject({ code: 'RLS_NO_TRANSACTION' });
      expect(sql.queries).toEqual([]);
      await expect(
        inTransaction(member, () =>
          runWithPrincipal(otherAdmin, () => elevation.justified('membership-activity', work)),
        ),
      ).rejects.toMatchObject({ code: 'RLS_CONTEXT_STALE' });
      await expect(
        inTransaction(tenantless, () => elevation.justified('membership-activity', work)),
      ).rejects.toMatchObject({ code: 'ELEVATION_DENIED' });
      expect(work).not.toHaveBeenCalled();
      expect(sql.queries.filter((query) => query === ON)).toEqual([]);
    });

    it('nests: one on for the outermost call, one off when the outermost returns', async () => {
      const { sql, txHost, elevation, inTransaction } = setup();
      await inTransaction(member, () =>
        elevation.justified('tenant-bootstrap', async () => {
          await elevation.justified('membership-activity', () =>
            txHost.tx.execute(drizzleSql`select 2`),
          );
          await txHost.tx.execute(drizzleSql`select 3`);
        }),
      );
      expect(sql.queries).toEqual(['begin', CONTEXT, ON, 'select 2', 'select 3', OFF, 'commit']);
    });

    it('leaves an elevate(permission) of the same transaction on (before or inside work)', async () => {
      const before = setup();
      await before.inTransaction(admin, async () => {
        await before.elevation.elevate('orders:read');
        await before.elevation.justified('membership-activity', () =>
          before.txHost.tx.execute(drizzleSql`select 2`),
        );
      });
      expect(before.sql.queries).toEqual(['begin', CONTEXT, ON, 'select 2', 'commit']);

      const inside = setup();
      await inside.inTransaction(admin, () =>
        inside.elevation.justified('membership-activity', () =>
          inside.elevation.elevate('orders:read'),
        ),
      );
      expect(inside.sql.queries).toEqual(['begin', CONTEXT, ON, ON, 'commit']);
    });

    it('keeps the state per transaction: a savepoint shares it, RequiresNew starts off', async () => {
      const { sql, txHost, elevation, inTransaction } = setup();
      await inTransaction(admin, async () => {
        await elevation.elevate('orders:read');
        await txHost.withTransaction(Propagation.Nested, () =>
          elevation.justified('membership-activity', () => txHost.tx.execute(drizzleSql`select 2`)),
        );
        await txHost.withTransaction(Propagation.RequiresNew, () =>
          elevation.justified('membership-activity', () => txHost.tx.execute(drizzleSql`select 3`)),
        );
      });
      expect(sql.queries).toEqual([
        'begin',
        CONTEXT,
        ON,
        'savepoint',
        'select 2',
        'release savepoint',
        'begin',
        CONTEXT,
        ON,
        'select 3',
        OFF,
        'commit',
        'commit',
      ]);
    });
  });
});
