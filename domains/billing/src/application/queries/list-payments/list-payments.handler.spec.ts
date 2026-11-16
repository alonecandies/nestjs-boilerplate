import { TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId } from '@platform/common';
import { createMock, type Mocked } from '@platform/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { makePayment } from '../../../../test/billing-test.utils.js';
import type { PaymentsRepository } from '../../repositories/payments.repository.js';
import { ListPaymentsHandler } from './list-payments.handler.js';
import { ListPaymentsQuery } from './list-payments.query.js';

describe('ListPaymentsHandler', () => {
  let repository: Mocked<PaymentsRepository>;
  let handler: ListPaymentsHandler;

  beforeEach(() => {
    repository = createMock<PaymentsRepository>();
    repository.list.mockResolvedValue({ items: [], nextCursor: null });
    handler = new ListPaymentsHandler(repository);
  });

  it('lists one user’s payments as contracts', async () => {
    const userId = generateId();
    const payment = makePayment({ userId, amountTotal: 1_250, currency: 'eur' });
    repository.list.mockResolvedValue({ items: [payment], nextCursor: null });

    const result = await handler.execute(
      new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId, limit: 5 }),
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

    const result = await handler.execute(
      new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId, limit: 1, cursor: 'c1' }),
    );

    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId,
      limit: 1,
      cursor: 'c1',
    });
    expect(result.nextCursor).toBe('c2');
  });

  it('lists every user of the tenant when no owner is given', async () => {
    await handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit: 10 }));
    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: undefined,
      limit: 10,
      cursor: undefined,
    });
  });

  it.each([
    [undefined, 20],
    [0, 20], // proto3 "not set"
    [-3, 20],
    [2.5, 20],
    [1, 1],
    [500, 100],
  ])('normalises limit %s → %s', async (limit, expected) => {
    await handler.execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, limit }));
    expect(repository.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: undefined,
      limit: expected,
      cursor: undefined,
    });
  });
});
