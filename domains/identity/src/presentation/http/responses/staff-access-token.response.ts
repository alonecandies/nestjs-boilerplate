import type { StaffAccessToken } from '@domain/identity-contracts';
import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

/** A staff switch-in token: access only, no refresh token. */
@Exclude()
export class StaffAccessTokenResponse {
  @Expose()
  @ApiProperty({ description: 'Access JWT: roles ["admin"], staff: true, tid = tenantId.' })
  accessToken: string;

  @Expose()
  @ApiProperty({ example: 900, description: 'Seconds (STAFF_SWITCH_IN_TTL_SEC).' })
  expiresIn: number;

  @Expose()
  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @Expose()
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @Expose()
  @ApiProperty({ format: 'uuid', description: 'The audit_events row recording this switch-in.' })
  auditEventId: string;

  static from(token: StaffAccessToken): StaffAccessTokenResponse {
    return Object.assign(new StaffAccessTokenResponse(), token);
  }
}
