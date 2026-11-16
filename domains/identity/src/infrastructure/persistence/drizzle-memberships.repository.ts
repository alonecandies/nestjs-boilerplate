import { Injectable } from '@nestjs/common';
import { normalizeTenantRoles } from '@platform/common';
import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  MembershipRecord,
  MembershipsRepository,
  NewMembership,
  TenantMembership,
} from '../../application/persistence/memberships.repository.js';
import {
  InvalidRolesException,
  MembershipAlreadyExistsException,
} from '../../domain/identity.errors.js';
import { type IdentitySchema, memberships, tenants } from './identity.schema.js';
import { isUniqueViolation } from './postgres-errors.js';

const RECENT_FIRST = [
  sql`${memberships.lastActiveAt} desc nulls last`,
  desc(memberships.createdAt),
] as const;

const membershipOf = (tenantId: string, userId: string) =>
  and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId));

/** Memberships over Drizzle; every statement joins the active `TransactionRunner` transaction. */
@Injectable()
export class DrizzleMembershipsRepository implements MembershipsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async insert(membership: NewMembership): Promise<void> {
    const roles = normalizeTenantRoles(membership.roles);
    if (roles.length === 0) {
      throw new InvalidRolesException([
        { path: 'roles', message: 'At least one role is required' },
      ]);
    }
    try {
      await this.txHost.tx.insert(memberships).values({ ...membership, roles });
    } catch (error) {
      if (isUniqueViolation(error, 'memberships_tenant_id_user_id_pk')) {
        throw new MembershipAlreadyExistsException({ cause: error });
      }
      throw error;
    }
  }

  async find(tenantId: string, userId: string): Promise<MembershipRecord | null> {
    const [row] = await this.txHost.tx
      .select()
      .from(memberships)
      .where(membershipOf(tenantId, userId))
      .limit(1);
    return row ?? null;
  }

  async findMostRecentForUser(userId: string): Promise<MembershipRecord | null> {
    const [row] = await this.txHost.tx
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(...RECENT_FIRST)
      .limit(1);
    return row ?? null;
  }

  async listForUser(userId: string): Promise<TenantMembership[]> {
    const rows = await this.txHost.tx
      .select({ membership: memberships, tenant: tenants })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, userId))
      .orderBy(...RECENT_FIRST);
    return rows.map(({ membership, tenant }) => ({ ...membership, tenant }));
  }

  async touch(tenantId: string, userId: string, at: Date): Promise<void> {
    await this.txHost.tx
      .update(memberships)
      .set({ lastActiveAt: at })
      .where(membershipOf(tenantId, userId));
  }
}
