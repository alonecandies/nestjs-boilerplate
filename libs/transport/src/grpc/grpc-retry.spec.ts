import { createServer } from 'node:net';
import { generateId, ServiceUnavailableException } from '@app/common';
import { type GrpcConfig, grpcConfig } from '@app/config';
import type {
  GetUserRequest,
  GetUsersByIdsRequest,
  ListUsersRequest,
  UpdateUserRolesRequest,
  User,
  UserList,
  UserPage,
  UsersServiceClient,
  UsersServiceController,
} from '@app/contracts';
import { UsersServiceControllerMethods } from '@app/contracts';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ClsModule } from 'nestjs-cls';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcClientOptions } from './grpc-client.options.js';
import { GrpcController } from './grpc-controller.decorator.js';
import { createGrpcServerStrategy } from './grpc-server.options.js';

/**
 * A server that applies its side effect and THEN answers `UNAVAILABLE` (what a client sees when a
 * replica dies after committing). Reads may be replayed; mutations must run exactly once.
 */

const USER: User = {
  id: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  roles: ['user'],
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
  updatedAt: new Date('2026-01-02T03:04:05.678Z'),
};

const invocations = { getUser: 0, updateUserRoles: 0 };

/** Fails the first invocation of a method with UNAVAILABLE, succeeds afterwards. */
function failFirst(method: keyof typeof invocations): void {
  invocations[method] += 1;
  if (invocations[method] === 1) throw new ServiceUnavailableException('replica going away');
}

@GrpcController()
@UsersServiceControllerMethods()
class FlakyUsersGrpcController implements UsersServiceController {
  getUser(_request: GetUserRequest): User {
    failFirst('getUser');
    return USER;
  }

  getUsersByIds(_request: GetUsersByIdsRequest): UserList {
    return { users: [] };
  }

  listUsers(_request: ListUsersRequest): UserPage {
    return { items: [] };
  }

  updateUserRoles(_request: UpdateUserRolesRequest): User {
    failFirst('updateUserRoles');
    return USER;
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [FlakyUsersGrpcController],
})
class FlakyGrpcModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port');
  return address.port;
}

describe('gRPC client retry policy (in-process server)', () => {
  let cfg: GrpcConfig;
  let app: INestMicroservice;
  let client: ClientGrpcProxy | undefined;

  /** A fresh channel per case: retry throttling state is per channel. */
  function usersClient(): UsersServiceClient {
    client = new ClientGrpcProxy(createGrpcClientOptions(cfg, 'identity').options);
    return client.getService<UsersServiceClient>('UsersService');
  }

  beforeAll(async () => {
    const port = await freePort();
    cfg = grpcConfig.parse({
      GRPC_URL: `127.0.0.1:${port}`,
      IDENTITY_GRPC_URL: `127.0.0.1:${port}`,
      GRPC_DEADLINE_MS: '3000',
    });
    app = await NestFactory.createMicroservice(FlakyGrpcModule, {
      ...createGrpcServerStrategy(cfg, ['identity']),
      logger: false,
    });
    await app.listen();
  });

  beforeEach(() => {
    client?.close();
    invocations.getUser = 0;
    invocations.updateUserRoles = 0;
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it('replays an idempotent read that failed with UNAVAILABLE', async () => {
    const user = await lastValueFrom(usersClient().getUser({ id: USER.id }));
    expect(user.id).toBe(USER.id);
    expect(invocations.getUser).toBe(2);
  });

  it('runs a mutation exactly once even when it answers UNAVAILABLE', async () => {
    const error: unknown = await lastValueFrom(
      usersClient().updateUserRoles({ id: USER.id, roles: ['admin'], actorId: USER.id }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 14 });
    expect(invocations.updateUserRoles).toBe(1);
  });
});
