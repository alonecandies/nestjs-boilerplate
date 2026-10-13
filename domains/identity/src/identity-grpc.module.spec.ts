import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { AuthModule, Role, TokenService } from '@platform/auth';
import { AppConfigModule } from '@platform/config';
import { DRIZZLE, TransactionHost } from '@platform/database';
import { FakeKafkaProducer, KafkaProducer } from '@platform/transport';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeRedisModule } from '../test/auth-test.module.js';
import { createFakePostgres } from '../test/fake-postgres.js';
import { NOW } from '../test/fixtures.js';
import { IdentityGrpcModule } from './identity-grpc.module.js';
import { passwordConfig } from './infrastructure/security/password.config.js';
import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
import { TokenIssuer } from './infrastructure/security/token-issuer.service.js';
import { UsersGrpcController } from './presentation/grpc/users-grpc.controller.js';

const USER_ID = '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d';
const database = createFakePostgres((sql) =>
  sql.includes('from "users" where "users"."id"')
    ? [
        {
          id: USER_ID,
          email: 'ada@example.com',
          display_name: 'Ada',
          roles: '{user}',
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ]
    : [],
);

@Global()
@Module({
  providers: [
    { provide: DRIZZLE, useValue: database.db },
    {
      provide: TransactionHost,
      useValue: { tx: database.db, withTransaction: (work: () => Promise<unknown>) => work() },
    },
    { provide: KafkaProducer, useValue: new FakeKafkaProducer() },
  ],
  exports: [DRIZZLE, TransactionHost, KafkaProducer],
})
class FakeInfrastructureModule {}

/** identity-service composition: IdentityGrpcModule (+ core) with the real CQRS bus. */
describe('IdentityGrpcModule (identity-service wiring)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync({ globalGuards: false }),
        CqrsModule.forRoot(),
        FakeInfrastructureModule,
        IdentityGrpcModule,
      ],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('a gRPC handler runs the real query handler and repository', async () => {
    const user = await moduleRef.get(UsersGrpcController).getUser({ id: USER_ID });
    expect(user).toEqual({
      id: USER_ID,
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: ['user'],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(database.executed.at(-1)?.sql).toContain('where "users"."id" = $1');
  });

  it('hashes with the identity-owned PasswordHasher, configured by the password namespace', async () => {
    const { argon2 } = passwordConfig.parse();
    const hasher = moduleRef.get(PasswordHasher);
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toContain(`$m=${argon2.memoryCost},t=${argon2.timeCost},p=${argon2.parallelism}$`);
    await expect(hasher.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('issues tokens with the identity-owned TokenIssuer; the platform verifier accepts them', async () => {
    const issuer = moduleRef.get(TokenIssuer);
    const access = await issuer.issueAccessToken({
      id: USER_ID,
      email: 'ada@example.com',
      roles: [Role.User],
    });
    await expect(
      moduleRef.get(TokenService).verifyAccessToken(access.token),
    ).resolves.toMatchObject({ sub: USER_ID, typ: 'access' });
    const refresh = await issuer.issueRefreshToken({ userId: USER_ID, sessionId: 'session-1' });
    await expect(issuer.verifyRefreshToken(refresh.token)).resolves.toMatchObject({
      sub: USER_ID,
      jti: 'session-1',
    });
  });
});
