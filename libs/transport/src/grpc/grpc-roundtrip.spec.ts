import { createServer } from 'node:net';
import {
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  ExternalServiceException,
  generateId,
} from '@app/common';
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
import {
  type ChannelCredentials,
  credentials,
  loadPackageDefinition,
  Metadata,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy, Ctx, Payload } from '@nestjs/microservices';
import { protoPath as healthProtoPath } from 'grpc-health-check';
import { ClsModule, ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { grpcCall } from './grpc-call.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { createGrpcClientOptions } from './grpc-client.options.js';
import { GrpcController } from './grpc-controller.decorator.js';
import { createOutgoingMetadata, readIncomingMetadata } from './grpc-metadata.js';
import { createGrpcServerStrategy } from './grpc-server.options.js';
import { ZodRpcValidationPipe } from './zod-rpc-validation.pipe.js';

/**
 * In-process end-to-end test: a real Nest gRPC microservice on a random localhost port and a real
 * `ClientGrpc`, exercising the whole error path
 * DomainException → DomainToGrpcExceptionFilter → status + trailers → grpcCall → DomainException.
 */

class EmailTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}

const KNOWN_USER: User = {
  id: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  roles: ['admin'],
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
  updatedAt: new Date('2026-01-02T03:04:05.678Z'),
};

interface SeenCall {
  requestId: string;
  correlationId: unknown;
  userId?: string | undefined;
  roles: string[];
}
const seen: SeenCall[] = [];

@GrpcController()
@UsersServiceControllerMethods()
class TestUsersGrpcController implements UsersServiceController {
  constructor(private readonly cls: ClsService) {}

  getUser(
    @Payload(new ZodRpcValidationPipe(z.object({ id: z.uuid() }))) request: GetUserRequest,
    @Ctx() metadata?: Metadata,
  ): User {
    const caller = readIncomingMetadata(metadata);
    seen.push({
      requestId: this.cls.getId(),
      correlationId: this.cls.get<unknown>(RPC_CLS_KEYS.CORRELATION_ID),
      userId: caller.userId,
      roles: caller.roles,
    });
    if (request.id !== KNOWN_USER.id) throw new EntityNotFoundException('User', request.id);
    return KNOWN_USER;
  }

  getUsersByIds(_request: GetUsersByIdsRequest): UserList {
    return { users: [KNOWN_USER] };
  }

  listUsers(_request: ListUsersRequest): UserPage {
    throw new Error('relation "users" does not exist (db 10.0.0.12:5432)');
  }

  updateUserRoles(_request: UpdateUserRolesRequest): User {
    throw new EmailTakenException('Email already registered', { details: { field: 'email' } });
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [TestUsersGrpcController],
})
class TestGrpcModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port');
  return address.port;
}

interface HealthClient {
  check(
    request: { service: string },
    callback: (error: Error | null, response?: { status: string }) => void,
  ): void;
  close(): void;
}
type HealthClientConstructor = new (address: string, creds: ChannelCredentials) => HealthClient;

function checkHealth(address: string, service: string): Promise<string | undefined> {
  const definition = loadPackageDefinition(
    loadSync(healthProtoPath, { enums: String }),
  ) as unknown as {
    grpc: { health: { v1: { Health: HealthClientConstructor } } };
  };
  const client = new definition.grpc.health.v1.Health(address, credentials.createInsecure());
  return new Promise((resolve, reject) => {
    client.check({ service }, (error, response) => {
      client.close();
      if (error) reject(error);
      else resolve(response?.status);
    });
  });
}

describe('gRPC round trip (in-process server + ClientGrpc)', () => {
  let cfg: GrpcConfig;
  let app: INestMicroservice;
  let client: ClientGrpcProxy;
  let users: UsersServiceClient;
  const breakers = new GrpcCircuitBreakers();

  const call = <T>(source: Parameters<typeof grpcCall<T>>[0]): Promise<T> =>
    grpcCall(source, {
      timeoutMs: 3_000,
      operation: 'identity.UsersService',
      breaker: breakers.get('identity'),
    });

  beforeAll(async () => {
    const port = await freePort();
    cfg = grpcConfig.parse({
      GRPC_URL: `127.0.0.1:${port}`,
      IDENTITY_GRPC_URL: `127.0.0.1:${port}`,
      GRPC_DEADLINE_MS: '3000',
    });
    app = await NestFactory.createMicroservice(TestGrpcModule, {
      ...createGrpcServerStrategy(cfg, ['identity']),
      logger: false,
    });
    await app.listen();
    client = new ClientGrpcProxy(createGrpcClientOptions(cfg, 'identity').options);
    users = client.getService<UsersServiceClient>('UsersService');
  });

  afterAll(async () => {
    breakers.onApplicationShutdown();
    client?.close();
    await app?.close();
  });

  it('returns the message with Timestamp → Date and propagates caller metadata into nestjs-cls', async () => {
    const requestId = generateId();
    const correlationId = generateId();
    const metadata = createOutgoingMetadata({
      requestId,
      correlationId,
      userId: 'user-7',
      roles: ['admin', 'user'],
    });

    const user = await call(users.getUser({ id: KNOWN_USER.id }, metadata));

    expect(user).toMatchObject({ id: KNOWN_USER.id, email: 'ada@example.com', roles: ['admin'] });
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt?.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(seen.at(-1)).toEqual({
      requestId,
      correlationId,
      userId: 'user-7',
      roles: ['admin', 'user'],
    });
  });

  it('generates a request id when the caller sends none', async () => {
    await call(users.getUser({ id: KNOWN_USER.id }));
    const last = seen.at(-1);
    expect(last?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(last?.correlationId).toBe(last?.requestId);
  });

  it('maps a thrown EntityNotFoundException to NOT_FOUND and back', async () => {
    const id = generateId();
    const error: unknown = await call(users.getUser({ id })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntityNotFoundException);
    expect(error).toMatchObject({
      httpStatus: 404,
      code: 'NOT_FOUND',
      message: `User "${id}" was not found`,
      details: { entity: 'User', id },
      entity: 'User',
      entityId: id,
    });
    expect((error as { cause?: { code?: number } }).cause?.code).toBe(5);
  });

  it('maps a zod payload failure to INVALID_ARGUMENT with the issues', async () => {
    const error: unknown = await call(users.getUser({ id: 'not-a-uuid' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationException);
    expect((error as DomainValidationException).issues).toEqual([
      expect.objectContaining({ path: 'id' }),
    ]);
    expect((error as { cause?: { code?: number } }).cause?.code).toBe(3);
  });

  it('keeps a domain subclass code across the hop (ALREADY_EXISTS + x-error-code)', async () => {
    const error: unknown = await call(
      users.updateUserRoles({ id: KNOWN_USER.id, roles: ['user'], actorId: KNOWN_USER.id }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainConflictException);
    expect(error).toMatchObject({
      code: 'EMAIL_TAKEN',
      message: 'Email already registered',
      details: { field: 'email' },
    });
  });

  it('hides unexpected server errors (INTERNAL, sanitized 502)', async () => {
    const error: unknown = await call(users.listUsers({ limit: 10 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceException);
    expect((error as Error).message).not.toContain('10.0.0.12');
    expect(JSON.stringify((error as ExternalServiceException).details)).not.toContain('users');
    expect((error as { cause?: { code?: number } }).cause?.code).toBe(13);
  });

  it('reports SERVING through grpc.health.v1 once listening', async () => {
    await expect(checkHealth(cfg.url, 'identity.v1.UsersService')).resolves.toBe('SERVING');
    await expect(checkHealth(cfg.url, '')).resolves.toBe('SERVING');
  });

  it('did not open the circuit for caller errors', () => {
    expect(breakers.states()['identity']).toBe('closed');
  });
});
