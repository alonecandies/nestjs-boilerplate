import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';
import { TenantRoleEnum } from '../tenant-role.enum.js';

@ObjectType('Member', { description: 'A member of the active tenant' })
export class MemberModel {
  @Field(() => ID)
  userId: string;

  @Field()
  email: string;

  @Field()
  displayName: string;

  @Field(() => [TenantRoleEnum])
  roles: TenantRole[];

  @Field(() => GraphQLISODateTime)
  joinedAt: Date;
}
