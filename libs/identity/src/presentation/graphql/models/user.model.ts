import type { Role } from '@app/auth';
import { GraphQLUUID } from '@app/graphql';
import { Field, GraphQLISODateTime, ObjectType } from '@nestjs/graphql';
import { RoleEnum } from '../role.enum.js';

/**
 * GraphQL `User`. Exported for other domains' fields (e.g. billing's `Payment.user`, resolved
 * through the `users` DataLoader).
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
