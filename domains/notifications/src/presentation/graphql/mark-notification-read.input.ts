import { Field, InputType } from '@nestjs/graphql';
import { GraphQLUUID } from '@platform/graphql';
import { IsUUID } from 'class-validator';

@InputType({ description: 'Marks one of the caller’s notifications read (idempotent).' })
export class MarkNotificationReadInput {
  @Field(() => GraphQLUUID)
  @IsUUID()
  id: string;
}
