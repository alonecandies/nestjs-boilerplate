import { Field, ObjectType } from '@nestjs/graphql';
import { MemberModel } from './member.model.js';

@ObjectType('MemberConnection', { description: 'A keyset page of members' })
export class MemberConnectionModel {
  @Field(() => [MemberModel])
  items: MemberModel[];

  @Field(() => String, { nullable: true, description: 'Cursor of the next page; null at the end' })
  nextCursor: string | null;
}
