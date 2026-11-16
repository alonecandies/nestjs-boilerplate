import type { MyTenant, Tenant } from '@domain/identity-contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { normalizeTenantRoles, TENANT_ROLES, type TenantRole } from '@platform/common';

export class TenantResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: 'The workspace created at registration' }) personal: boolean;

  static from(tenant: Tenant): TenantResponse {
    return Object.assign(new TenantResponse(), {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      personal: tenant.personal,
    });
  }
}

export class MyTenantResponse extends TenantResponse {
  @ApiProperty({ enum: TENANT_ROLES, isArray: true }) roles: TenantRole[];
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) lastActiveAt:
    | string
    | null;

  static fromMine(mine: MyTenant): MyTenantResponse {
    if (mine.tenant === undefined) throw new Error('MyTenant without its tenant');
    return Object.assign(new MyTenantResponse(), TenantResponse.from(mine.tenant), {
      roles: normalizeTenantRoles(mine.roles),
      lastActiveAt: mine.lastActiveAt?.toISOString() ?? null,
    });
  }
}
