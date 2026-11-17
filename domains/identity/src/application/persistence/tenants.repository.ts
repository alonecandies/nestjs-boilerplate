export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly personal: boolean;
  readonly createdAt: Date;
}

export interface NewTenant {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
}

/**
 * Tenants persistence port on the runtime pool (`identity.tenants`, a reference table on Citus):
 * the principal reads only its session tenant (row-local policy); renaming needs elevation.
 */
export abstract class TenantsRepository {
  /** @throws TenantSlugTakenException when `tenants_slug_unique` rejects the row */
  abstract insert(tenant: NewTenant): Promise<void>;

  abstract findById(id: string): Promise<TenantRecord | null>;

  /** One query; unknown and hidden ids are omitted; order is unspecified. */
  abstract findByIds(ids: readonly string[]): Promise<TenantRecord[]>;

  /**
   * Sees only the tenants the principal can read: a pre-check for a friendly error at most. The
   * `tenants_slug_unique` constraint decides (`insert` maps it to TenantSlugTakenException).
   */
  abstract existsBySlug(slug: string): Promise<boolean>;

  /** `false` when no row matched. */
  abstract rename(id: string, name: string): Promise<boolean>;
}
