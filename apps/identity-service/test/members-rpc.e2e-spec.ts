import { identitySchema } from '@domain/identity';
import {
  IDENTITY_GRPC_PACKAGE,
  type Member,
  TENANTS_SERVICE_NAME,
  type TenantsServiceClient,
} from '@domain/identity-contracts';
import { getQueueToken } from '@nestjs/bullmq';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { generateId, type TenantRole } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { DRIZZLE, SYSTEM_DATABASE, SystemDatabase } from '@platform/database';
import { MAIL_QUEUE } from '@platform/mailer';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  KafkaProducer,
} from '@platform/transport';
import { FakeKafkaProducer, withBoundGrpcPort } from '@platform/transport/testing';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * ARCH-4 over gRPC, served by the REAL identity-service AppModule: `ListMembers` returns
 * co-members' emails and roles only to a caller whose MEMBERSHIP ROW grants users:read (admin,
 * owner). Withheld fields are the proto3 defaults `""` and `[]`, so an old gateway's non-null
 * GraphQL `Member.email: String!` and `roles: [TenantRole!]!` still accept them. The fake Postgres
 * answers the actor's membership lookup and the member-directory join from the rows below.
 */

const tenantId = generateId();
const JOINED_AT = new Date('2026-11-01T10:00:00.000Z');
const people: { userId: string; email: string; displayName: string; roles: TenantRole[] }[] = [
  { userId: generateId(), email: 'ada@example.com', displayName: 'Ada', roles: ['owner'] },
  { userId: generateId(), email: 'bob@example.com', displayName: 'Bob', roles: ['admin'] },
  { userId: generateId(), email: 'eve@example.com', displayName: 'Eve', roles: ['member'] },
];
const [ada, bob, eve] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]];

const postgres = createFakePostgres(identitySchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  // The member directory (system read): memberships ⋈ users, newest user id first.
  if (sql.includes('from "identity"."memberships" inner join "identity"."users"')) {
    return [...people]
      .sort((a, b) => b.userId.localeCompare(a.userId))
      .map(
        (p): FakeRow => ({
          userId: p.userId,
          email: p.email,
          displayName: p.displayName,
          roles: p.roles,
          joinedAt: JOINED_AT.toISOString(),
        }),
      );
  }
  // The actor's membership row (`actorTenantRoles`): the roles it holds, whatever the token says.
  if (sql.startsWith('select') && sql.includes('from "identity"."memberships" where')) {
    const person = people.find((p) => params.includes(p.userId) && params.includes(tenantId));
    if (person === undefined) return [];
    return [
      {
        tenantId,
        userId: person.userId,
        roles: person.roles,
        lastActiveAt: null,
        createdAt: JOINED_AT.toISOString(),
      },
    ];
  }
  return [];
});

describe('identity-service ListMembers (ARCH-4, real AppModule over gRPC)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let tenants: TenantsServiceClient;

  /** `ListMembers` as `userId`, whose access token (forwarded as metadata) claims `tokenRoles`. */
  const listAs = async (userId: string, tokenRoles: TenantRole[]): Promise<Map<string, Member>> => {
    const page = await lastValueFrom(
      tenants.listMembers(
        { tenantId, limit: 10 },
        createOutgoingMetadata({ userId, tenantId, roles: tokenRoles }),
      ),
    );
    return new Map((page.items ?? []).map((m) => [m.userId, m]));
  };

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

    // The gateway's client options (proto3 defaults decoded: "" and [] arrive, not undefined).
    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), { spec: IDENTITY_GRPC_PACKAGE, url: grpcUrl })
        .options,
    );
    tenants = client.getService<TenantsServiceClient>(TENANTS_SERVICE_NAME);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it('a member gets co-members as "" and [] (names kept) and their own row complete', async () => {
    const members = await listAs(eve.userId, ['member']);
    expect(members.size).toBe(3);
    for (const other of [ada, bob]) {
      expect(members.get(other.userId)).toMatchObject({
        userId: other.userId,
        email: '',
        displayName: other.displayName,
        roles: [],
      });
      expect(members.get(other.userId)?.joinedAt).toEqual(JOINED_AT);
    }
    expect(members.get(eve.userId)).toMatchObject({
      email: 'eve@example.com',
      displayName: 'Eve',
      roles: ['member'],
    });
  });

  it('the membership row decides: forwarded owner roles over a member row still withhold', async () => {
    const members = await listAs(eve.userId, ['owner']);
    expect(members.get(ada.userId)).toMatchObject({ email: '', roles: [] });
  });

  it.each([
    ['admin', bob],
    ['owner', ada],
  ] as const)('an %s (users:read) gets every email and role', async (_role, caller) => {
    // The token under-claims; the membership row still grants users:read.
    const members = await listAs(caller.userId, ['member']);
    for (const person of people) {
      expect(members.get(person.userId)).toMatchObject({
        email: person.email,
        displayName: person.displayName,
        roles: person.roles,
      });
    }
  });
});
