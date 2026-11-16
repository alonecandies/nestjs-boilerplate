import {
  type GetUserRequest,
  type GetUsersByIdsRequest,
  type ListUsersRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '@domain/identity-contracts';
import { QueryBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import { GrpcController, ZodRpcValidationPipe } from '@platform/transport';
import { toListUsersQuery } from '../../application/mappers/identity-request.mapper.js';
import { GetUserByIdQuery } from '../../application/queries/get-user-by-id/get-user-by-id.query.js';
import { GetUsersByIdsQuery } from '../../application/queries/get-users-by-ids/get-users-by-ids.query.js';
import { GlobalRolesRemovedException } from '../../domain/identity.errors.js';
import {
  getUserRequestSchema,
  getUsersByIdsRequestSchema,
  listUsersRequestSchema,
} from './identity-rpc.payloads.js';

/** `identity.v1.UsersService` (identity-service): user queries. */
@GrpcController()
@UsersServiceControllerMethods()
export class UsersGrpcController implements UsersServiceController {
  constructor(private readonly queryBus: QueryBus) {}

  getUser(
    @Payload(new ZodRpcValidationPipe(getUserRequestSchema)) request: GetUserRequest,
  ): Promise<User> {
    return this.queryBus.execute(new GetUserByIdQuery(request.id, request.tenantId));
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

  /** Retired with global roles (B2): kept in identity.v1 (additive contract), always FAILED_PRECONDITION. */
  updateUserRoles(): Promise<User> {
    return Promise.reject(new GlobalRolesRemovedException());
  }
}
