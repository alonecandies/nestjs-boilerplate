import { ApiProperty } from '@nestjs/swagger';
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

export class CreateInvitationDto {
  @ApiProperty({ example: 'new.person@example.com', maxLength: IDENTITY_LIMITS.EMAIL_MAX_LENGTH })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true, example: ['member'] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_ROLES.length)
  @IsIn(TENANT_ROLES, { each: true })
  roles: TenantRole[];
}
