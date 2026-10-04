import { Field, ObjectType } from '@nestjs/graphql';
import { UserModel } from './user.model.js';

@ObjectType('UserConnection', { description: 'A keyset page of users, newest first' })
export class UserConnectionModel {
  @Field(() => [UserModel])
  items: UserModel[];

  @Field(() => String, { nullable: true, description: 'Cursor of the next page; null at the end' })
  nextCursor: string | null;
}
