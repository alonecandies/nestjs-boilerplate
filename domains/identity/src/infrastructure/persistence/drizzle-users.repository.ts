import { Injectable } from '@nestjs/common';
import {
  assertRowsAffected,
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import { eq, sql } from 'drizzle-orm';
import type {
  UserRecord,
  UsersRepository,
} from '../../application/persistence/users.repository.js';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import type { UserAggregate } from '../../domain/user.aggregate.js';
import { type IdentitySchema, users } from './identity.schema.js';
import { isUniqueViolation } from './postgres-errors.js';
import { publicUserColumns } from './user-columns.js';

/**
 * Users on the runtime pool. Every method is a unit of work (`inUnitOfWork`): it joins the open
 * transaction, or opens one whose BEGIN carries the CLS principal's RLS context, so a standalone
 * call runs under the policies too. No pool handle and no named prepared statements: with
 * `DATABASE_PREPARE=true` postgres.js still prepares each query per connection, keyed by its text.
 */
@Injectable()
export class DrizzleUsersRepository implements UsersRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await inUnitOfWork(this.txHost, (tx) =>
      tx.select(publicUserColumns).from(users).where(eq(users.id, id)).limit(1),
    );
    return row ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    // ONE array parameter, not `IN ($1…$n)`: the SQL text (and so the per-connection prepared
    // statement) is the same for every batch size.
    return inUnitOfWork(this.txHost, (tx) =>
      tx
        .select(publicUserColumns)
        .from(users)
        .where(sql`${users.id} = any(${sql.param([...ids])}::uuid[])`),
    );
  }

  async isPlatformStaff(id: string): Promise<boolean> {
    const [row] = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select({ isPlatformStaff: users.isPlatformStaff })
        .from(users)
        .where(eq(users.id, id))
        .limit(1),
    );
    return row?.isPlatformStaff === true;
  }

  async insert(user: UserAggregate): Promise<void> {
    try {
      await inUnitOfWork(this.txHost, (tx) => tx.insert(users).values(user.toSnapshot()));
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_unique')) {
        throw new EmailAlreadyTakenException({ cause: error });
      }
      throw error;
    }
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void> {
    // Under RLS another user's row is invisible: the UPDATE matches nothing instead of failing.
    const result = await inUnitOfWork(this.txHost, (tx) =>
      tx.update(users).set({ passwordHash, updatedAt }).where(eq(users.id, id)),
    );
    assertRowsAffected(result, 1, 'users.updatePasswordHash');
  }
}
