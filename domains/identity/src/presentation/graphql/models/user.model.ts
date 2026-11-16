import { Field, GraphQLISODateTime, ObjectType } from '@nestjs/graphql';
import { GraphQLUUID } from '@platform/graphql';

/**
 * GraphQL `User`. Exported for the cross-domain field the apps compose (`Payment.user` in
 * `PaymentUserFieldResolver`, resolved through the `users` DataLoader).
 */
@ObjectType('User', { description: 'A user account' })
export class UserModel {
  @Field(() => GraphQLUUID)
  id: string;

  @Field()
  email: string;

  @Field()
  displayName: string;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
