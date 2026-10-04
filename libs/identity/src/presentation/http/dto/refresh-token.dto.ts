import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token from the last login/refresh (single use).' })
  @IsJWT()
  @MaxLength(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH)
  refreshToken: string;
}
