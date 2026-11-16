import type {
  AuthTokens,
  ListUsersRequest,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  UpdateUserRolesRequest,
  User,
  UserPage,
} from '@domain/identity-contracts';
import { type AccessTokenDenylist, isRole } from '@platform/auth';
import {
  EntityNotFoundException,
  generateId,
  normalizeTenantRoles,
  type TenantRole,
} from '@platform/common';
import {
  AuthPort,
  EmailAlreadyTakenException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  MembershipRevokedException,
  normalizeEmail,
  TenantAccessDeniedException,
  UsersPort,
} from '../index.js';
import type { TokenIssuer } from '../infrastructure/security/token-issuer.service.js';

/*
 * In-memory stand-ins for identity-service (`AuthPort`, `UsersPort`), bound IN PLACE OF the gRPC
 * adapters (the ports are the seam). They return the same `@domain/identity-contracts` shapes and
 * throw the same DomainExceptions the gRPC adapters map from status codes + error trailers, so the
 * gateway's presentation, guards, filters and caches run exactly as against the real services.
 * Tokens are signed by identity's real `TokenIssuer`, built from the same env as the gateway's
 * verifier: in production identity-service signs them with the shared JWT_ACCESS_SECRET, which is
 * what lets the gateway verify them locally.
 */

interface StoredUser {
  user: User;
  password: string;
}

/** The fake identity-service's state (tests promote users or inspect calls through it). */
export class FakeIdentityState {
  readonly users = new Map<string, StoredUser>();
  readonly calls: string[] = [];
  readonly tenants = new Map<string, { id: string; name: string; personal: boolean }>();
  readonly memberships: {
    tenantId: string;
    userId: string;
    roles: TenantRole[];
    lastActiveAt: number;
  }[] = [];
  /** Refresh-token session id → its user and tenant. */
  readonly sessions = new Map<string, { userId: string; tenantId: string }>();

  membership(tenantId: string, userId: string) {
    return this.memberships.find((m) => m.tenantId === tenantId && m.userId === userId);
  }

  /** Most recently active first. */
  membershipsOf(userId: string) {
    return this.memberships
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  addMembership(tenantId: string, userId: string, roles: TenantRole[]): void {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, { id: tenantId, name: tenantId, personal: false });
    }
    this.memberships.push({
      tenantId,
      userId,
      roles: normalizeTenantRoles(roles),
      lastActiveAt: 0,
    });
  }

  removeMembership(tenantId: string, userId: string): void {
    const index = this.memberships.findIndex((m) => m.tenantId === tenantId && m.userId === userId);
    if (index >= 0) this.memberships.splice(index, 1);
  }

  byEmail(email: string): StoredUser | undefined {
    return [...this.users.values()].find((entry) => entry.user.email === email);
  }

  /** Replaces a user's roles directly (e.g. an admin for positive RBAC checks). */
  setRoles(id: string, roles: string[]): void {
    const entry = this.users.get(id);
    if (entry) entry.user = { ...entry.user, roles, updatedAt: new Date() };
  }
}

export class FakeAuthPort extends AuthPort {
  constructor(
    private readonly state: FakeIdentityState,
    private readonly tokens: TokenIssuer,
    private readonly denylist: AccessTokenDenylist,
  ) {
    super();
  }

  async register(input: RegisterRequest): Promise<AuthTokens> {
    this.state.calls.push('AuthService.Register');
    const email = normalizeEmail(input.email);
    if (this.state.byEmail(email)) throw new EmailAlreadyTakenException();
    const now = new Date();
    const user: User = {
      id: generateId(),
      email,
      displayName: input.displayName.trim(),
      roles: ['user'],
      createdAt: now,
      updatedAt: now,
    };
    this.state.users.set(user.id, { user, password: input.password });
    const tenantId = generateId();
    this.state.tenants.set(tenantId, {
      id: tenantId,
      name: `${user.displayName}'s workspace`,
      personal: true,
    });
    this.state.memberships.push({
      tenantId,
      userId: user.id,
      roles: ['owner'],
      lastActiveAt: Date.now(),
    });
    return this.issue(user, tenantId);
  }

  async login(input: LoginRequest): Promise<AuthTokens> {
    this.state.calls.push('AuthService.Login');
    const entry = this.state.byEmail(normalizeEmail(input.email));
    if (entry?.password !== input.password) throw new InvalidCredentialsException();
    const membership =
      input.tenantId === undefined
        ? this.state.membershipsOf(entry.user.id)[0]
        : this.state.membership(input.tenantId, entry.user.id);
    if (!membership) {
      if (input.tenantId !== undefined) throw new TenantAccessDeniedException();
      throw new InvalidCredentialsException();
    }
    membership.lastActiveAt = Date.now();
    return this.issue(entry.user, membership.tenantId);
  }

  async refreshTokens(input: RefreshTokensRequest): Promise<AuthTokens> {
    this.state.calls.push('AuthService.RefreshTokens');
    const claims = await this.tokens.verifyRefreshToken(input.refreshToken).catch(() => {
      throw new InvalidRefreshTokenException();
    });
    const entry = this.state.users.get(claims.sub);
    if (!entry) throw new InvalidRefreshTokenException();
    const session = this.state.sessions.get(claims.jti);
    if (!session || session.userId !== entry.user.id) throw new InvalidRefreshTokenException();
    this.state.sessions.delete(claims.jti);
    if (!this.state.membership(session.tenantId, entry.user.id)) {
      throw new MembershipRevokedException();
    }
    return this.issue(entry.user, session.tenantId);
  }

  async logout(input: LogoutRequest): Promise<void> {
    this.state.calls.push('AuthService.Logout');
    // identity-service denylists the access jti in the Redis the gateway reads.
    await this.denylist.deny(input.accessTokenJti, Number(input.accessTokenExp));
  }

  private async issue(user: User, tenantId: string): Promise<AuthTokens> {
    const access = await this.tokens.issueAccessToken({
      id: user.id,
      email: user.email,
      roles: user.roles.filter(isRole),
    });
    const sessionId = generateId();
    this.state.sessions.set(sessionId, { userId: user.id, tenantId });
    const refresh = await this.tokens.issueRefreshToken({ userId: user.id, sessionId });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      tokenType: 'Bearer',
      user,
      tenantId,
      tenantRoles: [...(this.state.membership(tenantId, user.id)?.roles ?? [])],
    };
  }
}

export class FakeUsersPort extends UsersPort {
  constructor(private readonly state: FakeIdentityState) {
    super();
  }

  async getUser(id: string): Promise<User> {
    this.state.calls.push('UsersService.GetUser');
    const entry = this.state.users.get(id);
    if (!entry) throw new EntityNotFoundException('User', id);
    return entry.user;
  }

  async getUsersByIds(ids: readonly string[]): Promise<User[]> {
    this.state.calls.push('UsersService.GetUsersByIds');
    return [...new Set(ids)].flatMap((id) => {
      const entry = this.state.users.get(id);
      return entry ? [entry.user] : [];
    });
  }

  async listUsers(query: ListUsersRequest): Promise<UserPage> {
    this.state.calls.push('UsersService.ListUsers');
    const items = [...this.state.users.values()]
      .map((entry) => entry.user)
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, query.limit);
    return { items };
  }

  async updateUserRoles(input: UpdateUserRolesRequest): Promise<User> {
    this.state.calls.push('UsersService.UpdateUserRoles');
    if (!this.state.users.has(input.id)) throw new EntityNotFoundException('User', input.id);
    this.state.setRoles(input.id, input.roles);
    return this.getUser(input.id);
  }
}
