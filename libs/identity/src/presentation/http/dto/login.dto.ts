import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { NormalizeEmail } from '../../shared/transforms.js';

/**
 * Validated by `LoginRequestGuard` (guards run before pipes, and the passport-local guard needs a
 * valid, normalised body). No password policy here: login must not reveal the policy.
 */
export class LoginDto {
  @ApiProperty({ example: 'ada@example.com', format: 'email' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({ example: 'correct horse battery staple', format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(IDENTITY_LIMITS.PASSWORD_MAX_LENGTH)
  password: string;
}
