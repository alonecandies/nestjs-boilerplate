import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@app/auth';
import type { User } from '@app/contracts';
import { type GraphqlLoaders, Loader } from '@app/graphql';
import { USERS_LOADER, UserModel } from '@app/identity';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { BillingPort } from '../../application/ports/billing.port.js';
import { resolvePaymentsOwner } from '../payments-scope.js';
import { PaymentsArgs } from './args/payments.args.js';
import { CreateCheckoutSessionInput } from './inputs/create-checkout-session.input.js';
import { CheckoutSessionModel } from './models/checkout-session.model.js';
import { PaymentModel, toPaymentModel } from './models/payment.model.js';

/**
 * `payments(all, limit)` and `createCheckoutSession(input)`. Authentication/RBAC come from the
 * global, context-aware guards; `Payment.user` is resolved through identity's `users` DataLoader,
 * so a page of N payments costs ONE batched user lookup (no N+1).
 */
@Resolver(() => PaymentModel)
export class BillingResolver {
  constructor(private readonly billing: BillingPort) {}

  @Query(() => [PaymentModel], {
    name: 'payments',
    description: "Newest first. `all: true` lists every user's payments (billing:read-all).",
    complexity: 10,
  })
  async payments(
    @Args() args: PaymentsArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentModel[]> {
    const list = await this.billing.listPayments({
      userId: resolvePaymentsOwner(user, args.all),
      limit: args.limit,
    });
    return list.items.map(toPaymentModel);
  }

  @Mutation(() => CheckoutSessionModel, {
    description: 'Starts a hosted Stripe Checkout and records a pending payment',
  })
  @RequirePermissions(Permission.BillingCheckout)
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

  /** Typed by identity's `GraphqlLoaders['users']` augmentation; `null` for a deleted user. */
  @ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })
  user(
    @Parent() payment: PaymentModel,
    @Loader(USERS_LOADER) users: GraphqlLoaders[typeof USERS_LOADER],
  ): Promise<User | null> {
    return users.load(payment.userId);
  }
}
