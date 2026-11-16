import { Field, GraphQLISODateTime, ObjectType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';
import { TenantRoleEnum } from '../tenant-role.enum.js';
import { TenantModel } from './tenant.model.js';

@ObjectType('MyTenant', { description: 'One of your tenants and your roles in it' })
export class MyTenantModel {
  @Field(() => TenantModel)
  tenant: TenantModel;

  @Field(() => [TenantRoleEnum])
  roles: TenantRole[];

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastActiveAt: Date | null;
}
