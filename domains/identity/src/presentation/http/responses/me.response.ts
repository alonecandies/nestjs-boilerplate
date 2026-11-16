import type { User } from '@domain/identity-contracts';
import { ApiProperty } from '@nestjs/swagger';
import type { AuthUser } from '@platform/auth';
import { TENANT_ROLES, type TenantRole } from '@platform/common';
import { Exclude, Expose } from 'class-transformer';
import { toUserView } from '../../shared/user-view.js';
import { UserResponse } from './user.response.js';

/** `GET /v1/auth/me`: the profile plus the token's tenant context (spec §5.3). */
@Exclude()
export class MeResponse extends UserResponse {
  @Expose()
  @ApiProperty({ format: 'uuid', description: 'The active tenant (the access token `tid`).' })
  tenantId: string;

  @Expose()
  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true, example: ['owner'] })
  tenantRoles: TenantRole[];

  @Expose()
  @ApiProperty({ description: 'true only for a platform-staff switch-in token.', example: false })
  staff: boolean;

  /** The profile from identity, the tenant context from the verified token. */
  static forPrincipal(user: User, principal: AuthUser): MeResponse {
    return Object.assign(new MeResponse(), toUserView(user), {
      tenantId: principal.tenantId,
      tenantRoles: [...principal.roles],
      staff: principal.staff,
    });
  }
}
