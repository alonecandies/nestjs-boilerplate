import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';
import { TenantRoleEnum } from '../tenant-role.enum.js';

@ObjectType('Member', { description: 'A member of the active tenant' })
export class MemberModel {
  @Field(() => ID)
  userId: string;

  @Field(() => String, {
    nullable: true,
    description: 'null for a co-member unless the caller holds users:read',
  })
  email: string | null;

  @Field()
  displayName: string;

  @Field(() => [TenantRoleEnum], {
    nullable: true,
    description: 'null for a co-member unless the caller holds users:read',
  })
  roles: TenantRole[] | null;

  @Field(() => GraphQLISODateTime)
  joinedAt: Date;
}
