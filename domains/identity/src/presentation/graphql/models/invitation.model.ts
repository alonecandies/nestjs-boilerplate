import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';
import { TenantRoleEnum } from '../tenant-role.enum.js';

@ObjectType('Invitation', { description: 'A pending invitation (the token only travels by mail)' })
export class InvitationModel {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  tenantId: string;

  @Field()
  email: string;

  @Field(() => [TenantRoleEnum])
  roles: TenantRole[];

  @Field(() => GraphQLISODateTime)
  expiresAt: Date;
}
