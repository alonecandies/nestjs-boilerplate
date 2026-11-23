import { identitySchema, users } from '@domain/identity';
import {
  type AuthServiceClient,
  IDENTITY_GRPC_PACKAGE,
  type UsersServiceClient,
} from '@domain/identity-contracts';
import { type ServiceError, status } from '@grpc/grpc-js';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  DomainValidationException,
  EntityNotFoundException,
  generateId,
  UnauthenticatedException,
} from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { DRIZZLE, SYSTEM_DATABASE, SystemDatabase } from '@platform/database';
import { MAIL_QUEUE } from '@platform/mailer';
import { MetricsListener } from '@platform/observability';
import { OutboxRelay, outboxRelayLockResource, outboxRelayToken } from '@platform/outbox';
import { DistributedLockService, REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  GrpcCircuitBreakers,
  grpcCall,
  KafkaProducer,
} from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { withBoundGrpcPort } from './support/free-port.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * identity-service end to end, no Docker: the REAL AppModule (CQRS, handlers, repositories,
 * AuthModule, observability, common enhancers) with fakes only at the network edges — a drizzle
 * instance over a fake postgres.js client, an in-memory Redis and a recording Kafka producer.
 * gRPC is real: the app's server listens on a loopback port and a gateway-style ClientGrpcProxy
 * (same client options as `GrpcClientsModule`) calls it.
 */

const KNOWN_USER_ID = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d';
/** gRPC metadata of the known user calling for itself (no tenant). */
const self = createOutgoingMetadata({ userId: KNOWN_USER_ID });
const CREATED_AT = new Date('2026-09-01T10:00:00.123Z');
const UPDATED_AT = new Date('2026-09-02T11:30:00.456Z');

/** The `users` row as postgres.js returns it (password hash never selected by the repository). */
function knownUserRow(): FakeRow {
  const values: Record<string, unknown> = {
    id: KNOWN_USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    isPlatformStaff: false,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
  };
  const { passwordHash: _passwordHash, ...selected } = getTableColumns(users);
  return Object.fromEntries(Object.keys(selected).map((column) => [column, values[column]]));
}

const postgres = createFakePostgres(identitySchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  if (
    sql.includes('from "identity"."users" where "identity"."users"."id"') &&
    params[0] === KNOWN_USER_ID
  ) {
    return [knownUserRow()];
  }
  return []; // unknown ids and e-mails
});

describe('identity-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let usersClient: UsersServiceClient;
  let authClient: AuthServiceClient;
  /** What the outbox relay did while the app booted (its start decision runs on bootstrap). */
  const relayBoot = { lockResources: [] as unknown[], logLines: [] as unknown[][] };
  const breakers = new GrpcCircuitBreakers();

  /** What the gateway adapters do: deadline + breaker + ServiceError → DomainException. */
  const call = <T>(source: Observable<T>, operation: string): Promise<T> =>
    grpcCall(source, { timeoutMs: 3_000, operation, breaker: breakers.get('identity') });

  beforeAll(async () => {
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'identity-service',
      // Port 0: the server binds an OS-chosen port, read back after it started.
      GRPC_URL: '127.0.0.1:0',
      GRPC_DEADLINE_MS: '3000',
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
      // The relay resolves but stays off: no broker, and the case below pins that it never leads.
      OUTBOX_RELAY_ENABLED: 'false',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    // Installed before the app boots: the relay decides whether to start on bootstrap.
    const lockAttempts = vi.spyOn(DistributedLockService.prototype, 'using');
    const logLines = vi.spyOn(Logger.prototype, 'log');

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
      // The app_system pool's door, over the same fake (pre-auth and directory reads).
      .overrideProvider(SYSTEM_DATABASE)
      .useValue(new SystemDatabase(postgres.db))
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(new FakeKafkaProducer({ source: 'identity-service' }))
      // The invitation mail queue (B2-14): a recording stub, so no BullMQ connection opens.
      .overrideProvider(getQueueToken(MAIL_QUEUE))
      .useValue({ add: vi.fn(), close: vi.fn(), on: vi.fn() });
    const started = await withBoundGrpcPort(() =>
      startServiceTestApp(builder, { grpc: [IDENTITY_GRPC_PACKAGE] }),
    );
    app = started.value;
    const grpcUrl = `127.0.0.1:${started.port}`;
    // Kept here: the config restores every spy before each test (restoreMocks).
    relayBoot.lockResources = lockAttempts.mock.calls.map(([resource]) => resource);
    relayBoot.logLines = logLines.mock.calls.filter(
      (_, call) =>
        (logLines.mock.contexts[call] as { context?: string } | undefined)?.context ===
        'OutboxRelay:identity',
    );
    lockAttempts.mockRestore();
    logLines.mockRestore();

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), { spec: IDENTITY_GRPC_PACKAGE, url: grpcUrl })
        .options,
    );
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

    it('GET /metrics is not served on the HTTP port (METRICS_PORT has its own listener)', async () => {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Node default metrics and the HTTP latency histogram', async () => {
      await app.inject({ method: 'GET', url: '/health/live' });
      const scrape = await app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /health/ready → 200 on postgres + redis alone: an unreachable Kafka never un-readies the service', async () => {
      // KAFKA_BROKERS points at a closed port: event publishing is best-effort, so login/register
      // must stay in rotation during a broker outage.
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      const body = response.json<{ status: string; info: object; error: object }>();
      expect(response.statusCode).toBe(200);
      expect(body.status).toBe('ok');
      expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual(['postgres', 'redis']);
      expect(body.info).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' } });
      expect(body.error).toEqual({});
    });

    it('an unknown route is a problem+json 404 (common enhancers)', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/users' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('outbox relay (identity.outbox)', () => {
    it('resolves, and with OUTBOX_RELAY_ENABLED=false never asks for its lock', () => {
      expect(app.get(outboxRelayToken('identity'), { strict: false })).toBeInstanceOf(OutboxRelay);
      // It stopped at the switch, not at a missing system pool or a lost lock race.
      expect(relayBoot.logLines).toEqual([['relay disabled (OUTBOX_RELAY_ENABLED=false)']]);
      expect(relayBoot.lockResources).not.toContain(outboxRelayLockResource('identity'));
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
      // The runtime read runs as the caller the metadata carries (B3: no principal, no BEGIN).
      const user = await call(
        usersClient.getUser({ id: KNOWN_USER_ID }, self),
        'UsersService.GetUser',
      );

      expect(user).toEqual({
        id: KNOWN_USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        roles: [],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(postgres.executed.at(-1)).toMatchObject({ params: [KNOWN_USER_ID, 1] });
    });

    it('UsersService.UpdateUserRoles is retired → FAILED_PRECONDITION / GLOBAL_ROLES_REMOVED', async () => {
      const request = { id: KNOWN_USER_ID, roles: ['admin'], actorId: KNOWN_USER_ID };
      const raw = await lastValueFrom(usersClient.updateUserRoles(request)).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.FAILED_PRECONDITION });
      const error = await call(
        usersClient.updateUserRoles(request),
        'UsersService.UpdateUserRoles',
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ httpStatus: 422, code: 'GLOBAL_ROLES_REMOVED' });
    });

    it('UsersService.GetUser for an unknown id → status NOT_FOUND + x-error-code trailer', async () => {
      const id = generateId();
      const raw = await lastValueFrom(usersClient.getUser({ id }, self)).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.NOT_FOUND });
      expect((raw as ServiceError).metadata.get('x-error-code')).toEqual(['NOT_FOUND']);

      // …and the gateway side turns it back into the same DomainException.
      const error = await call(usersClient.getUser({ id }, self), 'UsersService.GetUser').catch(
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

    it('UsersService.ListUsers without tenant_id → INVALID_ARGUMENT before any SQL', async () => {
      const before = postgres.executed.length;
      const error = await call(usersClient.listUsers({ limit: 5 }), 'UsersService.ListUsers').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DomainValidationException);
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

    it('AuthService.Login with a malformed tenant_id → INVALID_ARGUMENT before any SQL', async () => {
      const before = postgres.executed.length;
      const error = await call(
        authClient.login({
          email: 'ada@example.com',
          password: 'correct horse battery',
          tenantId: 'nope',
        }),
        'AuthService.Login',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as DomainValidationException).issues).toEqual([
        expect.objectContaining({ path: 'tenantId' }),
      ]);
      expect(postgres.executed).toHaveLength(before);
    });

    it('caller errors never open the circuit breaker', () => {
      expect(breakers.states()['identity']).toBe('closed');
    });
  });
});
