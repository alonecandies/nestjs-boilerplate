import type { User } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { EntityNotFoundException, SystemContext } from '@platform/common';
import { toUserContract } from '../../mappers/user.mapper.js';
import { SYSTEM_READS } from '../../persistence/system-reads.js';
import { type UserRecord, UsersRepository } from '../../persistence/users.repository.js';
import { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { requireActingIn } from '../../services/tenant-actor.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler implements IQueryHandler<GetUserByIdQuery> {
  constructor(
    private readonly users: UsersRepository,
    private readonly usersSystem: UsersSystemRepository,
  ) {}

  async execute(query: GetUserByIdQuery): Promise<User> {
    const { id, tenantId } = query;
    let user: UserRecord | null;
    if (tenantId === undefined) {
      user = await this.users.findById(id);
    } else {
      // A co-member's row: a system read, for a caller acting in that tenant, with the tenant
      // filter in the SQL (the row-local policies cannot check it).
      requireActingIn(tenantId);
      user = await SystemContext.run(SYSTEM_READS.USER_DIRECTORY, () =>
        this.usersSystem.findByIdInTenant(id, tenantId),
      );
    }
    if (!user) throw new EntityNotFoundException('User', query.id);
    return toUserContract(user);
  }
}
