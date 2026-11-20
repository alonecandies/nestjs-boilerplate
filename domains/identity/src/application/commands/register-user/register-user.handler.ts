import type { AuthTokens } from '@domain/identity-contracts';
import { CommandHandler, EventBus, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { generateId } from '@platform/common';
import { normalizeEmail } from '../../../domain/email.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { UserRegisteredEvent } from '../../../domain/events/user-registered.event.js';
import { EmailAlreadyTakenException } from '../../../domain/identity.errors.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import { toUserRecord } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { IdentityIntegrationEvents } from '../../services/identity-integration-events.service.js';
import { PersonalWorkspaces } from '../../services/personal-workspaces.service.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { RegisterUserCommand } from './register-user.command.js';

/**
 * Register (plan B3 Task 12 flow table): `users.existsByEmail` (pre-auth system read), the argon2
 * hash outside any transaction, the user and workspace ids generated first, then ONE unit of work as
 * `{ newUser, newTenant, ['owner'] }`: user, tenant, owner membership (`tenant-bootstrap`), the
 * `identity.user-registered.v1` and `identity.membership-created.v1` outbox rows (G-1: no
 * registration commits without its events), session. The domain events go to the in-process
 * EventBus only after the commit.
 */
@CommandHandler(RegisterUserCommand)
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand> {
  constructor(
    private readonly users: UsersRepository,
    private readonly usersSystem: UsersSystemRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionTokens: SessionTokensService,
    private readonly publisher: EventPublisher,
    private readonly workspaces: PersonalWorkspaces,
    private readonly bootstrap: TenantBootstrap,
    private readonly events: EventBus,
    private readonly integrationEvents: IdentityIntegrationEvents,
  ) {}

  async execute(command: RegisterUserCommand): Promise<AuthTokens> {
    const email = normalizeEmail(command.email);
    // Cheap pre-check that skips the argon2 hash (tens of ms of CPU) for the common duplicate
    // case. The unique constraint still decides under concurrent registrations (→ same 409).
    // pre-auth system read (spec §9 method 2): no principal exists yet.
    if (await this.usersSystem.existsByEmail(email)) throw new EmailAlreadyTakenException();

    const passwordHash = await this.hasher.hash(command.password);
    const now = new Date();
    // Chosen up front: UserRegisteredEvent names the personal workspace as its tenant.
    const personalTenantId = generateId();
    const user = this.publisher.mergeObjectContext(
      UserAggregate.register({
        id: generateId(),
        email,
        displayName: command.displayName,
        passwordHash,
        now,
        personalTenantId,
      }),
    );
    const snapshot = user.toSnapshot();
    const workspace = this.workspaces.plan(snapshot, personalTenantId);
    const registered = user
      .getUncommittedEvents()
      .find((event): event is UserRegisteredEvent => event instanceof UserRegisteredEvent);
    if (registered === undefined) throw new Error('UserAggregate.register applied no event');
    // The account's personal-workspace membership, in that workspace.
    const membership = new MembershipCreatedEvent({
      tenantId: workspace.id,
      userId: snapshot.id,
      email: snapshot.email,
      displayName: snapshot.displayName,
      actorId: snapshot.id,
      occurredAt: now,
    });

    // User, personal workspace (tenant + owner membership), the two outbox rows and the first
    // session: one transaction.
    const tokens = await this.sessionTokens.open(
      {
        user: toUserRecord(snapshot),
        tenantId: workspace.id,
        roles: ['owner'],
        client: command.client,
      },
      async () => {
        await this.users.insert(user);
        await this.bootstrap.create(workspace, snapshot.id, now);
        await this.integrationEvents.userRegistered(registered);
        await this.integrationEvents.membershipCreated(membership);
      },
    );

    // In-process handlers run only once the rows are committed: the account, then its
    // personal-workspace membership (the outbox relay publishes the integration events).
    user.commit();
    this.events.publish(membership);
    return tokens;
  }
}
