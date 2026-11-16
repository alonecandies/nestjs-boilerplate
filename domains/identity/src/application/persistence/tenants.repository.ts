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

/** Tenants persistence port (`identity.tenants`, a reference table on Citus). */
export abstract class TenantsRepository {
  /** @throws TenantSlugTakenException when `tenants_slug_unique` rejects the row */
  abstract insert(tenant: NewTenant): Promise<void>;

  abstract findById(id: string): Promise<TenantRecord | null>;

  /** One query; unknown ids are omitted; order is unspecified. */
  abstract findByIds(ids: readonly string[]): Promise<TenantRecord[]>;

  abstract existsBySlug(slug: string): Promise<boolean>;

  /** `false` when no row matched. */
  abstract rename(id: string, name: string): Promise<boolean>;
}
