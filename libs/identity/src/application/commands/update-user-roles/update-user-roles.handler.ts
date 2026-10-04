import { EntityNotFoundException } from '@app/common';
import type { User } from '@app/contracts';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { CannotRemoveLastAdminException } from '../../../domain/identity.errors.js';
import { ADMIN_ROLE } from '../../../domain/user-role.js';
import { toUserContract } from '../../mappers/user.mapper.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { UpdateUserRolesCommand } from './update-user-roles.command.js';

@CommandHandler(UpdateUserRolesCommand)
export class UpdateUserRolesHandler implements ICommandHandler<UpdateUserRolesCommand> {
  constructor(
    private readonly users: UsersRepository,
    private readonly transaction: TransactionRunner,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: UpdateUserRolesCommand): Promise<User> {
    // Read-modify-write in ONE transaction on a locked row: concurrent changes of the same user
    // queue (no lost update, and the event's `previousRoles` is what was really replaced).
    const user = await this.transaction.run(async () => {
      const found = await this.users.findAggregate(command.userId);
      if (!found) throw new EntityNotFoundException('User', command.userId);

      const aggregate = this.publisher.mergeObjectContext(found);
      const wasAdmin = aggregate.hasRole(ADMIN_ROLE);
      // Invariants (known roles, non-empty, an admin cannot drop their own admin role) live in
      // the aggregate; an unchanged role set is a no-op (no write, no event).
      if (!aggregate.changeRoles(command.roles, command.actorId, new Date())) return aggregate;

      // Cross-user invariant: at least one admin remains. `countAdmins` serialises demotions
      // (transaction-scoped lock), so two admins demoting each other cannot both succeed.
      if (wasAdmin && !aggregate.hasRole(ADMIN_ROLE) && (await this.users.countAdmins()) <= 1) {
        throw new CannotRemoveLastAdminException();
      }
      const { id, roles, updatedAt } = aggregate.toSnapshot();
      await this.users.updateRoles(id, roles, updatedAt);
      return aggregate;
    });

    // Publish UserRolesChangedEvent only once the change is committed.
    user.commit();
    return toUserContract(user.toSnapshot());
  }
}
