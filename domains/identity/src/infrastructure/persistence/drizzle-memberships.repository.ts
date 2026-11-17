import { Injectable } from '@nestjs/common';
import { normalizeTenantRoles, type TenantRole } from '@platform/common';
import {
  assertRowsAffected,
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import { and, count, eq, sql } from 'drizzle-orm';
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
import { membershipOf, RECENT_FIRST } from './membership-queries.js';
import { isUniqueViolation } from './postgres-errors.js';

/** Memberships on the runtime pool; every method is a unit of work (`inUnitOfWork`). */
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
      await inUnitOfWork(this.txHost, (tx) =>
        tx.insert(memberships).values({ ...membership, roles }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'memberships_tenant_id_user_id_pk')) {
        throw new MembershipAlreadyExistsException({ cause: error });
      }
      throw error;
    }
  }

  async find(tenantId: string, userId: string): Promise<MembershipRecord | null> {
    const [row] = await inUnitOfWork(this.txHost, (tx) =>
      tx.select().from(memberships).where(membershipOf(tenantId, userId)).limit(1),
    );
    return row ?? null;
  }

  async findMostRecentForUser(userId: string): Promise<MembershipRecord | null> {
    const [row] = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, userId))
        .orderBy(...RECENT_FIRST)
        .limit(1),
    );
    return row ?? null;
  }

  async listForUser(userId: string): Promise<TenantMembership[]> {
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select({ membership: memberships, tenant: tenants })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(memberships.userId, userId))
        .orderBy(...RECENT_FIRST),
    );
    return rows.map(({ membership, tenant }) => ({ ...membership, tenant }));
  }

  async touch(tenantId: string, userId: string, at: Date): Promise<void> {
    // Without elevation the policy hides the row: the UPDATE matches nothing instead of failing.
    const result = await inUnitOfWork(this.txHost, (tx) =>
      tx.update(memberships).set({ lastActiveAt: at }).where(membershipOf(tenantId, userId)),
    );
    assertRowsAffected(result, 1, 'memberships.touch');
  }

  async updateRoles(
    tenantId: string,
    userId: string,
    roles: readonly TenantRole[],
  ): Promise<boolean> {
    const updated = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .update(memberships)
        .set({ roles: [...roles] })
        .where(membershipOf(tenantId, userId))
        .returning({ userId: memberships.userId }),
    );
    return updated.length > 0;
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    const deleted = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .delete(memberships)
        .where(membershipOf(tenantId, userId))
        .returning({ userId: memberships.userId }),
    );
    return deleted.length > 0;
  }

  async countOwnersLocked(tenantId: string): Promise<number> {
    return inUnitOfWork(this.txHost, async (tx) => {
      // Per-tenant mutex for owner changes (replaces the old global last-admin lock); released at
      // COMMIT/ROLLBACK, so it is safe behind PgBouncer transaction pooling (a session lock is not)
      // and runs on the Citus coordinator. Advisory locks only: no FOR UPDATE on Citus (sharding
      // design §2.1.6). Relies on READ COMMITTED (the transaction runner's default): the count
      // below is a separate statement, so its snapshot is taken after the lock is granted and sees
      // the owner change the previous holder committed. Must be called before any other read of
      // the unit of work (a standalone call holds the lock only for its own transaction).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`identity:tenant-owners:${tenantId}`}))`,
      );
      const [row] = await tx
        .select({ owners: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), sql`'owner' = any(${memberships.roles})`));
      return row?.owners ?? 0;
    });
  }
}
