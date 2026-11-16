import { ApiProperty } from '@nestjs/swagger';
import { TENANT_ROLES, type TenantRole } from '@platform/common';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsIn } from 'class-validator';

export class MemberRolesDto {
  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true, example: ['admin'] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_ROLES.length)
  @IsIn(TENANT_ROLES, { each: true })
  roles: TenantRole[];
}
