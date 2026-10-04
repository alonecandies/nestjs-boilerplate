import type { CursorPage } from '@app/common';
import {
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  InjectDrizzle,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetWhere,
  TransactionHost,
} from '@app/database';
import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  count,
  eq,
  getTableColumns,
  ilike,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type {
  ListUsersCriteria,
  UserRecord,
  UsersRepository,
} from '../../application/persistence/users.repository.js';
import { EmailAlreadyTakenException } from '../../domain/identity.errors.js';
import { UserAggregate, type UserSnapshot } from '../../domain/user.aggregate.js';
import { ADMIN_ROLE, type UserRole } from '../../domain/user-role.js';
import { USER_ROLES_LOCK } from '../../identity.constants.js';
import { type IdentitySchema, users } from './identity.schema.js';
import { isUniqueViolation } from './postgres-errors.js';

type Db = DrizzleDB<IdentitySchema>;

/** Public projection: selecting it can never ship the password hash by accident. */
const { passwordHash: _passwordHash, ...publicColumns } = getTableColumns(users);

/** `%`, `_` and `\` are wildcards/escape in ILIKE patterns: match them literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function searchFilter(search: string | undefined): SQL | undefined {
  if (search === undefined) return undefined;
  const pattern = `%${escapeLike(search)}%`;
  return or(ilike(users.email, pattern), ilike(users.displayName, pattern));
}

/*
 * Hot single-row lookups, built once. Every query is a server-side prepared statement per
 * connection when `DATABASE_PREPARE=true` (@app/database `preferPreparedStatements`; postgres.js
 * keys them by SQL text, so query text must stay bounded — see `findByIds`). These run on the
 * pool, never inside a transaction — every other method goes through `txHost.tx`, which joins the
 * active `@Transactional()` / `TransactionRunner` transaction when there is one.
 */
const buildStatements = (db: Db) => ({
  byId: db
    .select(publicColumns)
    .from(users)
    .where(eq(users.id, sql.placeholder('id')))
    .limit(1)
    .prepare('identity_user_by_id'),
  credentialsByEmail: db
    .select()
    .from(users)
    .where(eq(users.email, sql.placeholder('email')))
    .limit(1)
    .prepare('identity_user_credentials_by_email'),
  idByEmail: db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, sql.placeholder('email')))
    .limit(1)
    .prepare('identity_user_id_by_email'),
});

@Injectable()
export class DrizzleUsersRepository implements UsersRepository {
  // Built in the constructor body (never a field initialiser referencing constructor params).
  private readonly statements: ReturnType<typeof buildStatements>;

  constructor(
    @InjectDrizzle() db: Db,
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {
    this.statements = buildStatements(db);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.statements.byId.execute({ id });
    return row ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    // ONE array parameter, not `IN ($1…$n)`: the SQL text (and so the per-connection prepared
    // statement) is the same for every batch size.
    return this.txHost.tx
      .select(publicColumns)
      .from(users)
      .where(sql`${users.id} = any(${sql.param([...ids])}::uuid[])`);
  }

  async findCredentialsByEmail(email: string): Promise<UserSnapshot | null> {
    const [row] = await this.statements.credentialsByEmail.execute({ email });
    return row ?? null;
  }

  async findAggregate(id: string): Promise<UserAggregate | null> {
    const [row] = await this.txHost.tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      .for('update');
    return row ? UserAggregate.restore(row) : null;
  }

  async countAdmins(): Promise<number> {
    const tx = this.txHost.tx;
    // Held until the transaction ends (a no-op guard outside one: it is released immediately).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${USER_ROLES_LOCK}))`);
    const [row] = await tx
      .select({ admins: count() })
      .from(users)
      .where(arrayContains(users.roles, [ADMIN_ROLE]));
    return row?.admins ?? 0;
  }

  async existsByEmail(email: string): Promise<boolean> {
    const rows = await this.statements.idByEmail.execute({ email });
    return rows.length > 0;
  }

  async list(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>> {
    const rows = await this.txHost.tx
      .select(publicColumns)
      .from(users)
      .where(and(searchFilter(criteria.search), keysetWhere(users.id, criteria.cursor)))
      .orderBy(keysetOrder(users.id))
      .limit(keysetFetchLimit(criteria.limit));
    return keysetPage(rows, criteria.limit);
  }

  async insert(user: UserAggregate): Promise<void> {
    const snapshot = user.toSnapshot();
    try {
      await this.txHost.tx.insert(users).values({ ...snapshot, roles: [...snapshot.roles] });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_unique')) {
        throw new EmailAlreadyTakenException({ cause: error });
      }
      throw error;
    }
  }

  async updateRoles(id: string, roles: readonly UserRole[], updatedAt: Date): Promise<void> {
    await this.txHost.tx
      .update(users)
      .set({ roles: [...roles], updatedAt })
      .where(eq(users.id, id));
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void> {
    await this.txHost.tx.update(users).set({ passwordHash, updatedAt }).where(eq(users.id, id));
  }
}
