import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsUUID, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';

export class SwitchTenantDto {
  @ApiProperty({ format: 'uuid', description: 'A tenant you are a member of.' })
  @IsUUID()
  tenantId: string;

  @ApiProperty({ description: 'Your current refresh token (rotated: single use).' })
  @IsJWT()
  @MaxLength(IDENTITY_LIMITS.REFRESH_TOKEN_MAX_LENGTH)
  refreshToken: string;
}
