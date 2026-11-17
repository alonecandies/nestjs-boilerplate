import { type CursorPage, requirePrincipal } from '@platform/common';
import {
  decodeIdCursor,
  type ElevationReason,
  keysetPage,
  RlsElevation,
  RowCountMismatchError,
} from '@platform/database';
import type { UserAggregate } from '../index.js';
import {
  type AuditEventRecord,
  EmailAlreadyTakenException,
  type InvitationRecord,
  type ListUsersCriteria,
  type MembershipRecord,
  type NewSession,
  type RotateSessionInput,
  type SessionRecord,
  SessionsRepository,
  SessionsSystemRepository,
  type TenantRecord,
  TransactionRunner,
  type UserRecord,
  type UserSnapshot,
  UsersRepository,
  UsersSystemRepository,
} from '../index.js';
import {
  InMemoryAuditEventsRepository,
  InMemoryInvitationsRepository,
  InMemoryInvitationsSystemRepository,
  InMemoryMembershipsRepository,
  InMemoryMembershipsSystemRepository,
  InMemoryTenantsRepository,
  membershipKey,
} from './in-memory-tenancy.js';

/**
 * In-memory implementations of identity's persistence ports (`UsersRepository`,
 * `SessionsRepository`, `TransactionRunner`, and the system ports over the same store). The e2e
 * suite binds them in place of the Drizzle adapters, so the REAL command/query handlers, argon2
 * hashing, JWT issuing, refresh rotation and the Kafka relay run end to end — only the SQL is
 * replaced. Semantics mirror the Drizzle repositories (normalised unique email, conditional
 * rotation, keyset paging on uuidv7 ids, a row-count check on single-row writes); row-level
 * security is not modelled (the int specs cover it).
 */
export class InMemoryIdentityStore {
  readonly users = new Map<string, UserSnapshot>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly tenants = new Map<string, TenantRecord>();
  /** Keyed by `membershipKey(tenantId, userId)`. */
  readonly memberships = new Map<string, MembershipRecord>();
  /** Keyed by `${tenantId}:${id}`. */
  readonly invitations = new Map<string, InvitationRecord>();
  readonly auditEvents: AuditEventRecord[] = [];

  clear(): void {
    this.users.clear();
    this.sessions.clear();
    this.tenants.clear();
    this.memberships.clear();
    this.invitations.clear();
    this.auditEvents.length = 0;
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

  async isPlatformStaff(id: string): Promise<boolean> {
    return this.store.users.get(id)?.isPlatformStaff === true;
  }

  async insert(user: UserAggregate): Promise<void> {
    const snapshot = user.toSnapshot();
    if ([...this.store.users.values()].some((existing) => existing.email === snapshot.email)) {
      throw new EmailAlreadyTakenException();
    }
    this.store.users.set(snapshot.id, snapshot);
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void> {
    const user = this.store.users.get(id);
    if (!user) throw new RowCountMismatchError(1, 0, 'users.updatePasswordHash');
    this.store.users.set(id, { ...user, passwordHash, updatedAt });
  }
}

/** `UsersSystemRepository` over the same store. */
export class InMemoryUsersSystemRepository extends UsersSystemRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async findCredentialsByEmail(email: string): Promise<UserSnapshot | null> {
    return [...this.store.users.values()].find((user) => user.email === email) ?? null;
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.findCredentialsByEmail(email)) !== null;
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<UserRecord | null> {
    const user = this.store.users.get(id);
    if (!user || !this.store.memberships.has(membershipKey(tenantId, id))) return null;
    return toRecord(user);
  }

  async listInTenant(criteria: ListUsersCriteria): Promise<CursorPage<UserRecord>> {
    const after = criteria.cursor === undefined ? undefined : decodeIdCursor(criteria.cursor).id;
    const search = criteria.search?.toLowerCase();
    const rows = [...this.store.users.values()]
      .filter((user) => this.store.memberships.has(membershipKey(criteria.tenantId, user.id)))
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

  async findById(userId: string, id: string): Promise<SessionRecord | null> {
    const session = this.store.sessions.get(id);
    return session?.userId === userId ? session : null;
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
}

/** `SessionsSystemRepository` over the same store. */
export class InMemorySessionsSystemRepository extends SessionsSystemRepository {
  constructor(private readonly store: InMemoryIdentityStore) {
    super();
  }

  async deleteExpired(now: Date): Promise<number> {
    const expired = [...this.store.sessions.values()].filter(
      (session) => session.expiresAt.getTime() <= now.getTime(),
    );
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

/**
 * `RlsElevation` without a database: the in-memory store has no policies and the inline runner no
 * transaction, so the real service (which needs an open runtime transaction) is replaced. It keeps
 * the precondition every elevation has (a principal with a tenant) and records each call; the
 * permission itself is checked by the route guards in e2e (and by the real service in the int specs).
 */
export class InMemoryRlsElevation extends RlsElevation {
  readonly calls: { kind: 'permission' | 'justified'; name: string; tenantId: string }[] = [];

  override async elevate(permission: string): Promise<void> {
    this.calls.push({ kind: 'permission', name: permission, tenantId: this.tenantOfPrincipal() });
  }

  override async justified<T>(reason: ElevationReason, work: () => Promise<T>): Promise<T> {
    this.calls.push({ kind: 'justified', name: reason, tenantId: this.tenantOfPrincipal() });
    return work();
  }

  private tenantOfPrincipal(): string {
    const { tenantId } = requirePrincipal();
    if (tenantId === null) throw new Error('InMemoryRlsElevation: elevation needs a tenant');
    return tenantId;
  }
}

/** Every identity persistence binding (runtime and system ports), sharing one store. */
export function createInMemoryIdentityPersistence(store = new InMemoryIdentityStore()) {
  return {
    store,
    users: new InMemoryUsersRepository(store),
    sessions: new InMemorySessionsRepository(store),
    transactions: new InlineTransactionRunner(),
    tenants: new InMemoryTenantsRepository(store),
    memberships: new InMemoryMembershipsRepository(store),
    invitations: new InMemoryInvitationsRepository(store),
    auditEvents: new InMemoryAuditEventsRepository(store),
    usersSystem: new InMemoryUsersSystemRepository(store),
    sessionsSystem: new InMemorySessionsSystemRepository(store),
    membershipsSystem: new InMemoryMembershipsSystemRepository(store),
    invitationsSystem: new InMemoryInvitationsSystemRepository(store),
    elevation: new InMemoryRlsElevation(),
  };
}
