import { PasswordHasher } from '@app/auth';
import { generateId, normalizeEmail } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { EmailAlreadyTakenException } from '../../../domain/identity.errors.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { toUserRecord } from '../../mappers/user.mapper.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { RegisterUserCommand } from './register-user.command.js';

@CommandHandler(RegisterUserCommand)
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand> {
  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionTokens: SessionTokensService,
    private readonly transaction: TransactionRunner,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: RegisterUserCommand): Promise<AuthTokens> {
    const email = normalizeEmail(command.email);
    // Cheap pre-check that skips the argon2 hash (tens of ms of CPU) for the common duplicate
    // case. The unique constraint still decides under concurrent registrations (→ same 409).
    if (await this.users.existsByEmail(email)) throw new EmailAlreadyTakenException();

    const passwordHash = await this.hasher.hash(command.password);
    const user = this.publisher.mergeObjectContext(
      UserAggregate.register({
        id: generateId(),
        email,
        displayName: command.displayName,
        passwordHash,
        now: new Date(),
      }),
    );

    // User + first session commit or roll back together.
    const tokens = await this.transaction.run(async () => {
      await this.users.insert(user);
      return this.sessionTokens.open(toUserRecord(user.toSnapshot()), command.client);
    });

    // Publish UserRegisteredEvent only once the row is committed (the relay then goes to Kafka).
    user.commit();
    return tokens;
  }
}
