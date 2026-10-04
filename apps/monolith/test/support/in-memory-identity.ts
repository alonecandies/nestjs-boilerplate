import type { CursorPage } from '@app/common';
import { decodeIdCursor, keysetPage } from '@app/database';
import {
  EmailAlreadyTakenException,
  type ListUsersCriteria,
  type NewSession,
  type RotateSessionInput,
  type SessionRecord,
  SessionsRepository,
  TransactionRunner,
  UserAggregate,
  type UserRecord,
  type UserRole,
  type UserSnapshot,
  UsersRepository,
} from '@app/identity';

/**
 * In-memory implementations of identity's persistence ports (`UsersRepository`,
 * `SessionsRepository`, `TransactionRunner`). The e2e suite binds them in place of the Drizzle
 * adapters, so the REAL command/query handlers, argon2 hashing, JWT issuing, refresh rotation and
 * the Kafka relay run end to end — only the SQL is replaced. Semantics mirror the Drizzle
 * repositories (normalised unique email, conditional rotation, keyset paging on uuidv7 ids).
 */
export class InMemoryIdentityStore {
  readonly users = new Map<string, UserSnapshot>();
  readonly sessions = new Map<string, SessionRecord>();

  clear(): void {
    this.users.clear();
    this.sessions.clear();
  }
}

const toRecord = ({ passwordHash: _hash, ...record }: UserSnapshot): UserRecord => record;

const isActive = (session: SessionRecord, now: Date): boolean =>
  session.revokedAt === null && session.expiresAt.getTime() > now.getTime();

export class InMemoryUsersRepository extends UsersRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async findById(id: string): Promise<UserRecord | null> {
    const user = this.store.users.get(id);
    return user ? toRecord(user) : null;
  }

  async findByIds(ids: readonly string[]): Promise<UserRecord[]> {
    return ids.flatMap((id) => {
      const user = this.store.users.get(id);
      return user ? [toRecord(user)] : [];
    });
  }

  async findCredentialsByEmail(email: string): Promise<UserSnapshot | null> {
    return [...this.store.users.values()].find((user) => user.email === email) ?? null;
  }

  async findAggregate(id: string): Promise<UserAggregate | null> {
    const user = this.store.users.get(id);
    return user ? UserAggregate.restore(user) : null;
  }

  async countAdmins(): Promise<number> {
    return [...this.store.users.values()].filter((user) => user.roles.includes('admin')).length;
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.findCredentialsByEmail(email)) !== null;
  }

  async list(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>> {
    const after = criteria.cursor === undefined ? undefined : decodeIdCursor(criteria.cursor).id;
    const search = criteria.search?.toLowerCase();
    const rows = [...this.store.users.values()]
      .filter((user) => after === undefined || user.id < after)
      .filter(
        (user) =>
          search === undefined ||
          user.email.includes(search) ||
          user.displayName.toLowerCase().includes(search),
      )
      // uuidv7 ids sort by creation time: newest first, like `ORDER BY id DESC`.
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, criteria.limit + 1)
      .map(toRecord);
    return keysetPage(rows, criteria.limit);
  }

  async insert(user: UserAggregate): Promise<void> {
    const snapshot = user.toSnapshot();
    if (await this.existsByEmail(snapshot.email)) throw new EmailAlreadyTakenException();
    this.store.users.set(snapshot.id, snapshot);
  }

  async updateRoles(id: string, roles: readonly UserRole[], updatedAt: Date): Promise<void> {
    const user = this.store.users.get(id);
    if (user) this.store.users.set(id, { ...user, roles: [...roles], updatedAt });
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void> {
    const user = this.store.users.get(id);
    if (user) this.store.users.set(id, { ...user, passwordHash, updatedAt });
  }
}

export class InMemorySessionsRepository extends SessionsRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async create(session: NewSession): Promise<void> {
    this.store.sessions.set(session.id, {
      ...session,
      revokedAt: null,
      replacedById: null,
      createdAt: new Date(),
    });
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.store.sessions.get(id) ?? null;
  }

  async revokeForRotation(input: RotateSessionInput): Promise<boolean> {
    const session = this.store.sessions.get(input.id);
    if (
      session === undefined ||
      !isActive(session, input.now) ||
      session.userId !== input.userId ||
      session.refreshTokenHash !== input.refreshTokenHash
    ) {
      return false;
    }
    this.store.sessions.set(input.id, {
      ...session,
      revokedAt: input.now,
      replacedById: input.replacedById,
    });
    return true;
  }

  async revoke(input: { id: string; userId: string; now: Date }): Promise<boolean> {
    const session = this.store.sessions.get(input.id);
    if (session === undefined || session.userId !== input.userId || !isActive(session, input.now)) {
      return false;
    }
    this.store.sessions.set(input.id, { ...session, revokedAt: input.now });
    return true;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const session of this.store.sessions.values()) {
      if (session.userId === userId && isActive(session, now)) {
        this.store.sessions.set(session.id, { ...session, revokedAt: now });
        revoked += 1;
      }
    }
    return revoked;
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    const expired = [...this.store.sessions.values()]
      .filter((session) => session.expiresAt.getTime() <= now.getTime())
      .slice(0, limit);
    for (const session of expired) this.store.sessions.delete(session.id);
    return expired.length;
  }
}

/** No database, no transaction: the work runs as is (the in-memory writes are synchronous). */
export class InlineTransactionRunner extends TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

/** The three identity persistence bindings, sharing one store. */
export function createInMemoryIdentityPersistence(store = new InMemoryIdentityStore()) {
  return {
    store,
    users: new InMemoryUsersRepository(store),
    sessions: new InMemorySessionsRepository(store),
    transactions: new InlineTransactionRunner(),
  };
}
