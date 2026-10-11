import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { NormalizeEmail, TrimString } from '../../shared/transforms.js';

export class RegisterDto {
  @ApiProperty({
    example: 'ada@example.com',
    format: 'email',
    maxLength: IDENTITY_LIMITS.EMAIL_MAX_LENGTH,
    description: 'Trimmed and lowercased before use.',
  })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({
    example: 'correct horse battery staple',
    format: 'password',
    minLength: IDENTITY_LIMITS.PASSWORD_MIN_LENGTH,
    maxLength: IDENTITY_LIMITS.PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(IDENTITY_LIMITS.PASSWORD_MIN_LENGTH)
  @MaxLength(IDENTITY_LIMITS.PASSWORD_MAX_LENGTH)
  password: string;

  @ApiProperty({
    example: 'Ada Lovelace',
    minLength: IDENTITY_LIMITS.DISPLAY_NAME_MIN_LENGTH,
    maxLength: IDENTITY_LIMITS.DISPLAY_NAME_MAX_LENGTH,
  })
  @TrimString()
  @IsString()
  @MinLength(IDENTITY_LIMITS.DISPLAY_NAME_MIN_LENGTH)
  @MaxLength(IDENTITY_LIMITS.DISPLAY_NAME_MAX_LENGTH)
  displayName: string;
}
