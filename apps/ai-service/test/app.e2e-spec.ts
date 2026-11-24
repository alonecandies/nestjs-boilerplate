/*
 * ai-service end to end, no Docker: the REAL AppModule (the CQRS handlers behind AiPort, the
 * transactional CLS plugin, @platform/ai's AiClient, observability, common enhancers, the chat
 * tools' gRPC sources) with fakes only at the network edges — a drizzle instance over a fake
 * postgres.js client (health, units of work), the ai repositories' in-memory twins (which enforce
 * the row-local policies), a mock language model (nothing reaches OpenRouter) and, for the tool
 * case, stand-ins for the owners' ports. gRPC is real: loopback server + gateway-style
 * ClientGrpcProxy with the caller in metadata.
 *
 * The environment is set before any import: `AppModule` reads the tool upstreams' targets and the
 * observability settings while its decorators evaluate.
 */
await vi.hoisted(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'ai-service',
    OTEL_SDK_DISABLED: 'true',
    // Port 0: the server binds an OS-chosen port, read back after it started.
    GRPC_URL: '127.0.0.1:0',
    GRPC_DEADLINE_MS: '3000',
    // Nothing may reach real infrastructure: unreachable ports everywhere.
    DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
    DATABASE_RUN_MIGRATIONS: 'false',
    IDENTITY_GRPC_URL: '127.0.0.1:1',
    NOTIFICATIONS_GRPC_URL: '127.0.0.1:1',
    BILLING_GRPC_URL: '127.0.0.1:1',
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
    AI_ALLOWED_MODELS: 'mock/other',
  });
});

import {
  AiToolSources,
  aiSchema,
  ConversationsRepository,
  MessagesRepository,
  OwnerPortsAiToolSources,
  UsageRepository,
} from '@domain/ai';
import { createInMemoryAiPersistence } from '@domain/ai/testing';
import {
  AI_GRPC_PACKAGE,
  type AiServiceClient,
  type Conversation,
  type StreamMessageEvent,
} from '@domain/ai-contracts';
import { BillingGrpcAdapter, BillingPort } from '@domain/billing/api';
import { UsersGrpcAdapter, UsersPort } from '@domain/identity/api';
import { NotificationsGrpcAdapter, NotificationsPort } from '@domain/notifications/api';
import { type ServiceError, status } from '@grpc/grpc-js';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AiModelProvider } from '@platform/ai';
import {
  MockAiModelProvider,
  type MockModelCall,
  mockHangingModel,
  mockScriptedModel,
  mockStreamModel,
  mockTextModel,
} from '@platform/ai/testing';
import { generateId, getPrincipal, type Principal } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { DRIZZLE } from '@platform/database';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  GRPC_METADATA_KEYS,
} from '@platform/transport';
import { withBoundGrpcPort } from '@platform/transport/testing';
import { lastValueFrom, type Observable, toArray } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

type MockModel = ReturnType<typeof mockTextModel>;

const TENANT_ID = '01920000-0000-7000-8000-0000000000a1';
const OTHER_TENANT_ID = '01920000-0000-7000-8000-0000000000a2';
const ADA = '01920000-0000-7000-8000-0000000000b1';
const BOB = '01920000-0000-7000-8000-0000000000b2';

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

describe('ai-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let ai: AiServiceClient;
  let model: MockModel = mockTextModel('unused');
  const persistence = createInMemoryAiPersistence();

  /** The caller metadata the gateway adapter derives from its CLS principal (B2-23). */
  const callerOf = (userId: string, tenantId = TENANT_ID) =>
    createOutgoingMetadata({ userId, tenantId, roles: ['member'] });
  const failureOf = (promise: Promise<unknown>): Promise<ServiceError> =>
    promise.then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => error as ServiceError,
    );
  const errorCode = (error: ServiceError): unknown =>
    error.metadata?.get(GRPC_METADATA_KEYS.ERROR_CODE)[0];
  const collect = <T>(source: Observable<T>): Promise<T[]> => lastValueFrom(source.pipe(toArray()));
  const create = async (userId = ADA): Promise<Conversation> =>
    lastValueFrom(ai.createConversation({ tenantId: TENANT_ID, userId }, callerOf(userId)));

  beforeAll(async () => {
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
    const started = await withBoundGrpcPort(() =>
      startServiceTestApp(builder, { grpc: [AI_GRPC_PACKAGE] }),
    );
    app = started.value;

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), {
        spec: AI_GRPC_PACKAGE,
        url: `127.0.0.1:${started.port}`,
      }).options,
    );
    ai = client.getService<AiServiceClient>('AiService');
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it('is ready on Postgres alone (no Redis, no Kafka, no OpenRouter probe)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('binds the chat tools to the owners over gRPC (identity-, notifications-, billing-service)', () => {
    expect(app.get(AiToolSources)).toBeInstanceOf(OwnerPortsAiToolSources);
    expect(app.get(UsersPort)).toBeInstanceOf(UsersGrpcAdapter);
    expect(app.get(NotificationsPort)).toBeInstanceOf(NotificationsGrpcAdapter);
    expect(app.get(BillingPort)).toBeInstanceOf(BillingGrpcAdapter);
  });

  describe('unary', () => {
    it('creates, lists and reads a conversation of the caller in metadata', async () => {
      const created = await create();
      expect(created).toMatchObject({ tenantId: TENANT_ID, userId: ADA, model: 'mock/default' });
      expect(created.createdAt).toBeInstanceOf(Date);

      const page = await lastValueFrom(
        ai.listConversations({ tenantId: TENANT_ID, userId: ADA, limit: 0 }, callerOf(ADA)),
      );
      expect(page.items.map((c) => c.id)).toContain(created.id);
      const read = await lastValueFrom(
        ai.getConversation(
          { tenantId: TENANT_ID, userId: ADA, conversationId: created.id },
          callerOf(ADA),
        ),
      );
      expect(read.id).toBe(created.id);
    });

    it('refuses a request naming another user than the principal (TENANT_MISMATCH)', async () => {
      const error = await failureOf(
        lastValueFrom(ai.createConversation({ tenantId: TENANT_ID, userId: ADA }, callerOf(BOB))),
      );
      expect(error.code).toBe(status.PERMISSION_DENIED);
      expect(errorCode(error)).toBe('TENANT_MISMATCH');
    });

    it('refuses a call without a principal (UNAUTHENTICATED)', async () => {
      const error = await failureOf(
        lastValueFrom(ai.createConversation({ tenantId: TENANT_ID, userId: ADA })),
      );
      expect(error.code).toBe(status.UNAUTHENTICATED);
    });

    it("hides another user's conversation (NOT_FOUND CONVERSATION_NOT_FOUND)", async () => {
      const own = await create(ADA);
      const error = await failureOf(
        lastValueFrom(
          ai.getConversation(
            { tenantId: TENANT_ID, userId: BOB, conversationId: own.id },
            callerOf(BOB),
          ),
        ),
      );
      expect(error.code).toBe(status.NOT_FOUND);
      expect(errorCode(error)).toBe('CONVERSATION_NOT_FOUND');
      const otherTenant = await failureOf(
        lastValueFrom(
          ai.getConversation(
            { tenantId: OTHER_TENANT_ID, userId: ADA, conversationId: own.id },
            callerOf(ADA, OTHER_TENANT_ID),
          ),
        ),
      );
      expect(otherTenant.code).toBe(status.NOT_FOUND);
    });

    it('SendMessage stores both messages and a usage row, and replays by Idempotency-Key', async () => {
      model = mockTextModel('Answer from the model.');
      const conversation = await create();
      const request = {
        tenantId: TENANT_ID,
        userId: ADA,
        conversationId: conversation.id,
        content: 'Hi',
        idempotencyKey: 'grpc-key-0001',
      };

      const sent = await lastValueFrom(ai.sendMessage(request, callerOf(ADA)));
      expect(sent.replayed).toBe(false);
      expect(sent.message).toMatchObject({
        role: 'assistant',
        contentJson: JSON.stringify('Answer from the model.'),
        status: 'complete',
        model: 'mock/default',
      });
      const replay = await lastValueFrom(ai.sendMessage(request, callerOf(ADA)));
      expect(replay).toMatchObject({ replayed: true, message: { id: sent.message?.id } });

      const stored = persistence.store.messages.filter((m) => m.conversationId === conversation.id);
      expect(stored.map((m) => [m.role, m.content]).sort()).toEqual([
        ['assistant', 'Answer from the model.'],
        ['user', 'Hi'],
      ]);
      expect(
        persistence.store.usage.filter((u) => u.conversationId === conversation.id),
      ).toHaveLength(1);
    });

    it('rejects an invalid payload with the issues (INVALID_ARGUMENT)', async () => {
      const error = await failureOf(
        lastValueFrom(
          ai.sendMessage(
            { tenantId: TENANT_ID, userId: ADA, conversationId: 'nope', content: '' },
            callerOf(ADA),
          ),
        ),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    });
  });

  describe('StreamMessage', () => {
    it('streams started, the deltas in order and done; the reply is stored once', async () => {
      model = mockStreamModel(['Hel', 'lo', ' there'], {
        usage: { inputTokens: 9, outputTokens: 3 },
      });
      const conversation = await create();

      const events = await collect(
        ai.streamMessage(
          { tenantId: TENANT_ID, userId: ADA, conversationId: conversation.id, content: 'Hi' },
          callerOf(ADA),
        ),
      );

      const kinds = events.map((e: StreamMessageEvent) =>
        e.started ? 'started' : e.delta ? `delta:${e.delta.text}` : e.done ? 'done' : '?',
      );
      expect(kinds).toEqual(['started', 'delta:Hel', 'delta:lo', 'delta: there', 'done']);
      expect(events.at(-1)?.done).toMatchObject({
        replayed: false,
        usage: { inputTokens: 9, outputTokens: 3 },
        message: { contentJson: JSON.stringify('Hello there'), status: 'complete' },
      });
      const stored = persistence.store.messages.filter((m) => m.conversationId === conversation.id);
      expect(stored.map((m) => [m.role, m.status]).sort()).toEqual([
        ['assistant', 'complete'],
        ['user', 'complete'],
      ]);
    });

    it('a refusal is the status of the call, before any event (NOT_FOUND)', async () => {
      const events: StreamMessageEvent[] = [];
      const error = await new Promise<ServiceError>((resolve, reject) => {
        ai.streamMessage(
          { tenantId: TENANT_ID, userId: ADA, conversationId: generateId(), content: 'Hi' },
          callerOf(ADA),
        ).subscribe({
          next: (event) => events.push(event),
          error: (caught: unknown) => resolve(caught as ServiceError),
          complete: () => reject(new Error('expected the stream to fail')),
        });
      });
      expect(events).toEqual([]);
      expect(error.code).toBe(status.NOT_FOUND);
      expect(errorCode(error)).toBe('CONVERSATION_NOT_FOUND');
    });

    it('cancelling the call aborts the model call; the partial reply is stored as incomplete', async () => {
      const hanging = mockHangingModel(['partial ']);
      model = hanging;
      const conversation = await create();

      await new Promise<void>((resolve, reject) => {
        const subscription = ai
          .streamMessage(
            { tenantId: TENANT_ID, userId: ADA, conversationId: conversation.id, content: 'Go on' },
            callerOf(ADA),
          )
          .subscribe({
            next: (event) => {
              // The first delta arrived: the client goes away (grpc-js cancels the call).
              if (event.delta !== undefined && event.delta !== null) {
                setImmediate(() => subscription.unsubscribe());
                resolve();
              }
            },
            error: reject,
          });
      });

      await expect(hanging.aborted).resolves.toBeUndefined();
      const assistant = () =>
        persistence.store.messages.filter(
          (m) => m.conversationId === conversation.id && m.role === 'assistant',
        );
      await vi.waitFor(() => expect(assistant()).toHaveLength(1));
      expect(assistant().map((m) => [m.content, m.status])).toEqual([['partial ', 'incomplete']]);
      expect(
        persistence.store.usage
          .filter((u) => u.conversationId === conversation.id)
          .map((u) => u.outcome),
      ).toEqual(['aborted']);
    });
  });

  describe('tools', () => {
    it("runs the tools through the owners' ports as the caller from the metadata", async () => {
      // identity-, notifications- and billing-service stand in behind the real gRPC adapters:
      // each records the principal its call ran as.
      const toolCalls: { tool: string; principal: Principal | undefined }[] = [];
      const getUser = vi.spyOn(app.get(UsersPort), 'getUser').mockImplementation(async (id) => {
        toolCalls.push({ tool: 'getUser', principal: getPrincipal() });
        return { id, email: 'ada@example.com', displayName: 'Ada', roles: [] };
      });
      vi.spyOn(app.get(NotificationsPort), 'list').mockImplementation(async () => {
        toolCalls.push({ tool: 'listNotifications', principal: getPrincipal() });
        return { items: [] };
      });
      vi.spyOn(app.get(BillingPort), 'listPayments').mockImplementation(async () => {
        toolCalls.push({ tool: 'listPayments', principal: getPrincipal() });
        return { items: [] };
      });
      model = mockScriptedModel([
        {
          toolCalls: [
            { toolName: 'get_my_profile', input: {} },
            { toolName: 'list_my_notifications', input: {} },
            { toolName: 'list_my_payments', input: {} },
          ],
        },
        (call) => ({ text: toolResultsOf(call) }),
      ]);
      const conversation = await create();

      const sent = await lastValueFrom(
        ai.sendMessage(
          {
            tenantId: TENANT_ID,
            userId: ADA,
            conversationId: conversation.id,
            content: 'What do you know about me?',
          },
          callerOf(ADA),
        ),
      );

      const results = JSON.parse(JSON.parse(sent.message?.contentJson ?? '""') as string) as {
        tool: string;
        output: { type: string; value: unknown };
      }[];
      // list_my_notifications needs notifications:read: resolvable here (NOTIFICATIONS_RBAC).
      expect(results.map((r) => [r.tool, r.output.type])).toEqual([
        ['get_my_profile', 'json'],
        ['list_my_notifications', 'json'],
        ['list_my_payments', 'json'],
      ]);
      expect(results[0]?.output.value).toMatchObject({ id: ADA, email: 'ada@example.com' });
      expect(results[1]?.output.value).not.toHaveProperty('error');
      expect(toolCalls.map((c) => c.tool)).toEqual([
        'getUser',
        'listNotifications',
        'listPayments',
      ]);
      for (const call of toolCalls) {
        expect(call.principal).toMatchObject({ userId: ADA, tenantId: TENANT_ID });
      }
      expect(getUser).toHaveBeenCalledWith(ADA);
    });
  });
});
