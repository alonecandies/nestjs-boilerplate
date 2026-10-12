import { Field, GraphQLISODateTime, ObjectType } from '@nestjs/graphql';
import type { Role } from '@platform/auth';
import { GraphQLUUID } from '@platform/graphql';
import { RoleEnum } from '../role.enum.js';

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

  @Field(() => [RoleEnum])
  roles: Role[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
