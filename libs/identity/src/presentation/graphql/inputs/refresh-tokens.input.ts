import { Field, InputType } from '@nestjs/graphql';
import { IsJWT, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';

@InputType()
export class RefreshTokensInput {
  @Field()
  @IsJWT()
  @MaxLength(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH)
  refreshToken: string;
}
