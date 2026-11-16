import {
  IDENTITY_GRPC_PACKAGE,
  type ListUsersRequest,
  USERS_SERVICE_NAME,
  type User,
  type UserPage,
  type UsersServiceClient,
} from '@domain/identity-contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { UsersPort } from '../../../application/ports/users.port.js';
import { normalizeUser, normalizeUserPage } from './grpc-contract.normalizer.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';

const operation = (method: string): string => `identity.v1.${USERS_SERVICE_NAME}/${method}`;

/** Gateway binding of `UsersPort`: `identity.v1.UsersService` over gRPC. */
@Injectable()
export class UsersGrpcAdapter implements UsersPort, OnModuleInit {
  private users: UsersServiceClient;

  constructor(
    @Inject(IDENTITY_GRPC_PACKAGE.clientToken) private readonly client: ClientGrpc,
    private readonly caller: IdentityGrpcCaller,
  ) {}

  onModuleInit(): void {
    this.users = this.client.getService<UsersServiceClient>(USERS_SERVICE_NAME);
  }

  async getUser(id: string): Promise<User> {
    const user = await this.caller.call(operation('GetUser'), (metadata) =>
      this.users.getUser({ id }, metadata),
    );
    return normalizeUser(user);
  }

  async getUsersByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const list = await this.caller.call(operation('GetUsersByIds'), (metadata) =>
      this.users.getUsersByIds({ ids: [...ids] }, metadata),
    );
    return (list.users ?? []).map(normalizeUser);
  }

  async listUsers(query: ListUsersRequest): Promise<UserPage> {
    const page = await this.caller.call(operation('ListUsers'), (metadata) =>
      this.users.listUsers(query, metadata),
    );
    return normalizeUserPage(page);
  }
}
