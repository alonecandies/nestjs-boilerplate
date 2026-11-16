import { Field, InputType } from '@nestjs/graphql';
import { IsString, Length } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { TrimString } from '../../shared/transforms.js';

@InputType()
export class TenantNameInput {
  @Field()
  @TrimString()
  @IsString()
  @Length(1, IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH)
  name: string;
}
