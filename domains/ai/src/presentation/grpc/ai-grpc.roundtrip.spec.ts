import { AI_GRPC_PACKAGE } from '@domain/ai-contracts';
import { Metadata, type ServerUnaryCall, status } from '@grpc/grpc-js';
import {
  type CallHandler,
  type ExecutionContext,
  type INestMicroservice,
  Injectable,
  Module,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { AiDisabledError, AiUpstreamError } from '@platform/ai';
import { RbacModule } from '@platform/auth';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  DomainValidationException,
  EntityNotFoundException,
  generateId,
  getPrincipal,
  markTokenVerified,
  type Principal,
  ServiceUnavailableException,
} from '@platform/common';
import { AppConfigModule, grpcConfig } from '@platform/config';
import { createGrpcServerStrategy, GRPC_METADATA_KEYS } from '@platform/transport';
import { withBoundGrpcPort } from '@platform/transport/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiApiModule } from '../../ai-api.module.js';
import {
  AiPort,
  type ChatStreamEvent,
  type StreamMessageRequest,
} from '../../application/ports/ai.port.js';
import {
  ChatIdempotencyKeyReusedException,
  ConversationNotFoundException,
} from '../../domain/ai.errors.js';
import type { Conversation, Message } from '../../domain/ai.types.js';
import {
  AiGrpcAdapter,
  isAiServiceAnswer,
} from '../../infrastructure/adapters/grpc/ai-grpc.adapter.js';
import { AiResolver } from '../graphql/ai.resolver.js';
import { AiGrpcController } from './ai-grpc.controller.js';

/*
 * The microservices topology of the ai context in-process, over REAL gRPC (ai.v1 protos, loopback):
 *   gateway: AiApiModule.forRemote() → AiGrpcAdapter
 *     → grpc-js + proto-loader (defaults: true, oneofs: true) →
 *   ai-service: AiGrpcController → a fake AiPort (what AiLocalAdapter fronts in ai-service).
 * Each test proves the remote port hands the presentation layer exactly what the local port
 * returns (Dates, nulls, JSON content), that the caller's principal travels in metadata, that
 * domain error codes survive the hop, and that the streamed turn keeps its order, its refusals
 * (before any event) and its cancellation (the client's abort reaches the service's signal), and
 * that ai-service sees each call's own deadline: GRPC_DEADLINE_MS for the conversation calls,
 * AI_GRPC_CHAT_DEADLINE_MS for a chat turn.
 */

const TENANT_ID = '01920000-0000-7000-8000-0000000000a1';
const USER_ID = '01920000-0000-7000-8000-0000000000b1';
const CONVERSATION_ID = '01920000-0000-7000-8000-0000000000c1';
const CALLER = { tenantId: TENANT_ID, userId: USER_ID };
const GRPC_DEADLINE_MS = 3000;
/** `AI_GRPC_CHAT_DEADLINE_MS`'s default: the spec leaves it unset. */
const CHAT_DEADLINE_MS = 70_000;

/** The time left until each call's deadline when ai-service's handler started (ms), by handler. */
const deadlineLeftMs = new Map<string, number>();

/** Records the deadline of every call ai-service serves, as its handlers would see it. */
@Injectable()
class DeadlineRecorder implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const call = context.getArgByIndex<ServerUnaryCall<unknown, unknown>>(2);
    const deadline = call.getDeadline();
    deadlineLeftMs.set(
      context.getHandler().name,
      (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now(),
    );
    return next.handle();
  }
}

const port = {
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  streamMessage: vi.fn(),
};

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [AiGrpcController],
  providers: [
    { provide: AiPort, useValue: port },
    { provide: APP_INTERCEPTOR, useClass: DeadlineRecorder },
  ],
})
class AiServiceTestModule {}

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  tenantId: TENANT_ID,
  id: CONVERSATION_ID,
  userId: USER_ID,
  title: null,
  model: 'mock/default',
  createdAt: new Date('2026-11-20T10:00:00.123Z'),
  updatedAt: new Date('2026-11-20T10:05:00.000Z'),
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  tenantId: TENANT_ID,
  id: generateId(),
  conversationId: CONVERSATION_ID,
  userId: USER_ID,
  role: 'assistant',
  content: 'Hello there',
  status: 'complete',
  model: 'mock/default',
  inputTokens: 9,
  outputTokens: 3,
  idempotencyKey: null,
  requestHash: null,
  createdAt: new Date('2026-11-20T10:05:00.000Z'),
  ...overrides,
});

/** Resolves when `signal` aborts (the service saw the cancellation). */
const aborted = (signal: AbortSignal): Promise<unknown> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve(signal.reason);
    else signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  });

/** A stream that yields `texts`, then hangs until the request's signal aborts (then throws). */
function hangingStream(request: StreamMessageRequest, texts: string[]) {
  const signal = request.signal ?? new AbortController().signal;
  return (async function* (): AsyncGenerator<ChatStreamEvent> {
    for (const text of texts) yield { type: 'delta', text };
    await aborted(signal);
    throw signal.reason;
  })();
}

describe('ai over gRPC (forRemote adapter ↔ AiGrpcController)', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let remote: AiPort;
  let cls: ClsService;
  // What the gateway's own token verification writes (`writePrincipal` in @platform/auth): only a
  // principal marked token-verified leaves the process in caller metadata.
  const principal: Principal = markTokenVerified(
    createPrincipal({
      userId: USER_ID,
      tenantId: TENANT_ID,
      roles: ['member'],
    }),
  );
  /** Runs `work` as the gateway does inside an authenticated request (the CLS principal). */
  const asCaller = <T>(work: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      cls.set(CLS_PRINCIPAL, principal);
      return work();
    });

  beforeAll(async () => {
    const { port: grpcPort } = await withBoundGrpcPort(async () => {
      server = await NestFactory.createMicroservice(AiServiceTestModule, {
        ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: '127.0.0.1:0' }), [
          AI_GRPC_PACKAGE,
        ]),
        logger: false,
      });
      await server.listen();
    });
    vi.stubEnv('AI_GRPC_URL', `127.0.0.1:${grpcPort}`);
    vi.stubEnv('GRPC_DEADLINE_MS', String(GRPC_DEADLINE_MS));

    gateway = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        ClsModule.forRoot({ global: true }),
        RbacModule.forRoot(),
        AiApiModule.forRemote(),
      ],
    })
      // The resolver needs the app's GraphQL PubSub; this spec only drives the port.
      .overrideProvider(AiResolver)
      .useValue({})
      .compile();
    gateway.useLogger(false);
    await gateway.init();
    remote = gateway.get(AiPort);
    cls = gateway.get(ClsService);
  });

  afterAll(async () => {
    await gateway?.close();
    await server?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    for (const fn of Object.values(port)) fn.mockReset();
    deadlineLeftMs.clear();
  });

  it('forRemote() binds AiPort to the gRPC adapter', () => {
    expect(remote).toBeInstanceOf(AiGrpcAdapter);
  });

  describe('deadlines ai-service sees', () => {
    const request = { ...CALLER, conversationId: CONVERSATION_ID, content: 'Hi' };

    it('a conversation call carries GRPC_DEADLINE_MS, not the chat deadline', async () => {
      port.listConversations.mockResolvedValue({ items: [], nextCursor: null });

      await asCaller(() => remote.listConversations(CALLER));

      const left = deadlineLeftMs.get('listConversations');
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(GRPC_DEADLINE_MS);
    });

    it('SendMessage carries AI_GRPC_CHAT_DEADLINE_MS', async () => {
      port.sendMessage.mockResolvedValue({ message: message(), replayed: false });

      await asCaller(() => remote.sendMessage(request));

      const left = deadlineLeftMs.get('sendMessage');
      expect(left).toBeGreaterThan(GRPC_DEADLINE_MS);
      expect(left).toBeLessThanOrEqual(CHAT_DEADLINE_MS);
    });

    it('StreamMessage carries AI_GRPC_CHAT_DEADLINE_MS for the whole stream', async () => {
      port.streamMessage.mockImplementation(async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'done', message: message(), replayed: false, usage: null };
        })(),
      );

      await asCaller(async () => {
        for await (const _event of await remote.streamMessage(request)) {
          // drain
        }
      });

      const left = deadlineLeftMs.get('streamMessage');
      expect(left).toBeGreaterThan(GRPC_DEADLINE_MS);
      expect(left).toBeLessThanOrEqual(CHAT_DEADLINE_MS);
    });
  });

  describe('unary', () => {
    it("CreateConversation: the caller's principal travels in metadata; the record comes back as is", async () => {
      const created = conversation({ title: 'Trip plans' });
      let seen: Principal | undefined;
      port.createConversation.mockImplementation(async () => {
        seen = getPrincipal();
        return created;
      });

      const result = await asCaller(() =>
        remote.createConversation({ ...CALLER, title: 'Trip plans' }),
      );

      expect(result).toEqual(created);
      expect(seen).toMatchObject({ userId: USER_ID, tenantId: TENANT_ID, roles: ['member'] });
      // Absent optionals reach the port as undefined (never proto-loader's null).
      expect(port.createConversation).toHaveBeenCalledWith({
        ...CALLER,
        title: 'Trip plans',
        model: undefined,
      });
    });

    it('ListConversations: an untitled conversation keeps title null; the cursor travels both ways', async () => {
      port.listConversations.mockResolvedValue({
        items: [conversation(), conversation({ id: generateId(), title: 'Named' })],
        nextCursor: 'cursor-2',
      });

      const page = await asCaller(() =>
        remote.listConversations({ ...CALLER, limit: 2, cursor: 'cursor-1' }),
      );

      expect(page).toEqual({
        items: [conversation(), expect.objectContaining({ title: 'Named' })],
        nextCursor: 'cursor-2',
      });
      expect(page.items[0]?.title).toBeNull();
      expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
      expect(port.listConversations).toHaveBeenCalledWith({
        ...CALLER,
        limit: 2,
        cursor: 'cursor-1',
      });
    });

    it('ListConversations: no limit and no cursor reach the port as undefined; the last page has nextCursor null', async () => {
      port.listConversations.mockResolvedValue({ items: [], nextCursor: null });

      await expect(asCaller(() => remote.listConversations(CALLER))).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      expect(port.listConversations).toHaveBeenCalledWith({
        ...CALLER,
        limit: undefined,
        cursor: undefined,
      });
    });

    it('GetConversation: CONVERSATION_NOT_FOUND survives the hop', async () => {
      port.getConversation.mockRejectedValue(new ConversationNotFoundException(CONVERSATION_ID));

      const error = await asCaller(() =>
        remote.getConversation({ ...CALLER, conversationId: CONVERSATION_ID }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EntityNotFoundException);
      expect(error).toMatchObject({ code: 'CONVERSATION_NOT_FOUND', httpStatus: 404 });
    });

    it('DeleteConversation: Empty → void', async () => {
      port.deleteConversation.mockResolvedValue(undefined);

      await expect(
        asCaller(() => remote.deleteConversation({ ...CALLER, conversationId: CONVERSATION_ID })),
      ).resolves.toBeUndefined();
      expect(port.deleteConversation).toHaveBeenCalledWith({
        ...CALLER,
        conversationId: CONVERSATION_ID,
      });
    });

    it('ListMessages: text and part contents, null tokens and keys come back unchanged', async () => {
      const parts = message({
        role: 'tool',
        content: [{ type: 'tool-result', toolName: 'get_my_profile', output: { a: [1, null] } }],
        model: null,
        inputTokens: null,
        outputTokens: null,
      });
      const keyed = message({ idempotencyKey: 'key-00000001', requestHash: 'ab'.repeat(32) });
      port.listMessages.mockResolvedValue({ items: [keyed, parts], nextCursor: null });

      const page = await asCaller(() =>
        remote.listMessages({ ...CALLER, conversationId: CONVERSATION_ID, limit: 10 }),
      );

      expect(page).toEqual({ items: [keyed, parts], nextCursor: null });
    });

    it('SendMessage: the reply and the replay flag; Idempotency-Key and model reach the port', async () => {
      const reply = message({ idempotencyKey: 'key-00000002', requestHash: 'cd'.repeat(32) });
      port.sendMessage.mockResolvedValue({ message: reply, replayed: true });

      const request = {
        ...CALLER,
        conversationId: CONVERSATION_ID,
        content: 'Hi',
        model: 'mock/other',
        idempotencyKey: 'key-00000002',
      };
      await expect(asCaller(() => remote.sendMessage(request))).resolves.toEqual({
        message: reply,
        replayed: true,
      });
      expect(port.sendMessage).toHaveBeenCalledWith(request);
    });

    it('SendMessage: AI_DISABLED (503) keeps its code', async () => {
      port.sendMessage.mockRejectedValue(new AiDisabledError());

      const error = await asCaller(() =>
        remote.sendMessage({ ...CALLER, conversationId: CONVERSATION_ID, content: 'Hi' }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error).toMatchObject({ code: 'AI_DISABLED', httpStatus: 503 });
    });

    it('rejects a malformed request at the service (INVALID_ARGUMENT → 422) without calling the port', async () => {
      const error = await asCaller(() =>
        remote.getConversation({ ...CALLER, conversationId: 'not-a-uuid' }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainValidationException);
      expect(port.getConversation).not.toHaveBeenCalled();
    });
  });

  describe('StreamMessage (server streaming)', () => {
    const request = { ...CALLER, conversationId: CONVERSATION_ID, content: 'Hi' };

    it('delivers the deltas in order, then done with the stored reply and usage', async () => {
      const reply = message({ content: 'Hello there' });
      let seen: Principal | undefined;
      port.streamMessage.mockImplementation(async () => {
        seen = getPrincipal();
        return (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'delta', text: 'Hel' };
          yield { type: 'delta', text: 'lo there' };
          yield {
            type: 'done',
            message: reply,
            replayed: false,
            usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.000_12 },
          };
        })();
      });

      const events: ChatStreamEvent[] = [];
      await asCaller(async () => {
        for await (const event of await remote.streamMessage(request)) events.push(event);
      });

      expect(events).toEqual([
        { type: 'delta', text: 'Hel' },
        { type: 'delta', text: 'lo there' },
        {
          type: 'done',
          message: reply,
          replayed: false,
          usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.000_12 },
        },
      ]);
      expect(seen).toMatchObject({ userId: USER_ID, tenantId: TENANT_ID });
      // The service's port got a signal of its own (the gRPC call's cancellation).
      const [sent] = port.streamMessage.mock.calls[0] as [StreamMessageRequest];
      expect(sent).toMatchObject(request);
      expect(sent.signal).toBeInstanceOf(AbortSignal);
    });

    it('a replay is a single done with usage null', async () => {
      const reply = message({ idempotencyKey: 'key-00000003' });
      port.streamMessage.mockImplementation(async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'done', message: reply, replayed: true, usage: null };
        })(),
      );

      const events: ChatStreamEvent[] = [];
      await asCaller(async () => {
        const stream = await remote.streamMessage({ ...request, idempotencyKey: 'key-00000003' });
        for await (const event of stream) events.push(event);
      });

      expect(events).toEqual([{ type: 'done', message: reply, replayed: true, usage: null }]);
    });

    it('a refusal rejects streamMessage itself, before any event (409 keeps its code)', async () => {
      port.streamMessage.mockRejectedValue(new ChatIdempotencyKeyReusedException());

      const error = await asCaller(() => remote.streamMessage(request)).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
    });

    it('a failure after the first delta is thrown by the iterator, with its code', async () => {
      port.streamMessage.mockImplementation(async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'delta', text: 'Hel' };
          throw new AiUpstreamError();
        })(),
      );

      const events: ChatStreamEvent[] = [];
      const error = await asCaller(async () => {
        for await (const event of await remote.streamMessage(request)) events.push(event);
      }).catch((caught: unknown) => caught);

      expect(events).toEqual([{ type: 'delta', text: 'Hel' }]);
      expect(error).toMatchObject({ code: 'AI_UPSTREAM_ERROR', httpStatus: 502 });
    });

    it("the client's abort cancels the call; the service's signal aborts (no tokens for nobody)", async () => {
      let serverSignal: AbortSignal | undefined;
      port.streamMessage.mockImplementation(async (sent: StreamMessageRequest) => {
        serverSignal = sent.signal;
        return hangingStream(sent, ['partial ']);
      });
      const client = new AbortController();

      const events: ChatStreamEvent[] = [];
      const consumed = asCaller(async () => {
        for await (const event of await remote.streamMessage({
          ...request,
          signal: client.signal,
        })) {
          events.push(event);
          if (events.length === 1) client.abort(new Error('client went away'));
        }
      }).catch((caught: unknown) => caught);

      expect(await consumed).toMatchObject({ message: 'client went away' });
      expect(events).toEqual([{ type: 'delta', text: 'partial ' }]);
      if (serverSignal === undefined) throw new Error('the service was never called');
      await expect(aborted(serverSignal)).resolves.toBeDefined();
    });

    it('a consumer that stops reading cancels the call too', async () => {
      let serverSignal: AbortSignal | undefined;
      port.streamMessage.mockImplementation(async (sent: StreamMessageRequest) => {
        serverSignal = sent.signal;
        return hangingStream(sent, ['one ', 'two ']);
      });

      await asCaller(async () => {
        for await (const event of await remote.streamMessage(request)) {
          expect(event).toEqual({ type: 'delta', text: 'one ' });
          break;
        }
      });

      if (serverSignal === undefined) throw new Error('the service was never called');
      await expect(aborted(serverSignal)).resolves.toBeDefined();
    });

    it('an already aborted signal never reaches the service', async () => {
      const client = new AbortController();
      client.abort(new Error('gone before the call'));

      await expect(
        asCaller(() => remote.streamMessage({ ...request, signal: client.signal })),
      ).rejects.toMatchObject({ message: 'gone before the call' });
      expect(port.streamMessage).not.toHaveBeenCalled();
    });
  });
});

describe('isAiServiceAnswer (the breaker filter of the ai upstream)', () => {
  const serviceError = (code: number, errorCode?: string) => {
    const metadata = new Metadata();
    if (errorCode !== undefined) metadata.set(GRPC_METADATA_KEYS.ERROR_CODE, errorCode);
    return { code, details: 'x', message: 'x', metadata };
  };

  it('does not count the model outcomes ai-service reported as ai-service failures', () => {
    expect(isAiServiceAnswer(serviceError(status.UNAVAILABLE, 'AI_DISABLED'))).toBe(true);
    expect(isAiServiceAnswer(serviceError(status.DEADLINE_EXCEEDED, 'AI_TIMEOUT'))).toBe(true);
    expect(isAiServiceAnswer(serviceError(status.UNAVAILABLE, 'AI_UPSTREAM_ERROR'))).toBe(true);
    expect(isAiServiceAnswer(serviceError(status.NOT_FOUND, 'CONVERSATION_NOT_FOUND'))).toBe(true);
  });

  it('counts an unreachable or failing ai-service', () => {
    expect(isAiServiceAnswer(serviceError(status.UNAVAILABLE))).toBe(false);
    expect(isAiServiceAnswer(serviceError(status.INTERNAL, 'INTERNAL_ERROR'))).toBe(false);
    expect(isAiServiceAnswer(new Error('boom'))).toBe(false);
  });
});
