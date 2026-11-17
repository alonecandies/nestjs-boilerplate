import { createTestRbacRegistry, TEST_TENANT_ID } from '@platform/auth/testing';
import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import type { RlsElevation } from '@platform/database';
import { createMock, type Mocked } from '@platform/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryBillingStore,
  InMemoryPaymentsRepository,
  installTestTransactionHost,
  makePayment,
  type TestTransactions,
} from '../../../../test/billing-test.utils.js';
import { BILLING_RBAC, BillingPermission } from '../../../billing.permissions.js';
import type { PaymentsRepository } from '../../repositories/payments.repository.js';
import { ListPaymentsHandler } from './list-payments.handler.js';
import { ListPaymentsQuery } from './list-payments.query.js';

const as = <T>(principal: { userId: string; tenantId: string; roles: TenantRole[] }, fn: () => T) =>
  runWithPrincipal(createPrincipal(principal), fn);

describe('ListPaymentsHandler', () => {
  let repository: Mocked<PaymentsRepository>;
  let elevation: Mocked<RlsElevation>;
  let tx: TestTransactions;
  /** What happened, in order: transactions, elevations and repository reads. */
  let trail: string[];
  let handler: ListPaymentsHandler;

  beforeEach(() => {
    tx = installTestTransactionHost();
    trail = [];
    repository = createMock<PaymentsRepository>();
    repository.list.mockImplementation(async () => {
      trail.push(tx.active ? 'list in tx' : 'list');
      return { items: [], nextCursor: null };
    });
    elevation = createMock<RlsElevation>();
    elevation.elevate.mockImplementation(async (permission) => {
      trail.push(tx.active ? `elevate ${permission} in tx` : `elevate ${permission}`);
    });
    handler = new ListPaymentsHandler(
      repository,
      elevation as unknown as RlsElevation,
      createTestRbacRegistry(BILLING_RBAC),
    );
  });

  it('lists one user’s payments as contracts', async () => {
    const userId = generateId();
    const payment = makePayment({ userId, amountTotal: 1_250, currency: 'eur' });
    repository.list.mockResolvedValue({ items: [payment], nextCursor: null });

    const result = await as({ userId, tenantId: TEST_TENANT_ID, roles: ['member'] }, () =>
      handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId, limit: 5 })),
    );

    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId,
      limit: 5,
      cursor: undefined,
    });
    expect(result.items).toEqual([
      expect.objectContaining({ id: payment.id, userId, amountTotal: '1250', currency: 'eur' }),
    ]);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('passes the cursor through and returns the next page cursor', async () => {
    const userId = generateId();
    repository.list.mockResolvedValue({ items: [makePayment({ userId })], nextCursor: 'c2' });

    const result = await as({ userId, tenantId: TEST_TENANT_ID, roles: ['member'] }, () =>
      handler.execute(
        new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId, limit: 1, cursor: 'c1' }),
      ),
    );

    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId,
      limit: 1,
      cursor: 'c1',
    });
    expect(result.nextCursor).toBe('c2');
  });

  const admin = () => ({
    userId: generateId(),
    tenantId: TEST_TENANT_ID,
    roles: ['admin' as const],
  });

  it('lists the whole active tenant when no owner is given', async () => {
    await as(admin(), () =>
      handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit: 10 })),
    );
    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: undefined,
      limit: 10,
      cursor: undefined,
    });
  });

  it('with billing:read-all: elevate(billing:read-all) first, then the read, in one unit of work', async () => {
    await as(admin(), () =>
      handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit: 10 })),
    );
    expect(trail).toEqual([`elevate ${BillingPermission.ReadAll} in tx`, 'list in tx']);
    expect(elevation.elevate).toHaveBeenCalledTimes(1);
    expect(tx.begun).toBe(1);
  });

  it('own payments: one unit of work, never elevated (also for an admin)', async () => {
    const principal = admin();
    await as(principal, () =>
      handler.execute(
        new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId: principal.userId, limit: 10 }),
      ),
    );
    expect(trail).toEqual(['list in tx']);
    expect(elevation.elevate).not.toHaveBeenCalled();
    expect(tx.begun).toBe(1);
  });

  it('a refused elevation fails the request and reads nothing', async () => {
    elevation.elevate.mockRejectedValueOnce(new Error('ELEVATION_DENIED'));
    await expect(
      as(admin(), () =>
        handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit: 10 })),
      ),
    ).rejects.toThrow('ELEVATION_DENIED');
    expect(repository.list).not.toHaveBeenCalled();
    expect(tx.rolledBack).toBe(1);
  });

  it.each([
    [undefined, 20],
    [0, 20], // proto3 "not set"
    [-3, 20],
    [2.5, 20],
    [1, 1],
    [500, 100],
  ])('normalises limit %s → %s', async (limit, expected) => {
    await as(admin(), () =>
      handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit })),
    );
    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: undefined,
      limit: expected,
      cursor: undefined,
    });
  });
});

describe('tenant scope (B2-26)', () => {
  const tenantA = TEST_TENANT_ID;
  const tenantB = generateId();
  const ada = generateId();
  const bob = generateId();
  let store: InMemoryBillingStore;
  let tx: TestTransactions;
  let elevation: Mocked<RlsElevation>;
  let scoped: ListPaymentsHandler;

  beforeEach(() => {
    store = new InMemoryBillingStore();
    tx = installTestTransactionHost(store);
    elevation = createMock<RlsElevation>();
    elevation.elevate.mockResolvedValue(undefined);
    scoped = new ListPaymentsHandler(
      new InMemoryPaymentsRepository(store),
      elevation as unknown as RlsElevation,
      createTestRbacRegistry(BILLING_RBAC),
    );
    store.seed(
      makePayment({ tenantId: tenantA, userId: ada }),
      makePayment({ tenantId: tenantA, userId: bob }),
      makePayment({ tenantId: tenantB, userId: ada }),
    );
  });

  it("all (no userId) lists the whole tenant for an admin, never another tenant's rows", async () => {
    const page = await as({ userId: ada, tenantId: tenantA, roles: ['admin'] }, () =>
      scoped.execute(new ListPaymentsQuery({ tenantId: tenantA, limit: 10 })),
    );
    expect(page.items.map((p) => p.tenantId)).toEqual([tenantA, tenantA]);
  });

  it('403 for all without billing:read-all, recomputed from the principal roles (service side)', async () => {
    await expect(
      as({ userId: ada, tenantId: tenantA, roles: ['member'] }, () =>
        scoped.execute(new ListPaymentsQuery({ tenantId: tenantA, limit: 10 })),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { required: ['billing:read-all'] } });
    // Refused in TypeScript before any unit of work opens.
    expect(tx.begun).toBe(0);
    expect(elevation.elevate).not.toHaveBeenCalled();
  });

  it('403 TENANT_MISMATCH when the request names a tenant the principal is not acting in', async () => {
    await expect(
      as({ userId: ada, tenantId: tenantA, roles: ['owner'] }, () =>
        scoped.execute(new ListPaymentsQuery({ tenantId: tenantB, userId: ada, limit: 10 })),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(tx.begun).toBe(0);
  });
});
