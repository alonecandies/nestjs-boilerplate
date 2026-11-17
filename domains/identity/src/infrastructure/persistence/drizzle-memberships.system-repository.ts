import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  type DrizzleDB,
  decodeIdCursor,
  InjectSystemDatabase,
  keysetFetchLimit,
  keysetOrder,
  keysetPageBy,
  SystemDatabase,
} from '@platform/database';
import { and, eq, lt } from 'drizzle-orm';
import type {
  MemberRecord,
  TenantMembership,
} from '../../application/persistence/memberships.repository.js';
import type { MembershipsSystemRepository } from '../../application/persistence/memberships.system-repository.js';
import { type IdentitySchema, memberships, tenants, users } from './identity.schema.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';
import { membershipOf, RECENT_FIRST } from './membership-queries.js';

const METHODS = IDENTITY_SYSTEM_METHODS.memberships;

/** memberships ⋈ users: both reference tables, so the join is local on every Citus node. */
const memberQuery = (db: DrizzleDB<IdentitySchema>) =>
  db
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

/** `MembershipsSystemRepository` on the app_system pool, one named system method per call. */
@Injectable()
export class DrizzleMembershipsSystemRepository implements MembershipsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<IdentitySchema>) {}

  findMember(tenantId: string, userId: string): Promise<MemberRecord | null> {
    return this.system.run(METHODS.findMember, async (db) => {
      const [row] = await memberQuery(db).where(membershipOf(tenantId, userId)).limit(1);
      return row ?? null;
    });
  }

  listMembers(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<MemberRecord>> {
    const after =
      criteria.cursor === undefined || criteria.cursor === ''
        ? undefined
        : decodeIdCursor(criteria.cursor).id;
    return this.system.run(METHODS.listMembers, async (db) => {
      const rows = await memberQuery(db)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            after === undefined ? undefined : lt(memberships.userId, after),
          ),
        )
        .orderBy(keysetOrder(memberships.userId))
        .limit(keysetFetchLimit(criteria.limit));
      return keysetPageBy(rows, criteria.limit, (member) => ({ id: member.userId }));
    });
  }

  listForUser(userId: string): Promise<TenantMembership[]> {
    return this.system.run(METHODS.listForUser, async (db) => {
      const rows = await db
        .select({ membership: memberships, tenant: tenants })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(memberships.userId, userId))
        .orderBy(...RECENT_FIRST);
      return rows.map(({ membership, tenant }) => ({ ...membership, tenant }));
    });
  }
}
