import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { BillingPort } from '../../application/ports/billing.port.js';
import { BillingPermission } from '../../billing.permissions.js';
import { resolvePaymentsOwner } from '../payments-scope.js';
import { PaymentsArgs } from './args/payments.args.js';
import { CreateCheckoutSessionInput } from './inputs/create-checkout-session.input.js';
import { CheckoutSessionModel } from './models/checkout-session.model.js';
import {
  PaymentConnectionModel,
  PaymentModel,
  toPaymentConnectionModel,
} from './models/payment.model.js';

/**
 * `payments(all, limit, cursor)` (a keyset-paginated connection) and `createCheckoutSession(input)`.
 * Authentication/RBAC come from the global, context-aware guards. A payment's owner is exposed as
 * `Payment.userId` only: the apps compose `Payment.user` (`PaymentUserFieldResolver`, over
 * identity's `users` DataLoader), so billing never imports identity.
 */
@Resolver(() => PaymentModel)
export class BillingResolver {
  constructor(private readonly billing: BillingPort) {}

  @Query(() => PaymentConnectionModel, {
    name: 'payments',
    description:
      "Newest first, one page at a time (`cursor` = the previous page's `nextCursor`). `all: true` lists every user's payments (billing:read-all).",
    complexity: 10,
  })
  async payments(
    @Args() args: PaymentsArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentConnectionModel> {
    const list = await this.billing.listPayments({
      userId: resolvePaymentsOwner(user, args.all),
      limit: args.limit,
      cursor: args.cursor ?? undefined,
    });
    return toPaymentConnectionModel(list);
  }

  @Mutation(() => CheckoutSessionModel, {
    description: 'Starts a hosted Stripe Checkout and records a pending payment',
  })
  @RequirePermissions(BillingPermission.Checkout)
  createCheckoutSession(
    @Args('input') input: CreateCheckoutSessionInput,
    @CurrentUser() user: AuthUser,
  ): Promise<CheckoutSessionModel> {
    return this.billing.createCheckoutSession({
      userId: user.id,
      customerEmail: user.email,
      priceId: input.priceId,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey ?? undefined,
    });
  }
}
