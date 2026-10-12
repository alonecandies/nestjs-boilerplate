import { PaymentModel } from '@domain/billing';
import { USERS_LOADER, UserModel } from '@domain/identity';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { type GraphqlLoaders, Loader } from '@platform/graphql';

/** Identity's `users` DataLoader, typed by identity's `GraphqlLoaders['users']` augmentation. */
type UsersLoader = GraphqlLoaders[typeof USERS_LOADER];

/**
 * `Payment.user`: the one GraphQL field that spans two bounded contexts (billing → identity). It
 * lives in the composition root so that neither domain imports the other: billing exposes the owner
 * as `Payment.userId`, identity registers the `users` DataLoader (`IdentityApiModule`), and this
 * resolver joins them. In the monolith the loader batches into ONE in-process `GetUsersByIds`
 * query per GraphQL operation; the gateway registers the same resolver over its remote ports.
 */
@Resolver(() => PaymentModel)
export class PaymentUserFieldResolver {
  /** `null` when the owner no longer exists. */
  @ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })
  user(
    @Parent() payment: PaymentModel,
    @Loader(USERS_LOADER) users: UsersLoader,
  ): ReturnType<UsersLoader['load']> {
    return users.load(payment.userId);
  }
}
