import { EntityNotFoundException } from '@app/common';
import type { User } from '@app/contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { toUserContract } from '../../mappers/user.mapper.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler implements IQueryHandler<GetUserByIdQuery> {
  constructor(private readonly users: UsersRepository) {}

  async execute(query: GetUserByIdQuery): Promise<User> {
    const user = await this.users.findById(query.id);
    if (!user) throw new EntityNotFoundException('User', query.id);
    return toUserContract(user);
  }
}
