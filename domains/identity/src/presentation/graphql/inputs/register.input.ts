import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { NormalizeEmail, TrimString } from '../../shared/transforms.js';

// Every field needs a class-validator decorator: the global ValidationPipe runs with
// whitelist + forbidNonWhitelisted, which would otherwise reject/strip it.
@InputType()
export class RegisterInput {
  @Field()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @Field()
  @IsString()
  @MinLength(IDENTITY_LIMITS.PASSWORD_MIN_LENGTH)
  @MaxLength(IDENTITY_LIMITS.PASSWORD_MAX_LENGTH)
  password: string;

  @Field()
  @TrimString()
  @IsString()
  @MinLength(IDENTITY_LIMITS.DISPLAY_NAME_MIN_LENGTH)
  @MaxLength(IDENTITY_LIMITS.DISPLAY_NAME_MAX_LENGTH)
  displayName: string;
}
