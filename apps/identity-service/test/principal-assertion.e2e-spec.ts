import { identitySchema, tenants } from '@domain/identity';
import {
  AUTH_SERVICE_NAME,
  type AuthServiceClient,
  IDENTITY_GRPC_PACKAGE,
  TENANTS_SERVICE_NAME,
  type TenantsServiceClient,
} from '@domain/identity-contracts';
import { type Metadata, type ServiceError, status } from '@grpc/grpc-js';
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
  GRPC_METADATA_KEYS,
  KafkaProducer,
} from '@platform/transport';
import {
  createTestPrincipalSigner,
  FakeKafkaProducer,
  withBoundGrpcPort,
} from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * identity-service under GRPC_PRINCIPAL_ASSERTION=enforce (grpc-principal-unsigned): the REAL
 * AppModule, configured from the environment like a deployed service (public key only, no signing
 * key), with fakes at the network edges. A mesh peer without the edge's private key cannot assert a
 * user, a tenant, roles or the staff flag; anonymous calls (register, login) still pass. The other
 * e2e specs keep the default `off`.
 */

const TENANT_ID = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c6e';
const ACTOR_ID = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c6f';

/** The `tenants` row as postgres.js returns it, in SELECT column order. */
function tenantRow(): FakeRow {
  const values: Record<string, unknown> = {
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme',
    personal: false,
    createdAt: '2026-09-01T10:00:00.000Z',
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(tenants)).map((column) => [column, values[column]]),
  );
}

// The tenant exists; nobody is a member of it (every memberships lookup answers no row).
const postgres = createFakePostgres(identitySchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  if (sql.startsWith('select') && sql.includes('from "identity"."tenants"')) {
    return params.includes(TENANT_ID) ? [tenantRow()] : [];
  }
  if (sql.startsWith('update "identity"."tenants"')) return [{ id: TENANT_ID }];
  return [];
});

describe('identity-service with GRPC_PRINCIPAL_ASSERTION=enforce', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let tenantsClient: TenantsServiceClient;
  let authClient: AuthServiceClient;
  const signer = createTestPrincipalSigner('edge-e2e');
  /** A staff owner of a tenant it has no membership in: what a hostile mesh peer would assert. */
  const staffOwner = { userId: ACTOR_ID, tenantId: TENANT_ID, roles: ['owner'], staff: true };
  const rename = (metadata: Metadata): Observable<unknown> =>
    tenantsClient.renameTenant(
      { tenantId: TENANT_ID, actorId: ACTOR_ID, name: 'Renamed' },
      metadata,
    );
  const failureOf = (source: Observable<unknown>): Promise<ServiceError> =>
    lastValueFrom(source).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => error as ServiceError,
    );
  const errorCode = (error: ServiceError): unknown =>
    error.metadata.get(GRPC_METADATA_KEYS.ERROR_CODE)[0];

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
      OUTBOX_RELAY_ENABLED: 'false',
      // A deployed service: it verifies with the edge's public key and holds no signing key.
      GRPC_PRINCIPAL_ASSERTION: 'enforce',
      GRPC_PRINCIPAL_PUBLIC_KEYS: signer.publicKeysEnv,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
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
    authClient = client.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it('refuses plain headers asserting x-staff and owner for a tenant without a membership', async () => {
    const before = postgres.executed.length;
    const error = await failureOf(rename(createOutgoingMetadata(staffOwner)));
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
    expect(postgres.executed).toHaveLength(before); // refused before any handler ran
  });

  it('accepts the same call with a signed assertion: the staff owner renames the tenant', async () => {
    await expect(lastValueFrom(rename(signer.metadata(staffOwner)))).resolves.toMatchObject({
      id: TENANT_ID,
      name: 'Renamed',
    });
    expect(postgres.executed.some((q) => q.sql.startsWith('update "identity"."tenants"'))).toBe(
      true,
    );
  });

  it('refuses an expired assertion', async () => {
    const late = Date.now() - (signer.signingKey.ttlSec + 60) * 1000;
    const error = await failureOf(rename(signer.metadata(staffOwner, { nowMs: late })));
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
  });

  it('refuses an assertion signed by another key', async () => {
    const other = createTestPrincipalSigner('edge-e2e');
    const error = await failureOf(rename(other.metadata(staffOwner)));
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
  });

  it('register without any header passes (anonymous)', async () => {
    const tokens = await lastValueFrom(
      authClient.register({
        email: `enforce-${generateId()}@example.com`,
        password: 'correct horse battery staple',
        displayName: 'Ada',
      }),
    );
    expect(tokens.accessToken).toEqual(expect.any(String));
  });

  it('login without any header reaches its handler (anonymous): INVALID_CREDENTIALS, not INVALID_PRINCIPAL', async () => {
    const error = await failureOf(
      authClient.login({ email: 'nobody@example.com', password: 'correct horse battery' }),
    );
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_CREDENTIALS');
  });
});
