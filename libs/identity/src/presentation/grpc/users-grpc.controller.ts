import {
  type GetUserRequest,
  type GetUsersByIdsRequest,
  type ListUsersRequest,
  type UpdateUserRolesRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '@app/contracts';
import { GrpcController, ZodRpcValidationPipe } from '@app/transport';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import {
  toListUsersQuery,
  toUpdateUserRolesCommand,
} from '../../application/mappers/identity-request.mapper.js';
import { GetUserByIdQuery } from '../../application/queries/get-user-by-id/get-user-by-id.query.js';
import { GetUsersByIdsQuery } from '../../application/queries/get-users-by-ids/get-users-by-ids.query.js';
import {
  getUserRequestSchema,
  getUsersByIdsRequestSchema,
  listUsersRequestSchema,
  updateUserRolesRequestSchema,
} from './identity-rpc.payloads.js';

/** `identity.v1.UsersService` (identity-service): queries + role administration. */
@GrpcController()
@UsersServiceControllerMethods()
export class UsersGrpcController implements UsersServiceController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  getUser(
    @Payload(new ZodRpcValidationPipe(getUserRequestSchema)) request: GetUserRequest,
  ): Promise<User> {
    return this.queryBus.execute(new GetUserByIdQuery(request.id));
  }

  async getUsersByIds(
    @Payload(new ZodRpcValidationPipe(getUsersByIdsRequestSchema)) request: GetUsersByIdsRequest,
  ): Promise<UserList> {
    return { users: await this.queryBus.execute(new GetUsersByIdsQuery(request.ids)) };
  }

  listUsers(
    @Payload(new ZodRpcValidationPipe(listUsersRequestSchema)) request: ListUsersRequest,
  ): Promise<UserPage> {
    return this.queryBus.execute(toListUsersQuery(request));
  }

  updateUserRoles(
    @Payload(new ZodRpcValidationPipe(updateUserRolesRequestSchema))
    request: UpdateUserRolesRequest,
  ): Promise<User> {
    return this.commandBus.execute(toUpdateUserRolesCommand(request));
  }
}
