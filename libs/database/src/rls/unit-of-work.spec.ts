import { Propagation, TransactionHost } from '@nestjs-cls/transactional';
import { createPrincipal, runWithPrincipal } from '@platform/common';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import type { DrizzleDB, DrizzleTransactionHost } from '../drizzle/drizzle.types.js';
import { DrizzlePostgresTransactionalAdapter } from '../drizzle/drizzle-transactional.adapter.js';
import { getAppliedRlsContext } from './rls-context.js';
import { inUnitOfWork } from './unit-of-work.js';

const USER = '0197a000-0000-7000-8000-00000000000a';
const OTHER_USER = '0197a000-0000-7000-8000-00000000000b';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const CONTEXT =
  `SET LOCAL app.user_id = '${USER}'; SET LOCAL app.tenant_id = '${TENANT}'; ` +
  `SET LOCAL app.elevated = 'off'`;
const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const other = createPrincipal({ userId: OTHER_USER, tenantId: TENANT, roles: ['member'] });

/** A real TransactionHost (what ClsPluginTransactional provides) over the adapter and a fake pool. */
function setup() {
  const sql = createFakeSql(() => []);
  const db = drizzle({ client: sql as never }) as unknown as DrizzleDB;
  const adapter = new DrizzlePostgresTransactionalAdapter({ drizzleInstanceToken: 'DB' });
  const txHost = new TransactionHost({
    ...adapter.optionsFactory(db),
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
  } as never) as unknown as DrizzleTransactionHost;
  return { sql, db, txHost };
}

describe('inUnitOfWork', () => {
  it('opens one transaction for a standalone call and hands work the transaction', async () => {
    const { sql, db, txHost } = setup();
    const result = await runWithPrincipal(member, () =>
      inUnitOfWork(txHost, async (tx) => {
        expect(tx).not.toBe(db);
        expect(getAppliedRlsContext()).toEqual({ userId: USER, tenantId: TENANT });
        await tx.execute(drizzleSql`select 2`);
        return 'done';
      }),
    );
    expect(result).toBe('done');
    expect(sql.queries).toEqual(['begin', CONTEXT, 'select 2', 'commit']);
    expect(getAppliedRlsContext()).toBeUndefined();
  });

  it('joins the open transaction inside withTransaction (one BEGIN, one context)', async () => {
    const { sql, txHost } = setup();
    await runWithPrincipal(member, () =>
      txHost.withTransaction(async () => {
        const outer = txHost.tx;
        await inUnitOfWork(txHost, async (tx) => {
          expect(tx).toBe(outer);
          await tx.execute(drizzleSql`select 2`);
        });
        await inUnitOfWork(txHost, (tx) => tx.execute(drizzleSql`select 3`));
      }),
    );
    expect(sql.queries).toEqual(['begin', CONTEXT, 'select 2', 'select 3', 'commit']);
  });

  it('runWithPrincipal(other, …) inside an open transaction throws RLS_CONTEXT_STALE without running work', async () => {
    const { sql, txHost } = setup();
    const work = vi.fn(async () => 'never');
    await expect(
      runWithPrincipal(member, () =>
        txHost.withTransaction(() => runWithPrincipal(other, () => inUnitOfWork(txHost, work))),
      ),
    ).rejects.toMatchObject({ name: 'RlsContextError', code: 'RLS_CONTEXT_STALE' });
    expect(work).not.toHaveBeenCalled();
    expect(sql.queries).toEqual(['begin', CONTEXT, 'rollback']);
  });

  it('refuses to open a transaction without a principal (RLS_NO_PRINCIPAL, no BEGIN)', async () => {
    const { sql, txHost } = setup();
    const work = vi.fn(async () => 'never');
    await expect(inUnitOfWork(txHost, work)).rejects.toMatchObject({ code: 'RLS_NO_PRINCIPAL' });
    expect(work).not.toHaveBeenCalled();
    expect(sql.queries).toEqual([]);
  });
});

describe('getAppliedRlsContext (with a TransactionHost)', () => {
  it('follows the transaction: savepoints keep it, NotSupported has none, RequiresNew has its own', async () => {
    const { sql, txHost } = setup();
    const seen: Record<string, unknown> = {};
    await runWithPrincipal(member, () =>
      txHost.withTransaction(async () => {
        seen['outer'] = getAppliedRlsContext();
        await txHost.withTransaction(Propagation.Nested, async () => {
          seen['savepoint'] = getAppliedRlsContext();
        });
        await txHost.withTransaction(Propagation.NotSupported, async () => {
          seen['notSupported'] = getAppliedRlsContext();
        });
        await txHost.withTransaction(Propagation.RequiresNew, async () => {
          seen['requiresNew'] = getAppliedRlsContext();
        });
      }),
    );
    const applied = { userId: USER, tenantId: TENANT };
    expect(seen).toEqual({
      outer: applied,
      savepoint: applied,
      notSupported: undefined,
      requiresNew: applied,
    });
    // The savepoint sent nothing; RequiresNew is its own BEGIN with its own context.
    expect(sql.queries).toEqual([
      'begin',
      CONTEXT,
      'savepoint',
      'release savepoint',
      'begin',
      CONTEXT,
      'commit',
      'commit',
    ]);
  });
});
