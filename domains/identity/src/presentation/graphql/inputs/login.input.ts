import { Field, ID, InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { NormalizeEmail } from '../../shared/transforms.js';

@InputType()
export class LoginInput {
  @Field()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(IDENTITY_LIMITS.PASSWORD_MAX_LENGTH)
  password: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Tenant to open the session in; default: your most recently active workspace',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;
}
