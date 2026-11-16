import { Field, ID, ObjectType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';
import { TenantRoleEnum } from '../tenant-role.enum.js';
import { TenantModel } from './tenant.model.js';

@ObjectType('ActiveTenant', { description: 'The tenant your access token acts in' })
export class ActiveTenantModel {
  @Field(() => ID)
  tenantId: string;

  @Field(() => TenantModel, {
    nullable: true,
    description: 'Null for a staff switch-in (no membership)',
  })
  tenant: TenantModel | null;

  @Field(() => [TenantRoleEnum])
  roles: TenantRole[];

  @Field({ description: 'True for a staff switch-in token' })
  staff: boolean;
}
