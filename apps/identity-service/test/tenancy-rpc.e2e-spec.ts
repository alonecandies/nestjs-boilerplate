import { identitySchema } from '@domain/identity';
import {
  IDENTITY_GRPC_PACKAGE,
  TENANTS_SERVICE_NAME,
  type TenantsServiceClient,
} from '@domain/identity-contracts';
import { Metadata, status } from '@grpc/grpc-js';
import { getQueueToken } from '@nestjs/bullmq';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { generateId } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { DRIZZLE, SYSTEM_DATABASE, SystemDatabase } from '@platform/database';
import { MAIL_QUEUE } from '@platform/mailer';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  KafkaProducer,
  readErrorTrailers,
} from '@platform/transport';
import { FakeKafkaProducer, withBoundGrpcPort } from '@platform/transport/testing';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * identity.v1.TenantsService served by the REAL identity-service AppModule (B2-17): the fake
 * Postgres answers every query with no rows, so these specs cover what happens before and around
 * the tenancy handlers: principal propagation through metadata, the self/tenant cross-checks and
 * payload validation.
 */

const postgres = createFakePostgres(identitySchema, (sql) =>
  sql === 'select 1' ? [{ '?column?': 1 }] : [],
);

describe('identity-service TenantsService (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let tenantsClient: TenantsServiceClient;

  const call = <T>(observable: Observable<T>) => lastValueFrom(observable);
  const callerOf = (userId: string, tenantId: string) =>
    createOutgoingMetadata({ userId, tenantId, roles: ['owner'] });

  beforeAll(async () => {
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'identity-service',
      // Port 0: the server binds an OS-chosen port, read back after it started.
      GRPC_URL: '127.0.0.1:0',
      GRPC_DEADLINE_MS: '3000',
      DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

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
      .overrideProvider(getQueueToken(MAIL_QUEUE))
      .useValue({ add: vi.fn(), close: vi.fn(), on: vi.fn() });
    const started = await withBoundGrpcPort(() =>
      startServiceTestApp(builder, { grpc: [IDENTITY_GRPC_PACKAGE] }),
    );
    app = started.value;
    const grpcUrl = `127.0.0.1:${started.port}`;

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), { spec: IDENTITY_GRPC_PACKAGE, url: grpcUrl })
        .options,
    );
    tenantsClient = client.getService<TenantsServiceClient>(TENANTS_SERVICE_NAME);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it('serves ListMyTenants for the calling user', async () => {
    const userId = generateId();
    await expect(
      call(tenantsClient.listMyTenants({ userId }, callerOf(userId, generateId()))),
    ).resolves.toMatchObject({ items: [] });
  });

  it("PERMISSION_DENIED for another user's tenants: the request user must be the caller", async () => {
    await expect(
      call(
        tenantsClient.listMyTenants({ userId: generateId() }, callerOf(generateId(), generateId())),
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
  });

  it('UNAUTHENTICATED without a caller principal (RenameTenant)', async () => {
    await expect(
      call(
        tenantsClient.renameTenant(
          { tenantId: generateId(), actorId: generateId(), name: 'X' },
          new Metadata(),
        ),
      ),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it('PERMISSION_DENIED TENANT_ACCESS_DENIED when the request tenant is not the caller tenant', async () => {
    const actorId = generateId();
    const error = await call(
      tenantsClient.renameTenant(
        { tenantId: generateId(), actorId, name: 'X' },
        callerOf(actorId, generateId()),
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: status.PERMISSION_DENIED });
    expect(readErrorTrailers((error as { metadata?: unknown }).metadata).code).toBe(
      'TENANT_ACCESS_DENIED',
    );
  });

  it('INVALID_ARGUMENT for a malformed invitation', async () => {
    const actorId = generateId();
    const tenantId = generateId();
    await expect(
      call(
        tenantsClient.createInvitation(
          { tenantId, actorId, email: 'not-an-email', roles: ['member'] },
          callerOf(actorId, tenantId),
        ),
      ),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });
});
