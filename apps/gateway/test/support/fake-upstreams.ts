import { type AccessTokenDenylist, isRole, type TokenService } from '@app/auth';
import { EntityNotFoundException, generateId, normalizeEmail } from '@app/common';
import type {
  AuthTokens,
  ListNotificationsRequest,
  ListUsersRequest,
  LoginRequest,
  LogoutRequest,
  MarkNotificationReadRequest,
  Notification,
  NotificationPage,
  RefreshTokensRequest,
  RegisterRequest,
  UpdateUserRolesRequest,
  User,
  UserPage,
} from '@app/contracts';
import {
  AuthPort,
  EmailAlreadyTakenException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  UsersPort,
} from '@app/identity';
import { NotificationNotFoundException, NotificationsPort } from '@app/notifications';

/*
 * In-memory stand-ins for identity- and notifications-service, bound IN PLACE OF the gRPC
 * adapters (the ports are the seam). They return the same `@app/contracts` shapes and throw the
 * same DomainExceptions the gRPC adapters map from status codes + error trailers, so the
 * gateway's presentation, guards, filters and caches run exactly as against the real services.
 * Tokens are signed with the gateway's own TokenService: in production identity-service signs them
 * with the same JWT_ACCESS_SECRET, which is what lets the gateway verify them locally.
 */

interface StoredUser {
  user: User;
  password: string;
}

/** The fake identity-service's state (tests promote users or inspect calls through it). */
export class FakeIdentityState {
  readonly users = new Map<string, StoredUser>();
  readonly calls: string[] = [];

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
    private readonly tokens: TokenService,
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
    return this.issue(user);
  }

  async login(input: LoginRequest): Promise<AuthTokens> {
    this.state.calls.push('AuthService.Login');
    const entry = this.state.byEmail(normalizeEmail(input.email));
    if (entry?.password !== input.password) throw new InvalidCredentialsException();
    return this.issue(entry.user);
  }

  async refreshTokens(input: RefreshTokensRequest): Promise<AuthTokens> {
    this.state.calls.push('AuthService.RefreshTokens');
    const claims = await this.tokens.verifyRefreshToken(input.refreshToken).catch(() => {
      throw new InvalidRefreshTokenException();
    });
    const entry = this.state.users.get(claims.sub);
    if (!entry) throw new InvalidRefreshTokenException();
    return this.issue(entry.user);
  }

  async logout(input: LogoutRequest): Promise<void> {
    this.state.calls.push('AuthService.Logout');
    // identity-service denylists the access jti in the Redis the gateway reads.
    await this.denylist.deny(input.accessTokenJti, Number(input.accessTokenExp));
  }

  private async issue(user: User): Promise<AuthTokens> {
    const access = await this.tokens.issueAccessToken({
      id: user.id,
      email: user.email,
      roles: user.roles.filter(isRole),
    });
    const refresh = await this.tokens.issueRefreshToken({
      userId: user.id,
      sessionId: generateId(),
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      tokenType: 'Bearer',
      user,
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

/** The fake notifications-service inbox. */
export class FakeNotificationsPort extends NotificationsPort {
  readonly inbox = new Map<string, Notification[]>();

  add(notification: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification {
    const stored: Notification = {
      ...notification,
      id: generateId(),
      read: false,
      createdAt: new Date(),
    };
    this.inbox.set(stored.userId, [stored, ...(this.inbox.get(stored.userId) ?? [])]);
    return stored;
  }

  async list(input: ListNotificationsRequest): Promise<NotificationPage> {
    return { items: (this.inbox.get(input.userId) ?? []).slice(0, input.limit) };
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    const notification = this.inbox
      .get(input.userId)
      ?.find((candidate) => candidate.id === input.notificationId);
    if (!notification) throw new NotificationNotFoundException(input.notificationId);
    notification.read = true;
  }
}
