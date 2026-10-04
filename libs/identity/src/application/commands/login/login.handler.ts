import { PasswordHasher } from '@app/auth';
import { normalizeEmail } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InvalidCredentialsException } from '../../../domain/identity.errors.js';
import type { UserSnapshot } from '../../../domain/user.aggregate.js';
import { toUserRecord } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { LoginCommand } from './login.command.js';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  private readonly logger = new Logger(LoginHandler.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionTokens: SessionTokensService,
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
    return this.sessionTokens.open(toUserRecord(credentials), command.client);
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
