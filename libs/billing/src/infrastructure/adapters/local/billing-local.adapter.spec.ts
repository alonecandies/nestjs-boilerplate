import { generateId } from '@app/common';
import { createMock } from '@app/testing';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { describe, expect, it } from 'vitest';
import { CreateCheckoutSessionCommand } from '../../../application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../../../application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import { ListPaymentsQuery } from '../../../application/queries/list-payments/list-payments.query.js';
import { BillingLocalAdapter } from './billing-local.adapter.js';

describe('BillingLocalAdapter (port → CQRS buses)', () => {
  const commandBus = createMock<CommandBus>();
  const queryBus = createMock<QueryBus>();
  const adapter = new BillingLocalAdapter(
    commandBus as unknown as CommandBus,
    queryBus as unknown as QueryBus,
  );

  it('createCheckoutSession → CreateCheckoutSessionCommand', async () => {
    const session = { id: 'cs_1', url: 'https://checkout.stripe.com/x', paymentId: generateId() };
    commandBus.execute.mockResolvedValueOnce(session);
    const request = {
      userId: generateId(),
      customerEmail: 'a@b.co',
      priceId: 'price_1',
      quantity: 1,
    };

    await expect(adapter.createCheckoutSession(request)).resolves.toBe(session);
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(CreateCheckoutSessionCommand);
    expect((command as CreateCheckoutSessionCommand).request).toBe(request);
  });

  it('handleStripeWebhook → HandleStripeWebhookCommand with the untouched bytes', async () => {
    const payload = Buffer.from('{"id":"evt_1"}');
    commandBus.execute.mockResolvedValueOnce({ received: true });

    await adapter.handleStripeWebhook({ payload, signature: 't=1,v1=abc' });

    const command = commandBus.execute.mock.calls.at(-1)?.[0] as HandleStripeWebhookCommand;
    expect(command).toBeInstanceOf(HandleStripeWebhookCommand);
    expect(command.payload).toBe(payload);
    expect(command.signature).toBe('t=1,v1=abc');
  });

  it('listPayments → ListPaymentsQuery', async () => {
    queryBus.execute.mockResolvedValueOnce({ items: [] });
    const userId = generateId();

    await expect(adapter.listPayments({ userId, limit: 7 })).resolves.toEqual({ items: [] });
    const query = queryBus.execute.mock.calls[0]?.[0] as ListPaymentsQuery;
    expect(query).toBeInstanceOf(ListPaymentsQuery);
    expect(query.criteria).toEqual({ userId, limit: 7 });
  });
});
