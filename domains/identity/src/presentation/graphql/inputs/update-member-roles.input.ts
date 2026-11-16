import { Field, InputType } from '@nestjs/graphql';
import { TENANT_ROLES, type TenantRole } from '@platform/common';
import { GraphQLUUID } from '@platform/graphql';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsUUID } from 'class-validator';
import { TenantRoleEnum } from '../tenant-role.enum.js';

@InputType()
export class UpdateMemberRolesInput {
  @Field(() => GraphQLUUID)
  @IsUUID('7')
  userId: string;

  @Field(() => [TenantRoleEnum])
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_ROLES.length)
  @IsIn(TENANT_ROLES, { each: true })
  roles: TenantRole[];
}
