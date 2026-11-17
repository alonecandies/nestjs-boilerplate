import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  InjectSystemDatabase,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetWhere,
  SystemDatabase,
} from '@platform/database';
import { and, eq } from 'drizzle-orm';
import type {
  ListUsersCriteria,
  UserRecord,
} from '../../application/persistence/users.repository.js';
import type { UsersSystemRepository } from '../../application/persistence/users.system-repository.js';
import type { UserSnapshot } from '../../domain/user.aggregate.js';
import { type IdentitySchema, memberships, users } from './identity.schema.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';
import { publicUserColumns, userSearchFilter } from './user-columns.js';

const METHODS = IDENTITY_SYSTEM_METHODS.users;

/** `UsersSystemRepository` on the app_system pool, one named system method per call. */
@Injectable()
export class DrizzleUsersSystemRepository implements UsersSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<IdentitySchema>) {}

  findCredentialsByEmail(email: string): Promise<UserSnapshot | null> {
    return this.system.run(METHODS.findCredentialsByEmail, async (db) => {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row ?? null;
    });
  }

  existsByEmail(email: string): Promise<boolean> {
    return this.system.run(METHODS.existsByEmail, async (db) => {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows.length > 0;
    });
  }

  findByIdInTenant(id: string, tenantId: string): Promise<UserRecord | null> {
    return this.system.run(METHODS.findByIdInTenant, async (db) => {
      const [row] = await db
        .select(publicUserColumns)
        .from(users)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId)),
        )
        .where(eq(users.id, id))
        .limit(1);
      return row ?? null;
    });
  }

  listInTenant(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>> {
    return this.system.run(METHODS.listInTenant, async (db) => {
      const rows = await db
        .select(publicUserColumns)
        .from(users)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.tenantId, criteria.tenantId)),
        )
        .where(and(userSearchFilter(criteria.search), keysetWhere(users.id, criteria.cursor)))
        .orderBy(keysetOrder(users.id))
        .limit(keysetFetchLimit(criteria.limit));
      return keysetPage(rows, criteria.limit);
    });
  }
}
