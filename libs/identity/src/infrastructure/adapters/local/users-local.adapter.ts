import type { ListUsersRequest, UpdateUserRolesRequest, User, UserPage } from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  toListUsersQuery,
  toUpdateUserRolesCommand,
} from '../../../application/mappers/identity-request.mapper.js';
import type { UsersPort } from '../../../application/ports/users.port.js';
import { GetUserByIdQuery } from '../../../application/queries/get-user-by-id/get-user-by-id.query.js';
import { GetUsersByIdsQuery } from '../../../application/queries/get-users-by-ids/get-users-by-ids.query.js';

/** Monolith binding of `UsersPort`: in-process QueryBus / CommandBus. */
@Injectable()
export class UsersLocalAdapter implements UsersPort {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  getUser(id: string): Promise<User> {
    return this.queryBus.execute(new GetUserByIdQuery(id));
  }

  getUsersByIds(ids: readonly string[]): Promise<User[]> {
    return this.queryBus.execute(new GetUsersByIdsQuery(ids));
  }

  listUsers(query: ListUsersRequest): Promise<UserPage> {
    return this.queryBus.execute(toListUsersQuery(query));
  }

  updateUserRoles(input: UpdateUserRolesRequest): Promise<User> {
    return this.commandBus.execute(toUpdateUserRolesCommand(input));
  }
}
