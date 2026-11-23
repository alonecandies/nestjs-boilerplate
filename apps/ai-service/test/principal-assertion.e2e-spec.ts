/*
 * ai-service under GRPC_PRINCIPAL_ASSERTION=enforce (grpc-principal-unsigned): a chat tool call is
 * a second gRPC hop, so ai-service must forward the caller's signed assertion unchanged (it holds
 * no signing key) and the owning service must accept it. The REAL AppModule with fakes at the
 * network edges, as in app.e2e-spec.ts; identity-service is a stand-in gRPC server behind
 * `@GrpcController()` (the same verifier, also in `enforce`) at IDENTITY_GRPC_URL, so the tool's
 * call really crosses the wire. Both are configured from the environment, public key only.
 *
 * The environment is set before any import: `AppModule` reads the tool upstreams' targets while its
 * decorators evaluate.
 */
const { signer, identityUrl } = await vi.hoisted(async () => {
  const { createServer } = await import('node:net');
  const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address === null || typeof address === 'string') throw new Error('No free port');
    return address.port;
  };
  const { createTestPrincipalSigner } = await import('@platform/transport/testing');
  const edge = createTestPrincipalSigner('edge-e2e');
  const identity = `127.0.0.1:${await freePort()}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'ai-service',
    OTEL_SDK_DISABLED: 'true',
    GRPC_URL: `127.0.0.1:${await freePort()}`,
    GRPC_DEADLINE_MS: '3000',
    DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
    DATABASE_RUN_MIGRATIONS: 'false',
    IDENTITY_GRPC_URL: identity,
    NOTIFICATIONS_GRPC_URL: '127.0.0.1:1',
    BILLING_GRPC_URL: '127.0.0.1:1',
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
    // Every gRPC server in this process verifies with the edge's public key; none can sign.
    GRPC_PRINCIPAL_ASSERTION: 'enforce',
    GRPC_PRINCIPAL_PUBLIC_KEYS: edge.publicKeysEnv,
  });
  return { signer: edge, identityUrl: identity };
});

import { aiSchema, ConversationsRepository, MessagesRepository, UsageRepository } from '@domain/ai';
import { createInMemoryAiPersistence } from '@domain/ai/testing';
import { AI_GRPC_PACKAGE, type AiServiceClient, type Conversation } from '@domain/ai-contracts';
import {
  type GetUserRequest,
  type GetUsersByIdsRequest,
  IDENTITY_GRPC_PACKAGE,
  type ListUsersRequest,
  type UpdateUserRolesRequest,
  type User,
  type UserList,
  type UserPage,
  type UsersServiceController,
  UsersServiceControllerMethods,
} from '@domain/identity-contracts';
import { NotificationsPort } from '@domain/notifications/api';
import { type Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientGrpcProxy, Ctx, Payload } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AiModelProvider } from '@platform/ai';
import { MockAiModelProvider, type MockModelCall, mockScriptedModel } from '@platform/ai/testing';
import { getPrincipal, PermissionDeniedException } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { DRIZZLE } from '@platform/database';
import {
  createGrpcClientOptions,
  createGrpcServerStrategy,
  createOutgoingMetadata,
  GRPC_METADATA_KEYS,
  GrpcController,
} from '@platform/transport';
import { ClsModule } from 'nestjs-cls';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

const TENANT_ID = '01920000-0000-7000-8000-0000000000a1';
const ADA = '01920000-0000-7000-8000-0000000000b1';
const ada = { userId: ADA, tenantId: TENANT_ID, roles: ['member'] };

/** What the identity stand-in saw: the principal its handler ran as and the assertion bytes. */
const identityCalls: { principal: unknown; assertion: unknown }[] = [];

@GrpcController()
@UsersServiceControllerMethods()
class IdentityStandInController implements UsersServiceController {
  getUser(@Payload() request: GetUserRequest, @Ctx() metadata?: Metadata): User {
    identityCalls.push({
      principal: getPrincipal(),
      assertion: metadata?.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION)[0],
    });
    const at = new Date('2026-09-01T10:00:00.000Z');
    return {
      id: request.id,
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  getUsersByIds(_request: GetUsersByIdsRequest): UserList {
    throw new PermissionDeniedException('not served by the stand-in');
  }

  listUsers(_request: ListUsersRequest): UserPage {
    throw new PermissionDeniedException('not served by the stand-in');
  }

  updateUserRoles(_request: UpdateUserRolesRequest): User {
    throw new PermissionDeniedException('not served by the stand-in');
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [IdentityStandInController],
})
class IdentityStandInModule {}

const postgres = createFakePostgres(aiSchema, (sql) =>
  sql === 'select 1' ? [{ '?column?': 1 }] : [],
);

/** The tool results the model was sent on this step, as JSON (the reply echoes them). */
const toolResultsOf = (call: MockModelCall): string =>
  JSON.stringify(
    call.prompt.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool-result' ? [{ tool: part.toolName, output: part.output }] : [],
          )
        : [],
    ),
  );

describe('ai-service with GRPC_PRINCIPAL_ASSERTION=enforce', () => {
  let app: NestFastifyApplication;
  let identity: INestMicroservice;
  let client: ClientGrpcProxy;
  let ai: AiServiceClient;
  let model = mockScriptedModel([{ text: 'unused' }]);
  const persistence = createInMemoryAiPersistence();

  const create = (metadata: Metadata): Promise<Conversation> =>
    lastValueFrom(ai.createConversation({ tenantId: TENANT_ID, userId: ADA }, metadata));

  beforeAll(async () => {
    identity = await NestFactory.createMicroservice(IdentityStandInModule, {
      ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: identityUrl }), [
        IDENTITY_GRPC_PACKAGE,
      ]),
      logger: false,
    });
    await identity.listen();

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
      .overrideProvider(ConversationsRepository)
      .useValue(persistence.conversations)
      .overrideProvider(MessagesRepository)
      .useValue(persistence.messages)
      .overrideProvider(UsageRepository)
      .useValue(persistence.usage)
      .overrideProvider(AiModelProvider)
      .useValue(new MockAiModelProvider(() => model));
    app = await startServiceTestApp(builder, { grpc: [AI_GRPC_PACKAGE] });

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), {
        spec: AI_GRPC_PACKAGE,
        url: process.env['GRPC_URL'] ?? '',
      }).options,
    );
    ai = client.getService<AiServiceClient>('AiService');
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    await identity?.close();
  });

  it('refuses plain caller headers without an assertion (UNAUTHENTICATED INVALID_PRINCIPAL)', async () => {
    const error = await create(createOutgoingMetadata(ada)).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (caught: unknown) => caught as ServiceError,
    );
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(error.metadata.get(GRPC_METADATA_KEYS.ERROR_CODE)).toEqual(['INVALID_PRINCIPAL']);
  });

  it("a tool call made late in a turn forwards the caller's assertion; the owner accepts it", async () => {
    // The gateway signed this turn's assertion 100 s ago (TTL 120 s): the tool call, on the turn's
    // second model step, still carries those bytes and must still verify at the owning service.
    const late = Date.now() - 100_000;
    const metadata = signer.metadata(ada, { nowMs: late });
    const [assertion] = metadata.get(GRPC_METADATA_KEYS.PRINCIPAL_ASSERTION);
    const notifications = vi.spyOn(app.get(NotificationsPort), 'list').mockResolvedValue({
      items: [],
    });
    model = mockScriptedModel([
      { toolCalls: [{ toolName: 'list_my_notifications', input: {} }] },
      { toolCalls: [{ toolName: 'get_my_profile', input: {} }] },
      (call) => ({ text: toolResultsOf(call) }),
    ]);
    const conversation = await create(metadata);

    const sent = await lastValueFrom(
      ai.sendMessage(
        {
          tenantId: TENANT_ID,
          userId: ADA,
          conversationId: conversation.id,
          content: 'Who am I?',
        },
        metadata,
      ),
    );

    expect(notifications).toHaveBeenCalledTimes(1);
    expect(identityCalls).toEqual([
      {
        principal: { userId: ADA, tenantId: TENANT_ID, roles: ['member'], staff: false },
        assertion,
      },
    ]);
    const results = JSON.parse(JSON.parse(sent.message?.contentJson ?? '""') as string) as {
      tool: string;
      output: { type: string; value: unknown };
    }[];
    expect(results.at(-1)).toMatchObject({
      tool: 'get_my_profile',
      output: { type: 'json', value: { id: ADA, email: 'ada@example.com' } },
    });
  });
});
