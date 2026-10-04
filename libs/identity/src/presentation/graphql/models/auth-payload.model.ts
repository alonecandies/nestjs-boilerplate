import { Field, Int, ObjectType } from '@nestjs/graphql';
import { UserModel } from './user.model.js';

@ObjectType('AuthPayload', { description: 'A fresh token pair and the authenticated user' })
export class AuthPayloadModel {
  @Field({ description: 'Short-lived access JWT (`Authorization: Bearer …`)' })
  accessToken: string;

  @Field({ description: 'Single-use refresh JWT (rotated by `refreshTokens`)' })
  refreshToken: string;

  @Field(() => Int, { description: 'Access token lifetime in seconds' })
  expiresIn: number;

  @Field()
  tokenType: string;

  @Field(() => UserModel)
  user: UserModel;
}
