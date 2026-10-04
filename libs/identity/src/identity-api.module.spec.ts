import { PasswordHasher, Role } from '@app/auth';
import { provideCommonEnhancers } from '@app/common';
import { KAFKA_TOPICS } from '@app/contracts';
import { DRIZZLE, TransactionHost } from '@app/database';
import { AppCacheService } from '@app/redis';
import { createFastifyTestApp } from '@app/testing';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH_TEST_IMPORTS, bearer, principal } from '../test/auth-test.module.js';
import { createFakePostgres, type FakeResult } from '../test/fake-postgres.js';
import { InMemoryAppCache } from '../test/in-memory-app-cache.js';
import { AuthPort } from './application/ports/auth.port.js';
import { UsersPort } from './application/ports/users.port.js';
import { IdentityApiModule } from './identity-api.module.js';
import { AuthLocalAdapter } from './infrastructure/adapters/local/auth-local.adapter.js';
import { UsersLocalAdapter } from './infrastructure/adapters/local/users-local.adapter.js';

/*
 * Monolith composition without infrastructure: IdentityApiModule.forLocal() (→ IdentityCoreModule)
 * with the REAL CQRS bus, handlers, repositories, Drizzle query building and relay; only the
 * postgres.js client, Redis and Kafka are fakes. Proves the DI graph of the whole context and the
 * register → session → UserRegisteredEvent → Kafka path end to end.
 */

type App = Awaited<ReturnType<typeof createFastifyTestApp>>;

const users = new Map<string, Record<string, unknown>>();
const database = createFakePostgres((sql, params): FakeResult => {
  if (sql.startsWith('select "id" from "users" where "users"."email"')) {
    return [...users.values()]
      .filter((row) => row['email'] === params[0])
      .map((row) => ({ id: row['id'] }));
  }
  if (sql.startsWith('select "id", "email", "password_hash"')) {
    return [...users.values()].filter((row) => row['email'] === params[0]);
  }
  if (sql.startsWith('select "id", "email", "display_name"')) {
    const row = users.get(String(params[0]));
    if (!row) return [];
    const { password_hash: _hash, ...rest } = row;
    return [rest];
  }
  if (sql.startsWith('insert into "users"')) {
    const [id, email, passwordHash, displayName, roles, createdAt, updatedAt] = params;
    users.set(String(id), {
      id,
      email,
      password_hash: passwordHash,
      display_name: displayName,
      roles,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
  return [];
});
const kafka = new FakeKafkaProducer({ source: 'monolith' });

/** What DatabaseModule / KafkaProducerModule / AppCacheModule provide globally in the app. */
@Global()
@Module({
  providers: [
    { provide: DRIZZLE, useValue: database.db },
    {
      provide: TransactionHost,
      useValue: { tx: database.db, withTransaction: (work: () => Promise<unknown>) => work() },
    },
    { provide: KafkaProducer, useValue: kafka },
    { provide: AppCacheService, useValue: new InMemoryAppCache() },
  ],
  exports: [DRIZZLE, TransactionHost, KafkaProducer, AppCacheService],
})
class FakeInfrastructureModule {}

describe('IdentityApiModule.forLocal() (monolith wiring, fake Postgres/Redis/Kafka)', () => {
  let app: App;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [
        ...AUTH_TEST_IMPORTS,
        CqrsModule.forRoot(),
        FakeInfrastructureModule,
        IdentityApiModule.forLocal(),
      ],
      providers: provideCommonEnhancers(),
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('binds the ports to the in-process adapters', () => {
    expect(app.get(AuthPort)).toBeInstanceOf(AuthLocalAdapter);
    expect(app.get(UsersPort)).toBeInstanceOf(UsersLocalAdapter);
  });

  it('register → user + session rows → tokens, then identity.user-registered.v1 on Kafka', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'Grace@Example.com', password: 'correct horse', displayName: 'Grace' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ accessToken: string; user: { id: string; roles: string[] } }>();
    expect(body.user.roles).toEqual([Role.User]);
    const statements = database.executed.map((query) => query.sql.split(' (')[0]);
    expect(statements).toEqual([
      'select "id" from "users" where "users"."email" = $1 limit $2',
      'insert into "users"',
      'insert into "sessions"',
    ]);
    // The refresh token itself is never stored: the session row carries its sha256.
    const sessionInsert = database.executed[2];
    expect(sessionInsert?.params).not.toContain(res.json<{ refreshToken: string }>().refreshToken);

    await vi.waitFor(() => expect(kafka.published(KAFKA_TOPICS.USER_REGISTERED)).toHaveLength(1));
    expect(kafka.envelopes(KAFKA_TOPICS.USER_REGISTERED)[0]?.payload).toMatchObject({
      userId: body.user.id,
      email: 'grace@example.com',
      displayName: 'Grace',
    });

    // The issued access token is accepted by the global guards.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: body.user.id, email: 'grace@example.com' });
  });

  it('login verifies the argon2 hash through the real handler', async () => {
    const hash = await app.get(PasswordHasher).hash('open sesame');
    const id = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d';
    users.set(id, {
      id,
      email: 'alan@example.com',
      password_hash: hash,
      display_name: 'Alan',
      roles: '{admin}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ALAN@example.com', password: 'open sesame' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user: { id, roles: ['admin'] } });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'alan@example.com', password: 'wrong' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('a duplicate registration is a 409 without hashing (pre-check)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'grace@example.com', password: 'correct horse', displayName: 'Grace' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('GET /v1/users/:id reads through QueryBus → repository for users:read holders', async () => {
    const moderator = await principal(app, [Role.Moderator]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d',
      headers: bearer(moderator),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'alan@example.com', roles: ['admin'] });
  });
});
