import { IDENTITY_GRPC_PACKAGE } from '@domain/identity-contracts';
import { Global, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { RbacModule } from '@platform/auth';
import {
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  generateId,
  ServiceUnavailableException,
  UnauthenticatedException,
} from '@platform/common';
import { AppConfigModule, grpcConfig } from '@platform/config';
import { RlsContextError, SystemDatabaseError } from '@platform/database';
import { AppCacheService } from '@platform/redis';
import { createGrpcServerStrategy } from '@platform/transport';
import { withBoundGrpcPort } from '@platform/transport/testing';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuthTokens, makeUser } from '../../../test/fixtures.js';
import { InMemoryAppCache } from '../../../test/in-memory-app-cache.js';
import { LogoutCommand } from '../../application/commands/logout/logout.command.js';
import { RegisterUserCommand } from '../../application/commands/register-user/register-user.command.js';
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

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

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
    // Port 0: the server binds an OS-chosen port; the clients below learn it once it is bound.
    const cfg = grpcConfig.parse({ GRPC_URL: '127.0.0.1:0' });
    server = await NestFactory.createMicroservice(IdentityServiceTestModule, {
      ...createGrpcServerStrategy(cfg, [IDENTITY_GRPC_PACKAGE]),
      logger: false,
    });
    const { port } = await withBoundGrpcPort(async () => {
      await server.listen();
    });
    vi.stubEnv('IDENTITY_GRPC_URL', `127.0.0.1:${port}`);
    vi.stubEnv('GRPC_DEADLINE_MS', '3000');

    gateway = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeCacheModule,
        RbacModule.forRoot(),
        IdentityApiModule.forRemote(),
      ],
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

  it('GetUser without a principal: RLS_NO_PRINCIPAL is a server bug, INTERNAL with a generic message', async () => {
    // What the runtime pool throws when a unit of work opens without a CLS principal: a guard
    // should have refused the call first, so it stays a logged 500 rather than a client 401.
    queryBus.execute.mockRejectedValue(
      new RlsContextError('RLS_NO_PRINCIPAL', 'RLS context: no principal in CLS'),
    );
    const error = await users.getUser(generateId()).catch((e: unknown) => e);
    // The upstream INTERNAL reaches the gateway's caller as 502 (an upstream failure), not a 401.
    expect(error).not.toBeInstanceOf(UnauthenticatedException);
    expect(error).toMatchObject({ httpStatus: 502 });
    expect((error as Error).message).not.toContain('RLS context');
  });

  it('GetUser with the system pool missing: SYSTEM_DATABASE_UNAVAILABLE (503), message generic', async () => {
    queryBus.execute.mockRejectedValue(
      new SystemDatabaseError(
        'SYSTEM_DATABASE_UNAVAILABLE',
        'System method users.findByIdInTenant: no system pool (set DATABASE_SYSTEM_URL)',
      ),
    );
    const error = await users.getUser(generateId(), { tenantId: TENANT }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).toMatchObject({ httpStatus: 503, code: 'SYSTEM_DATABASE_UNAVAILABLE' });
    expect((error as Error).message).not.toContain('DATABASE_SYSTEM_URL');
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
    const page = await users.listUsers({ limit: 0, tenantId: TENANT });

    expect(queryBus.execute).toHaveBeenNthCalledWith(1, new GetUsersByIdsQuery([a.id, b.id]));
    expect(queryBus.execute).toHaveBeenNthCalledWith(
      2,
      new ListUsersQuery(TENANT, 0, undefined, undefined),
    );
    expect(page).toEqual({ items: [a] });
    expect(page).not.toHaveProperty('nextCursor');
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
