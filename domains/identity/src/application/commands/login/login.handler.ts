import type { AuthTokens } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, runWithPrincipal } from '@platform/common';
import { normalizeEmail } from '../../../domain/email.js';
import { InvalidCredentialsException } from '../../../domain/identity.errors.js';
import { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import { toUserRecord } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { MembershipActivity } from '../../services/membership-activity.elevated.js';
import { PersonalWorkspaces } from '../../services/personal-workspaces.service.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { TenantSelection } from '../../services/tenant-selection.service.js';
import { LoginCommand } from './login.command.js';

/**
 * Login (plan B3 Task 12 flow table):
 * 1. `users.findCredentialsByEmail` (pre-auth system read); the argon2 check runs outside any
 *    transaction;
 * 2. as `{ user, null }`: the best-effort re-hash (its own unit of work), then pick the membership;
 * 3. as `{ user, tenant, roles }`: `touch` (`membership-activity`) and the session insert, in one
 *    unit of work; an account without a membership instead gets, as
 *    `{ user, newTenant, ['owner'] }`, its workspace (`tenant-bootstrap`) and the session.
 */
@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  private readonly logger = new Logger(LoginHandler.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly usersSystem: UsersSystemRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionTokens: SessionTokensService,
    private readonly selection: TenantSelection,
    private readonly workspaces: PersonalWorkspaces,
    private readonly bootstrap: TenantBootstrap,
    private readonly activity: MembershipActivity,
  ) {}

  async execute(command: LoginCommand): Promise<AuthTokens> {
    // pre-auth system read (spec §9 method 1): there is no principal before the password check.
    const credentials = await this.usersSystem.findCredentialsByEmail(
      normalizeEmail(command.email),
    );
    if (!credentials) {
      // Same argon2 cost as a real verification: "unknown email" and "wrong password" are
      // indistinguishable by timing as well as by response (no user enumeration).
      await this.hasher.verifyDummy(command.password);
      throw new InvalidCredentialsException();
    }
    if (!(await this.hasher.verify(credentials.passwordHash, command.password))) {
      throw new InvalidCredentialsException();
    }
    const user = toUserRecord(credentials);
    // I-2: the re-hash and the tenant choice are user-scoped (no tenant yet).
    const membership = await runWithPrincipal(
      createPrincipal({ userId: user.id, tenantId: null }),
      async () => {
        if (this.hasher.needsRehash(credentials.passwordHash)) {
          await this.rehash(user.id, command.password);
        }
        return this.selection.forLogin(user, command.tenantId);
      },
    );
    const now = new Date();
    if (membership === null) {
      // A pre-tenancy account: its workspace id is generated before the unit of work opens.
      const workspace = this.workspaces.plan(user);
      return this.sessionTokens.open(
        { user, tenantId: workspace.id, roles: ['owner'], client: command.client },
        () => this.bootstrap.create(workspace, user.id, now),
      );
    }
    return this.sessionTokens.open(
      {
        user,
        tenantId: membership.tenantId,
        roles: membership.roles,
        client: command.client,
      },
      () => this.activity.touch(membership.tenantId, user.id, now),
    );
  }

  /**
   * Upgrades the stored hash to the current argon2 parameters while we hold the plaintext: the
   * hash is computed outside any transaction, the UPDATE is its own unit of work.
   * Best effort: a failure must never fail the login.
   */
  private async rehash(userId: string, password: string): Promise<void> {
    try {
      const passwordHash = await this.hasher.hash(password);
      await this.users.updatePasswordHash(userId, passwordHash, new Date());
    } catch (error) {
      this.logger.warn({ err: error, userId }, 'Password re-hash failed');
    }
  }
}
