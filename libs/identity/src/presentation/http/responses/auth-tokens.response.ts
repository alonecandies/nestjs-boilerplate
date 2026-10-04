import { ExternalServiceException } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { ApiProperty } from '@nestjs/swagger';
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
      user: UserResponse.from(tokens.user),
    });
  }
}
