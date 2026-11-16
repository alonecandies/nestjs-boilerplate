import type {
  CreateTenantRequest,
  ListMyTenantsRequest,
  MyTenant,
  MyTenantList,
  RenameTenantRequest,
  Tenant,
} from '@domain/identity-contracts';

/**
 * Tenancy for the presentation layer: local adapter = CQRS buses, remote adapter =
 * `identity.v1.TenantsService` (Task 11).
 */
export abstract class TenantsPort {
  abstract listMyTenants(input: ListMyTenantsRequest): Promise<MyTenantList>;

  /** @throws DomainValidationException (blank or long name), TenantSlugTakenException (409) */
  abstract createTenant(input: CreateTenantRequest): Promise<MyTenant>;

  /** @throws TenantAccessDeniedException (403), PermissionDeniedException FORBIDDEN (not an owner), EntityNotFoundException */
  abstract renameTenant(input: RenameTenantRequest): Promise<Tenant>;
}
