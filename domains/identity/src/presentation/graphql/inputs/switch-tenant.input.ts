import { Field, ID, InputType } from '@nestjs/graphql';
import { IsJWT, IsUUID, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';

@InputType()
export class SwitchTenantInput {
  @Field(() => ID, { description: 'A tenant you are a member of' })
  @IsUUID()
  tenantId: string;

  @Field({ description: 'Your current refresh token (rotated: single use)' })
  @IsJWT()
  @MaxLength(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH)
  refreshToken: string;
}
