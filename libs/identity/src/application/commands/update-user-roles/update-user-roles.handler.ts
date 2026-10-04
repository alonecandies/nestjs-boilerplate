import { EntityNotFoundException } from '@app/common';
import type { User } from '@app/contracts';
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { toUserContract } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { UpdateUserRolesCommand } from './update-user-roles.command.js';

@CommandHandler(UpdateUserRolesCommand)
export class UpdateUserRolesHandler implements ICommandHandler<UpdateUserRolesCommand> {
  constructor(
    private readonly users: UsersRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: UpdateUserRolesCommand): Promise<User> {
    const found = await this.users.findAggregate(command.userId);
    if (!found) throw new EntityNotFoundException('User', command.userId);

    const user = this.publisher.mergeObjectContext(found);
    // Invariants (known roles, non-empty, an admin cannot drop their own admin role) live in the
    // aggregate; an unchanged role set is a no-op (no write, no event).
    if (user.changeRoles(command.roles, command.actorId, new Date())) {
      const { id, roles, updatedAt } = user.toSnapshot();
      await this.users.updateRoles(id, roles, updatedAt);
      user.commit();
    }
    return toUserContract(user.toSnapshot());
  }
}
