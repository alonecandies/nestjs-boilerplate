import type { Member, MemberPage } from '@domain/identity-contracts';
import { ApiProperty } from '@nestjs/swagger';
import { normalizeTenantRoles, TENANT_ROLES, type TenantRole } from '@platform/common';

export class MemberResponse {
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty() email: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ enum: TENANT_ROLES, enumName: 'TenantRole', isArray: true }) roles: TenantRole[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) joinedAt: string | null;

  static from(member: Member): MemberResponse {
    return Object.assign(new MemberResponse(), {
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      roles: normalizeTenantRoles(member.roles),
      joinedAt: member.joinedAt?.toISOString() ?? null,
    });
  }
}

export class MemberPageResponse {
  @ApiProperty({ type: MemberResponse, isArray: true }) items: MemberResponse[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;

  static from(page: MemberPage): MemberPageResponse {
    return Object.assign(new MemberPageResponse(), {
      items: page.items.map((member) => MemberResponse.from(member)),
      nextCursor: page.nextCursor ?? null,
    });
  }
}
