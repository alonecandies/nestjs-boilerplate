import { Field, InputType } from '@nestjs/graphql';
import { IsString, Length } from 'class-validator';
import { TrimString } from '../../shared/transforms.js';

@InputType()
export class AcceptInvitationInput {
  @Field({ description: 'The code from the invitation mail' })
  @TrimString()
  @IsString()
  @Length(43, 43)
  token: string;
}
