import { Field, InputType } from '@nestjs/graphql';
import { TENANT_ROLES, type TenantRole } from '@platform/common';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  MaxLength,
} from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { NormalizeEmail } from '../../shared/transforms.js';
import { TenantRoleEnum } from '../tenant-role.enum.js';

@InputType()
export class InviteMemberInput {
  @Field()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @Field(() => [TenantRoleEnum])
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_ROLES.length)
  @IsIn(TENANT_ROLES, { each: true })
  roles: TenantRole[];
}
