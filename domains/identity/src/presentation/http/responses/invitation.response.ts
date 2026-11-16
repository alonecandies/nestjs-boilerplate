import type { Invitation } from '@domain/identity-contracts';
import { ApiProperty } from '@nestjs/swagger';
import { normalizeTenantRoles, TENANT_ROLES, type TenantRole } from '@platform/common';

/** A created invitation. Never the token (it only travels in the mail). */
export class InvitationResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) tenantId: string;
  @ApiProperty({ format: 'email' }) email: string;
  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true }) roles: TenantRole[];
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt: string;

  static from(invitation: Invitation): InvitationResponse {
    return Object.assign(new InvitationResponse(), {
      id: invitation.id,
      tenantId: invitation.tenantId,
      email: invitation.email,
      roles: normalizeTenantRoles(invitation.roles),
      expiresAt: (invitation.expiresAt ?? new Date(0)).toISOString(),
    });
  }
}
