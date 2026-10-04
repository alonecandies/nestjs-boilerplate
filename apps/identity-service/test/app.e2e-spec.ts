import {
  DomainValidationException,
  EntityNotFoundException,
  generateId,
  UnauthenticatedException,
} from '@app/common';
import { type GrpcConfig, grpcConfig } from '@app/config';
import type { AuthServiceClient, UsersServiceClient } from '@app/contracts';
import { DRIZZLE } from '@app/database';
import { identitySchema, users } from '@app/identity';
import { REDIS_CLIENT } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import {
  createGrpcClientOptions,
  FakeKafkaProducer,
  GrpcCircuitBreakers,
  grpcCall,
  KafkaProducer,
} from '@app/transport';
import { type ServiceError, status } from '@grpc/grpc-js';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { freePort } from './support/free-port.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * identity-service end to end, no Docker: the REAL AppModule (CQRS, handlers, repositories,
 * AuthModule, observability, common enhancers) with fakes only at the network edges — a drizzle
 * instance over a fake postgres.js client, an in-memory Redis and a recording Kafka producer.
 * gRPC is real: the app's server listens on a loopback port and a gateway-style ClientGrpcProxy
 * (same client options as `GrpcClientsModule`) calls it.
 */

const KNOWN_USER_ID = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d';
const CREATED_AT = new Date('2026-09-01T10:00:00.123Z');
const UPDATED_AT = new Date('2026-09-02T11:30:00.456Z');

/** The `users` row as postgres.js returns it (password hash never selected by the repository). */
function knownUserRow(): FakeRow {
  const values: Record<string, unknown> = {
    id: KNOWN_USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    roles: '{user}', // enum arrays arrive as a Postgres array literal
    createdAt: CREATED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
  };
  const { passwordHash: _passwordHash, ...selected } = getTableColumns(users);
  return Object.fromEntries(Object.keys(selected).map((column) => [column, values[column]]));
}

const postgres = createFakePostgres(identitySchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  if (sql.includes('from "users" where "users"."id"') && params[0] === KNOWN_USER_ID) {
    return [knownUserRow()];
  }
  return []; // unknown ids and e-mails
});

describe('identity-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let usersClient: UsersServiceClient;
  let authClient: AuthServiceClient;
  const breakers = new GrpcCircuitBreakers();

  /** What the gateway adapters do: deadline + breaker + ServiceError → DomainException. */
  const call = <T>(source: Observable<T>, operation: string): Promise<T> =>
    grpcCall(source, { timeoutMs: 3_000, operation, breaker: breakers.get('identity') });

  beforeAll(async () => {
    const grpcUrl = `127.0.0.1:${await freePort()}`;
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'identity-service',
      GRPC_URL: grpcUrl,
      IDENTITY_GRPC_URL: grpcUrl,
      GRPC_DEADLINE_MS: '3000',
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(new FakeKafkaProducer({ source: 'identity-service' }));
    app = await startServiceTestApp(builder, { grpc: ['identity'] });

    client = new ClientGrpcProxy(createGrpcClientOptions(grpcConfig.parse(), 'identity').options);
    usersClient = client.getService<UsersServiceClient>('UsersService');
    authClient = client.getService<AuthServiceClient>('AuthService');
  }, 60_000);

  afterAll(async () => {
    breakers.onApplicationShutdown();
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
    // The Postgres pool is released by DatabaseModule's shutdown hook.
    expect(postgres.end).toHaveBeenCalled();
  }, 30_000);

  describe('HTTP (ops only)', () => {
    it('GET /health/live → 200 without touching any dependency', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('GET /metrics → Prometheus text (Node default metrics + HTTP latency histogram)', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('process_cpu_user_seconds_total');
      expect(response.body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /health/ready → checks exactly postgres, redis and kafka (no broker → 503)', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      const body = response.json<{ info: object; error: object }>();
      expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual([
        'kafka',
        'postgres',
        'redis',
      ]);
      expect(body.info).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' } });
      expect(body.error).toMatchObject({ kafka: { status: 'down' } });
      expect(response.statusCode).toBe(503);
    }, 15_000);

    it('an unknown route is a problem+json 404 (common enhancers)', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/users' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('gRPC identity.v1', () => {
    it('the gRPC namespace resolves from the app container (connectGrpcServer never falls back)', () => {
      // On a NestFactory app a missed `app.get` is logged at ERROR by Nest's exception proxy
      // before transport falls back to parsing the env, so AppModule loads the namespace itself.
      expect(app.get<GrpcConfig, GrpcConfig>(grpcConfig.KEY, { strict: false }).url).toMatch(
        /^127\.0\.0\.1:\d+$/,
      );
    });

    it('UsersService.GetUser runs the real query handler + repository; Timestamp → Date', async () => {
      const user = await call(usersClient.getUser({ id: KNOWN_USER_ID }), 'UsersService.GetUser');

      expect(user).toEqual({
        id: KNOWN_USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        roles: ['user'],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(postgres.executed.at(-1)).toMatchObject({ params: [KNOWN_USER_ID, 1] });
    });

    it('UsersService.GetUser for an unknown id → status NOT_FOUND + x-error-code trailer', async () => {
      const id = generateId();
      const raw = await lastValueFrom(usersClient.getUser({ id })).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.NOT_FOUND });
      expect((raw as ServiceError).metadata.get('x-error-code')).toEqual(['NOT_FOUND']);

      // …and the gateway side turns it back into the same DomainException.
      const error = await call(usersClient.getUser({ id }), 'UsersService.GetUser').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EntityNotFoundException);
      expect(error).toMatchObject({ httpStatus: 404, details: { entity: 'User', id } });
    });

    it('UsersService.GetUser with a malformed id → INVALID_ARGUMENT before any SQL', async () => {
      const before = postgres.executed.length;
      const raw = await lastValueFrom(usersClient.getUser({ id: 'nope' })).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.INVALID_ARGUMENT });

      const error = await call(usersClient.getUser({ id: 'nope' }), 'UsersService.GetUser').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as DomainValidationException).issues).toEqual([
        expect.objectContaining({ path: 'id' }),
      ]);
      expect(postgres.executed).toHaveLength(before);
    });

    it('AuthService.Login with an unknown e-mail → UNAUTHENTICATED / INVALID_CREDENTIALS', async () => {
      const request = { email: 'nobody@example.com', password: 'correct horse battery' };
      const raw = await lastValueFrom(authClient.login(request)).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.UNAUTHENTICATED });

      const error = await call(authClient.login(request), 'AuthService.Login').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UnauthenticatedException);
      expect(error).toMatchObject({ httpStatus: 401, code: 'INVALID_CREDENTIALS' });
    });

    it('caller errors never open the circuit breaker', () => {
      expect(breakers.states()['identity']).toBe('closed');
    });
  });
});
