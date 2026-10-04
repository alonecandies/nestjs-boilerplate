import type {
  CheckoutSession,
  CreateCheckoutSessionRequest,
  HandleStripeWebhookRequest,
  HandleStripeWebhookResponse,
  ListPaymentsRequest,
  PaymentList,
} from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateCheckoutSessionCommand } from '../../../application/commands/create-checkout-session/create-checkout-session.command.js';
import { HandleStripeWebhookCommand } from '../../../application/commands/handle-stripe-webhook/handle-stripe-webhook.command.js';
import type { BillingPort } from '../../../application/ports/billing.port.js';
import { ListPaymentsQuery } from '../../../application/queries/list-payments/list-payments.query.js';

/** `BillingPort` in-process (monolith): straight onto the CQRS buses, no serialisation. */
@Injectable()
export class BillingLocalAdapter implements BillingPort {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  createCheckoutSession(input: CreateCheckoutSessionRequest): Promise<CheckoutSession> {
    return this.commandBus.execute(new CreateCheckoutSessionCommand(input));
  }

  handleStripeWebhook(input: HandleStripeWebhookRequest): Promise<HandleStripeWebhookResponse> {
    return this.commandBus.execute(new HandleStripeWebhookCommand(input.payload, input.signature));
  }

  listPayments(input: ListPaymentsRequest): Promise<PaymentList> {
    return this.queryBus.execute(
      new ListPaymentsQuery({ userId: input.userId, limit: input.limit, cursor: input.cursor }),
    );
  }
}
