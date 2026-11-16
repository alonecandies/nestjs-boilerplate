import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('Tenant', { description: 'A workspace' })
export class TenantModel {
  @Field(() => ID)
  id: string;

  @Field()
  slug: string;

  @Field()
  name: string;

  @Field({ description: 'Created at registration for its first owner' })
  personal: boolean;
}
