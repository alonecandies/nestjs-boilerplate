import {
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  generateId,
  UnauthenticatedException,
} from '@app/common';
import { AppConfigModule, grpcConfig } from '@app/config';
import { AppCacheService } from '@app/redis';
import { createGrpcServerStrategy } from '@app/transport';
import { Global, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuthTokens, makeUser } from '../../../test/fixtures.js';
import { freePort } from '../../../test/free-port.js';
import { InMemoryAppCache } from '../../../test/in-memory-app-cache.js';
import { LogoutCommand } from '../../application/commands/logout/logout.command.js';
import { RegisterUserCommand } from '../../application/commands/register-user/register-user.command.js';
import { UpdateUserRolesCommand } from '../../application/commands/update-user-roles/update-user-roles.command.js';
import { AuthPort } from '../../application/ports/auth.port.js';
import { UsersPort } from '../../application/ports/users.port.js';
import { GetUserByIdQuery } from '../../application/queries/get-user-by-id/get-user-by-id.query.js';
import { GetUsersByIdsQuery } from '../../application/queries/get-users-by-ids/get-users-by-ids.query.js';
import { ListUsersQuery } from '../../application/queries/list-users/list-users.query.js';
import {
  EmailAlreadyTakenException,
  RefreshTokenReuseDetectedException,
} from '../../domain/identity.errors.js';
import { IdentityApiModule } from '../../identity-api.module.js';
import { AuthGrpcAdapter } from '../../infrastructure/adapters/grpc/auth-grpc.adapter.js';
import { UsersGrpcAdapter } from '../../infrastructure/adapters/grpc/users-grpc.adapter.js';
import { AuthGrpcController } from './auth-grpc.controller.js';
import { UsersGrpcController } from './users-grpc.controller.js';

/*
 * In-process end-to-end test of the microservice topology, no infrastructure:
 *   gateway side: IdentityApiModule.forRemote() → AuthGrpcAdapter / UsersGrpcAdapter
 *     → (real gRPC, identity.v1 protos, loopback) →
 *   service side: AuthGrpcController / UsersGrpcController → (fake) CommandBus / QueryBus.
 * Covers payload validation, request→command mapping, null normalisation and the error hop
 * (DomainException → status + trailers → DomainException with the same code).
 */

const commandBus = { execute: vi.fn() };
const queryBus = { execute: vi.fn() };

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [AuthGrpcController, UsersGrpcController],
  providers: [
    { provide: CommandBus, useValue: commandBus },
    { provide: QueryBus, useValue: queryBus },
  ],
})
class IdentityServiceTestModule {}

/** The gateway's global AppCacheModule, faked. */
@Global()
@Module({
  providers: [{ provide: AppCacheService, useValue: new InMemoryAppCache() }],
  exports: [AppCacheService],
})
class FakeCacheModule {}

describe('identity over gRPC (forRemote adapters ↔ gRPC controllers)', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let auth: AuthPort;
  let users: UsersPort;

  beforeAll(async () => {
    const port = await freePort();
    vi.stubEnv('IDENTITY_GRPC_URL', `127.0.0.1:${port}`);
    vi.stubEnv('GRPC_DEADLINE_MS', '3000');
    const cfg = grpcConfig.parse({ GRPC_URL: `127.0.0.1:${port}` });
    server = await NestFactory.createMicroservice(IdentityServiceTestModule, {
      ...createGrpcServerStrategy(cfg, ['identity']),
      logger: false,
    });
    await server.listen();

    gateway = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), FakeCacheModule, IdentityApiModule.forRemote()],
    }).compile();
    gateway.useLogger(false);
    await gateway.init();
    auth = gateway.get(AuthPort);
    users = gateway.get(UsersPort);
  });

  afterAll(async () => {
    await gateway?.close();
    await server?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
    queryBus.execute.mockReset();
  });

  it('forRemote() binds the ports to the gRPC adapters', () => {
    expect(auth).toBeInstanceOf(AuthGrpcAdapter);
    expect(users).toBeInstanceOf(UsersGrpcAdapter);
  });

  it('GetUser: query dispatched on the service; Timestamp → Date on the way back', async () => {
    const user = makeUser();
    queryBus.execute.mockResolvedValue(user);

    await expect(users.getUser(user.id)).resolves.toEqual(user);
    expect(queryBus.execute).toHaveBeenCalledWith(new GetUserByIdQuery(user.id));
  });

  it('GetUser: EntityNotFoundException survives the hop (NOT_FOUND)', async () => {
    const id = generateId();
    queryBus.execute.mockRejectedValue(new EntityNotFoundException('User', id));
    const error = await users.getUser(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntityNotFoundException);
    expect(error).toMatchObject({ httpStatus: 404, details: { entity: 'User', id } });
  });

  it('GetUser: an invalid id is rejected by the zod pipe (INVALID_ARGUMENT) before the bus', async () => {
    const error = await users.getUser('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationException);
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it('GetUsersByIds + ListUsers: batch query; absent next_cursor stays absent', async () => {
    const [a, b] = [makeUser(), makeUser()];
    queryBus.execute.mockResolvedValueOnce([a, b]).mockResolvedValueOnce({ items: [a] });

    await expect(users.getUsersByIds([a.id, b.id])).resolves.toEqual([a, b]);
    const page = await users.listUsers({ limit: 0 });

    expect(queryBus.execute).toHaveBeenNthCalledWith(1, new GetUsersByIdsQuery([a.id, b.id]));
    expect(queryBus.execute).toHaveBeenNthCalledWith(
      2,
      new ListUsersQuery(0, undefined, undefined),
    );
    expect(page).toEqual({ items: [a] });
    expect(page).not.toHaveProperty('nextCursor');
  });

  it('UpdateUserRoles → UpdateUserRolesCommand', async () => {
    const [id, actorId] = [generateId(), generateId()];
    queryBus.execute.mockReset();
    commandBus.execute.mockResolvedValue(makeUser({ id, roles: ['moderator'] }));
    await expect(
      users.updateUserRoles({ id, roles: ['moderator'], actorId }),
    ).resolves.toMatchObject({ id, roles: ['moderator'] });
    expect(commandBus.execute).toHaveBeenCalledWith(
      new UpdateUserRolesCommand(id, ['moderator'], actorId),
    );
  });

  it('Register: payload validated + normalised, tokens (with nested user) normalised back', async () => {
    const tokens = makeAuthTokens();
    commandBus.execute.mockResolvedValue(tokens);

    await expect(
      auth.register({
        email: ' ada@example.com ',
        password: 'correct horse',
        displayName: ' Ada ',
      }),
    ).resolves.toEqual(tokens);
    // No ClientInfo sent → decoded as null on the service → undefined in the command.
    expect(commandBus.execute).toHaveBeenCalledWith(
      new RegisterUserCommand('ada@example.com', 'correct horse', 'Ada', undefined),
    );
  });

  it('Register: domain codes survive the hop (EMAIL_TAKEN → 409 DomainConflictException)', async () => {
    commandBus.execute.mockRejectedValue(new EmailAlreadyTakenException());
    const error = await auth
      .register({ email: 'ada@example.com', password: 'correct horse', displayName: 'Ada' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainConflictException);
    expect(error).toMatchObject({ code: 'EMAIL_TAKEN', httpStatus: 409 });
  });

  it('Register: invalid email → INVALID_ARGUMENT, the command is never dispatched', async () => {
    const error = await auth
      .register({ email: 'not-an-email', password: 'correct horse', displayName: 'Ada' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationException);
    expect((error as DomainValidationException).issues).toEqual([
      expect.objectContaining({ path: 'email' }),
    ]);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('RefreshTokens: reuse detection arrives as a 401 with REFRESH_TOKEN_REUSED', async () => {
    commandBus.execute.mockRejectedValue(new RefreshTokenReuseDetectedException());
    const error = await auth
      .refreshTokens({ refreshToken: 'a.b.c', client: { ip: '10.0.0.1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthenticatedException);
    expect(error).toMatchObject({ code: 'REFRESH_TOKEN_REUSED', httpStatus: 401 });
  });

  it('Logout: int64 exp crosses as a string and becomes a number; Empty → void', async () => {
    const userId = generateId();
    commandBus.execute.mockResolvedValue(undefined);
    await expect(
      auth.logout({ userId, accessTokenJti: 'jti-1', accessTokenExp: '1900000000' }),
    ).resolves.toBeUndefined();
    expect(commandBus.execute).toHaveBeenCalledWith(
      new LogoutCommand(userId, 'jti-1', 1_900_000_000, undefined),
    );
  });
});
