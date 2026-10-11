import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsJWT, IsOptional, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Revoke only the session of this refresh token. Omit it to sign out of every session.',
  })
  @IsOptional()
  @IsJWT()
  @MaxLength(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH)
  refreshToken?: string;
}
