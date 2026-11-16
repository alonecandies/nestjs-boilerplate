import { Injectable } from '@nestjs/common';
import { type CursorPage, normalizeTenantRoles, type TenantRole } from '@platform/common';
import {
  type DrizzleTransactionalAdapter,
  decodeIdCursor,
  keysetFetchLimit,
  keysetOrder,
  keysetPageBy,
  TransactionHost,
} from '@platform/database';
import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import type {
  MemberRecord,
  MembershipRecord,
  MembershipsRepository,
  NewMembership,
  TenantMembership,
} from '../../application/persistence/memberships.repository.js';
import {
  InvalidRolesException,
  MembershipAlreadyExistsException,
} from '../../domain/identity.errors.js';
import { type IdentitySchema, memberships, tenants, users } from './identity.schema.js';
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

  async updateRoles(
    tenantId: string,
    userId: string,
    roles: readonly TenantRole[],
  ): Promise<boolean> {
    const updated = await this.txHost.tx
      .update(memberships)
      .set({ roles: [...roles] })
      .where(membershipOf(tenantId, userId))
      .returning({ userId: memberships.userId });
    return updated.length > 0;
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    const deleted = await this.txHost.tx
      .delete(memberships)
      .where(membershipOf(tenantId, userId))
      .returning({ userId: memberships.userId });
    return deleted.length > 0;
  }

  async countOwnersLocked(tenantId: string): Promise<number> {
    const tx = this.txHost.tx;
    // Per-tenant mutex for owner changes (replaces the old global last-admin lock); released at
    // COMMIT/ROLLBACK, so it is safe behind PgBouncer transaction pooling (a session lock is not)
    // and runs on the Citus coordinator. Advisory locks only: no FOR UPDATE on Citus (sharding
    // design §2.1.6). Relies on READ COMMITTED (the transaction runner's default): the count below
    // is a separate statement, so its snapshot is taken after the lock is granted and sees the
    // owner change the previous holder committed. Must be called before any other read of the
    // unit of work.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`identity:tenant-owners:${tenantId}`}))`,
    );
    const [row] = await tx
      .select({ owners: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), sql`'owner' = any(${memberships.roles})`));
    return row?.owners ?? 0;
  }

  async findMember(tenantId: string, userId: string): Promise<MemberRecord | null> {
    const [row] = await this.memberQuery().where(membershipOf(tenantId, userId)).limit(1);
    return row ?? null;
  }

  async listMembers(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<MemberRecord>> {
    const after =
      criteria.cursor === undefined || criteria.cursor === ''
        ? undefined
        : decodeIdCursor(criteria.cursor).id;
    const rows = await this.memberQuery()
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          after === undefined ? undefined : lt(memberships.userId, after),
        ),
      )
      .orderBy(keysetOrder(memberships.userId))
      .limit(keysetFetchLimit(criteria.limit));
    return keysetPageBy(rows, criteria.limit, (member) => ({ id: member.userId }));
  }

  /** memberships ⋈ users: both reference tables, so the join is local on every Citus node. */
  private memberQuery() {
    return this.txHost.tx
      .select({
        userId: memberships.userId,
        email: users.email,
        displayName: users.displayName,
        roles: memberships.roles,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .$dynamic();
  }
}
