import type { AuthTokens } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, runWithPrincipal } from '@platform/common';
import { normalizeEmail } from '../../../domain/email.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { InvalidCredentialsException } from '../../../domain/identity.errors.js';
import type { UserSnapshot } from '../../../domain/user.aggregate.js';
import { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import { toUserRecord } from '../../mappers/user.mapper.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { TenantSelection } from '../../services/tenant-selection.service.js';
import { LoginCommand } from './login.command.js';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  private readonly logger = new Logger(LoginHandler.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionTokens: SessionTokensService,
    private readonly transaction: TransactionRunner,
    private readonly selection: TenantSelection,
    private readonly events: EventBus,
  ) {}

  async execute(command: LoginCommand): Promise<AuthTokens> {
    const credentials = await this.users.findCredentialsByEmail(normalizeEmail(command.email));
    if (!credentials) {
      // Same argon2 cost as a real verification: "unknown email" and "wrong password" are
      // indistinguishable by timing as well as by response (no user enumeration).
      await this.hasher.verifyDummy(command.password);
      throw new InvalidCredentialsException();
    }
    if (!(await this.hasher.verify(credentials.passwordHash, command.password))) {
      throw new InvalidCredentialsException();
    }
    if (this.hasher.needsRehash(credentials.passwordHash)) {
      await this.rehash(credentials, command.password);
    }
    const user = toUserRecord(credentials);
    const now = new Date();
    // Tenant choice (and, for a pre-tenancy account, its personal workspace) + the session: one unit.
    // I-2: tenant selection is a user-scoped unit of work (no tenant yet).
    const { tokens, membership } = await runWithPrincipal(
      createPrincipal({ userId: user.id, tenantId: null }),
      () =>
        this.transaction.run(async () => {
          const membership = await this.selection.forLogin(user, command.tenantId, now);
          const tokens = await this.sessionTokens.open({
            user,
            tenantId: membership.tenantId,
            roles: membership.roles,
            client: command.client,
          });
          return { tokens, membership };
        }),
    );
    // A workspace this login created is published once the unit of work committed.
    if (membership.workspaceCreated === true) {
      this.events.publish(
        new MembershipCreatedEvent({
          tenantId: membership.tenantId,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          actorId: user.id,
          occurredAt: now,
        }),
      );
    }
    return tokens;
  }

  /**
   * Upgrades the stored hash to the current argon2 parameters while we hold the plaintext.
   * Best effort: a failure must never fail the login.
   */
  private async rehash(user: UserSnapshot, password: string): Promise<void> {
    try {
      await this.users.updatePasswordHash(user.id, await this.hasher.hash(password), new Date());
    } catch (error) {
      this.logger.warn({ err: error, userId: user.id }, 'Password re-hash failed');
    }
  }
}
