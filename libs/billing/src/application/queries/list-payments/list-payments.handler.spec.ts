import { generateId } from '@app/common';
import { createMock, type Mocked } from '@app/testing';
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
    repository.list.mockResolvedValue([]);
    handler = new ListPaymentsHandler(repository);
  });

  it('lists one user’s payments as contracts', async () => {
    const userId = generateId();
    const payment = makePayment({ userId, amountTotal: 1_250, currency: 'eur' });
    repository.list.mockResolvedValue([payment]);

    const result = await handler.execute(new ListPaymentsQuery({ userId, limit: 5 }));

    expect(repository.list).toHaveBeenCalledWith({ userId, limit: 5 });
    expect(result.items).toEqual([
      expect.objectContaining({ id: payment.id, userId, amountTotal: '1250', currency: 'eur' }),
    ]);
  });

  it('lists every user when no owner is given', async () => {
    await handler.execute(new ListPaymentsQuery({ limit: 10 }));
    expect(repository.list).toHaveBeenCalledWith({ userId: undefined, limit: 10 });
  });

  it.each([
    [undefined, 20],
    [0, 20], // proto3 "not set"
    [-3, 20],
    [2.5, 20],
    [1, 1],
    [500, 100],
  ])('normalises limit %s → %s', async (limit, expected) => {
    await handler.execute(new ListPaymentsQuery({ limit }));
    expect(repository.list).toHaveBeenCalledWith({ userId: undefined, limit: expected });
  });
});
