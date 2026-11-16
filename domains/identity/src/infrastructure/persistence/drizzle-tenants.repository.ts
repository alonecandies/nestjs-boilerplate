import { Injectable } from '@nestjs/common';
import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { eq, sql } from 'drizzle-orm';
import type {
  NewTenant,
  TenantRecord,
  TenantsRepository,
} from '../../application/persistence/tenants.repository.js';
import { TenantSlugTakenException } from '../../domain/identity.errors.js';
import { type IdentitySchema, tenants } from './identity.schema.js';
import { isUniqueViolation } from './postgres-errors.js';

/** Tenants over Drizzle; every statement joins the active `TransactionRunner` transaction. */
@Injectable()
export class DrizzleTenantsRepository implements TenantsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async insert(tenant: NewTenant): Promise<void> {
    try {
      await this.txHost.tx.insert(tenants).values(tenant);
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_slug_unique')) {
        throw new TenantSlugTakenException({ cause: error });
      }
      throw error;
    }
  }

  async findById(id: string): Promise<TenantRecord | null> {
    const [row] = await this.txHost.tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<TenantRecord[]> {
    if (ids.length === 0) return [];
    return this.txHost.tx
      .select()
      .from(tenants)
      .where(sql`${tenants.id} = any(${sql.param([...ids])}::uuid[])`);
  }

  async existsBySlug(slug: string): Promise<boolean> {
    const rows = await this.txHost.tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    return rows.length > 0;
  }

  async rename(id: string, name: string): Promise<boolean> {
    const rows = await this.txHost.tx
      .update(tenants)
      .set({ name })
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id });
    return rows.length > 0;
  }
}
