import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
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
import {
  CLS_PRINCIPAL,
  DomainConflictException,
  DomainValidationException,
  EntityNotFoundException,
  ExternalServiceException,
  generateId,
} from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { protoPath as healthProtoPath } from 'grpc-health-check';
import { ClsModule, ClsService } from 'nestjs-cls';
import { register } from 'prom-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FIXTURE_GRPC_PACKAGE,
  type GetUserRequest,
  type GetUsersByIdsRequest,
  type ListUsersRequest,
  type UpdateUserRolesRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceClient,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '../../test/fixtures/fixture.grpc-package.js';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { GRPC_METADATA_KEYS } from './grpc.constants.js';
import { grpcCall } from './grpc-call.js';
import { callerContextFromCls } from './grpc-caller-context.js';
import { GrpcCircuitBreakers } from './grpc-circuit-breakers.js';
import { createGrpcClientOptions } from './grpc-client.options.js';
import { GrpcController } from './grpc-controller.decorator.js';
import { createOutgoingMetadata, readIncomingMetadata } from './grpc-metadata.js';
import {
  configurePrincipalAssertions,
  GRPC_PRINCIPAL_ASSERTIONS_TOTAL,
  type PrincipalAssertionSettings,
} from './grpc-principal-assertion.js';
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

interface SeenPrincipal {
  /** The principal the handler runs as (CLS_PRINCIPAL). */
  principal: unknown;
  /** The assertion this service would send on its own outgoing call. */
  forwarded: string | undefined;
}
const principals: SeenPrincipal[] = [];

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
    principals.push({
      principal: this.cls.get<unknown>(CLS_PRINCIPAL),
      forwarded: callerContextFromCls(this.cls).principalAssertion,
    });
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
      operation: 'fixture.UsersService',
      breaker: breakers.get('fixture'),
    });

  beforeAll(async () => {
    const port = await freePort();
    cfg = grpcConfig.parse({ GRPC_URL: `127.0.0.1:${port}`, GRPC_DEADLINE_MS: '3000' });
    app = await NestFactory.createMicroservice(TestGrpcModule, {
      ...createGrpcServerStrategy(cfg, [FIXTURE_GRPC_PACKAGE]),
      logger: false,
    });
    await app.listen();
    client = new ClientGrpcProxy(
      createGrpcClientOptions(cfg, { spec: FIXTURE_GRPC_PACKAGE, url: cfg.url }).options,
    );
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
    const userId = generateId();
    const metadata = createOutgoingMetadata({
      requestId,
      correlationId,
      userId,
      roles: ['admin', 'user'],
    });

    const user = await call(users.getUser({ id: KNOWN_USER.id }, metadata));

    expect(user).toMatchObject({ id: KNOWN_USER.id, email: 'ada@example.com', roles: ['admin'] });
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt?.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(seen.at(-1)).toEqual({
      requestId,
      correlationId,
      userId,
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
    await expect(checkHealth(cfg.url, 'fixture.v1.UsersService')).resolves.toBe('SERVING');
    await expect(checkHealth(cfg.url, '')).resolves.toBe('SERVING');
  });

  it('did not open the circuit for caller errors', () => {
    expect(breakers.states()['fixture']).toBe('closed');
  });

  describe('principal assertion (warn mode: verified and counted, nothing refused)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeys = new Map([['edge-1', publicKey]]);
    const signingKey = { keyId: 'edge-1', privateKey, ttlSec: 120 };
    const principal = { userId: generateId(), tenantId: generateId(), roles: ['admin'] };
    const asPrincipal = { ...principal, staff: false };

    afterEach(() => configurePrincipalAssertions(undefined));

    const count = async (outcome: string): Promise<number> => {
      const metric = register.getSingleMetric(GRPC_PRINCIPAL_ASSERTIONS_TOTAL);
      const values = metric === undefined ? [] : (await metric.get()).values;
      return values.find((sample) => sample.labels['outcome'] === outcome)?.value ?? 0;
    };
    const counts = async (): Promise<Record<string, number>> => {
      const outcomes = ['valid', 'missing', 'expired', 'invalid', 'mismatch'];
      return Object.fromEntries(
        await Promise.all(outcomes.map(async (o) => [o, await count(o)] as const)),
      );
    };
    /** Metadata the way a gateway adapter builds it: from the CLS principal of an HTTP request. */
    const edgeMetadata = (): Metadata => {
      const cls = app.get(ClsService);
      return cls.run(() => {
        cls.set(CLS_PRINCIPAL, asPrincipal);
        return createOutgoingMetadata(callerContextFromCls(cls));
      });
    };
    const assertionOf = (metadata: Metadata): string | undefined => {
      const [value] = metadata.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION);
      return typeof value === 'string' ? value : undefined;
    };
    const warn = (extra: Partial<PrincipalAssertionSettings> = {}): void =>
      configurePrincipalAssertions({ mode: 'warn', publicKeys, ...extra });

    it('a call from a signing client carries an assertion the server verifies (valid)', async () => {
      warn({ signingKey });
      const before = await counts();
      const metadata = edgeMetadata();
      expect(assertionOf(metadata)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

      await call(users.getUsersByIds({ ids: [KNOWN_USER.id] }, metadata));

      expect(await counts()).toEqual({ ...before, valid: (before['valid'] ?? 0) + 1 });
      expect(principals.at(-1)?.principal).toEqual(asPrincipal);
    });

    it('a service that received an assertion forwards the same bytes on its own calls', async () => {
      warn({ signingKey });
      const metadata = edgeMetadata();
      await call(users.getUsersByIds({ ids: [KNOWN_USER.id] }, metadata));
      expect(principals.at(-1)?.forwarded).toBe(assertionOf(metadata));
    });

    it('plain headers without an assertion (an old gateway) still reach the handler: missing', async () => {
      warn(); // this process has no signing key: it plays the old gateway
      const before = await counts();
      const metadata = edgeMetadata();
      expect(assertionOf(metadata)).toBeUndefined();

      await call(users.getUsersByIds({ ids: [KNOWN_USER.id] }, metadata));

      expect(await counts()).toEqual({ ...before, missing: (before['missing'] ?? 0) + 1 });
      expect(principals.at(-1)).toEqual({ principal: asPrincipal, forwarded: undefined });
    });

    it('a tampered claim counts invalid; the plain headers still build the principal', async () => {
      warn({ signingKey });
      const [header = '', , signature = ''] = (assertionOf(edgeMetadata()) ?? '').split('.');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'edge',
          sub: principal.userId,
          tid: principal.tenantId,
          roles: ['owner'],
          staff: true,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      ).toString('base64url');
      const before = await counts();
      const tampered = createOutgoingMetadata({
        ...principal,
        roles: ['owner'],
        staff: true,
        principalAssertion: `${header}.${payload}.${signature}`,
      });

      await call(users.getUsersByIds({ ids: [KNOWN_USER.id] }, tampered));

      expect(await counts()).toEqual({ ...before, invalid: (before['invalid'] ?? 0) + 1 });
      expect(principals.at(-1)?.principal).toMatchObject({ roles: ['owner'], staff: true });
    });

    it('a server in off mode (and an old server) ignores the header', async () => {
      configurePrincipalAssertions({ mode: 'off', signingKey, publicKeys });
      const metadata = edgeMetadata();
      metadata.set(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION, 'not.a.jws');
      const before = await counts();

      await call(users.getUsersByIds({ ids: [KNOWN_USER.id] }, metadata));

      expect(await counts()).toEqual(before);
      expect(principals.at(-1)?.principal).toEqual(asPrincipal);
    });
  });
});
