import type { AuthTokens } from '@domain/identity-contracts';
import { ApiProperty } from '@nestjs/swagger';
import {
  ExternalServiceException,
  normalizeTenantRoles,
  TENANT_ROLES,
  type TenantRole,
} from '@platform/common';
import { Exclude, Expose, Type } from 'class-transformer';
import { UserResponse } from './user.response.js';

@Exclude()
export class AuthTokensResponse {
  @Expose()
  @ApiProperty({ description: 'Short-lived access JWT (send as `Authorization: Bearer …`).' })
  accessToken: string;

  @Expose()
  @ApiProperty({
    description: 'Single-use refresh JWT: every refresh returns a new one and revokes this one.',
  })
  refreshToken: string;

  @Expose()
  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn: number;

  @Expose()
  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @Expose()
  @ApiProperty({
    format: 'uuid',
    description: "The session's tenant (the access token's active tenant).",
  })
  tenantId: string;

  @Expose()
  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true, example: ['owner'] })
  tenantRoles: TenantRole[];

  @Expose()
  @Type(() => UserResponse)
  @ApiProperty({ type: () => UserResponse })
  user: UserResponse;

  static from(tokens: AuthTokens): AuthTokensResponse {
    if (!tokens.user) {
      // Contract violation by the identity service (it always sets the user).
      throw new ExternalServiceException('Identity returned tokens without a user');
    }
    return Object.assign(new AuthTokensResponse(), {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: tokens.tokenType,
      tenantId: tokens.tenantId,
      tenantRoles: normalizeTenantRoles(tokens.tenantRoles),
      user: UserResponse.from(tokens.user),
    });
  }
}
