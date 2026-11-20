import { AI_GRPC_PACKAGE } from '@domain/ai-contracts';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiDisabledError } from '@platform/ai';
import {
  type CursorPage,
  generateId,
  getPrincipal,
  type Principal,
  requirePrincipal,
} from '@platform/common';
import { grpcConfig } from '@platform/config';
import { createGrpcServerStrategy } from '@platform/transport';
import { ClsModule } from 'nestjs-cls';
import {
  AiPort,
  type ChatStreamEvent,
  type ConversationRequest,
  type CreateConversationRequest,
  type ListConversationsRequest,
  type ListMessagesRequest,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamMessageRequest,
} from '../application/ports/ai.port.js';
import { AiTenantMismatchException, ConversationNotFoundException } from '../domain/ai.errors.js';
import type { Conversation, Message } from '../domain/ai.types.js';
import { AiGrpcController } from '../presentation/grpc/ai-grpc.controller.js';

/** How the next streamed turn of `FakeAiPort` goes: its deltas, then the end. */
export interface FakeStreamScript {
  readonly deltas: readonly string[];
  /** `done` (default): the stored reply; `hang`: wait for the cancellation; an error: throw it. */
  readonly end?: 'done' | 'hang' | Error;
}

/**
 * ai-service's `AiPort` in memory, for edge tests of the microservices topology: conversations and
 * messages per owner (another user's or tenant's are not found), the caller checked against the
 * CLS principal (adopted from the gRPC metadata), a fixed reply, and scripted streamed turns. It
 * records the principal of every call and the signal of every streamed turn, so a test can assert
 * what crossed the hop (the caller, the cancellation).
 */
export class FakeAiPort implements AiPort {
  readonly conversations = new Map<string, Conversation>();
  readonly messages: Message[] = [];
  /** The principal each call ran as, in call order. */
  readonly principals: (Principal | undefined)[] = [];
  /** The signal of each streamed turn, in call order. */
  readonly streamSignals: AbortSignal[] = [];
  /** `AI_ENABLED=false`: every chat call and create answers 503 `AI_DISABLED`. */
  disabled = false;
  reply = 'Hello from the fake ai-service.';
  stream: FakeStreamScript = { deltas: ['Hel', 'lo'] };

  async createConversation(input: CreateConversationRequest): Promise<Conversation> {
    this.caller(input);
    if (this.disabled) throw new AiDisabledError();
    const now = new Date();
    const conversation: Conversation = {
      tenantId: input.tenantId,
      id: generateId(),
      userId: input.userId,
      title: input.title ?? null,
      model: input.model ?? 'mock/default',
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async listConversations(input: ListConversationsRequest): Promise<CursorPage<Conversation>> {
    this.caller(input);
    const items = [...this.conversations.values()]
      .filter((c) => c.tenantId === input.tenantId && c.userId === input.userId)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return { items, nextCursor: null };
  }

  async getConversation(input: ConversationRequest): Promise<Conversation> {
    this.caller(input);
    return this.owned(input);
  }

  async deleteConversation(input: ConversationRequest): Promise<void> {
    this.caller(input);
    this.conversations.delete(this.owned(input).id);
  }

  async listMessages(input: ListMessagesRequest): Promise<CursorPage<Message>> {
    this.caller(input);
    const conversation = this.owned(input);
    const items = this.messages
      .filter((m) => m.conversationId === conversation.id)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return { items, nextCursor: null };
  }

  async sendMessage(input: SendMessageRequest): Promise<SendMessageResult> {
    this.caller(input);
    if (this.disabled) throw new AiDisabledError();
    this.owned(input);
    this.messages.push(this.message(input, 'user', input.content));
    const reply = this.message(input, 'assistant', this.reply);
    this.messages.push(reply);
    return { message: reply, replayed: false };
  }

  async streamMessage(input: StreamMessageRequest): Promise<AsyncIterable<ChatStreamEvent>> {
    this.caller(input);
    if (this.disabled) throw new AiDisabledError();
    this.owned(input);
    const signal = input.signal ?? new AbortController().signal;
    this.streamSignals.push(signal);
    const script = this.stream;
    const store = (text: string, status: Message['status']): Message => {
      this.messages.push(this.message(input, 'user', input.content));
      const reply = { ...this.message(input, 'assistant', text), status };
      this.messages.push(reply);
      return reply;
    };
    return (async function* (): AsyncGenerator<ChatStreamEvent> {
      let text = '';
      for (const delta of script.deltas) {
        text += delta;
        yield { type: 'delta', text: delta };
      }
      if (script.end instanceof Error) throw script.end;
      if (script.end === 'hang') {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        store(text, 'incomplete');
        throw signal.reason;
      }
      const message = store(text, 'complete');
      yield {
        type: 'done',
        message,
        replayed: false,
        usage: { inputTokens: 7, outputTokens: script.deltas.length, costUsd: null },
      };
    })();
  }

  /** The handlers' `requireCaller`: the request must name the principal's tenant and user. */
  private caller(input: { tenantId: string; userId: string }): void {
    this.principals.push(getPrincipal());
    const principal = requirePrincipal();
    if (principal.tenantId !== input.tenantId || principal.userId !== input.userId) {
      throw new AiTenantMismatchException();
    }
  }

  private owned(input: ConversationRequest): Conversation {
    const conversation = this.conversations.get(input.conversationId);
    if (
      conversation === undefined ||
      conversation.tenantId !== input.tenantId ||
      conversation.userId !== input.userId
    ) {
      throw new ConversationNotFoundException(input.conversationId);
    }
    return conversation;
  }

  private message(input: ConversationRequest, role: Message['role'], content: string): Message {
    return {
      tenantId: input.tenantId,
      id: generateId(),
      conversationId: input.conversationId,
      userId: input.userId,
      role,
      content,
      status: 'complete',
      model: role === 'assistant' ? 'mock/default' : null,
      inputTokens: null,
      outputTokens: null,
      idempotencyKey: null,
      requestHash: null,
      createdAt: new Date(),
    };
  }
}

/**
 * Starts a stand-in ai-service on `url` (`127.0.0.1:<port>`): the REAL `AiGrpcController` (payload
 * validation, the principal from the metadata, error trailers, the streamed turn and its
 * cancellation) over `port`. Close it with `close()`.
 */
export async function startFakeAiService(url: string, port: AiPort): Promise<INestMicroservice> {
  @Module({
    imports: [ClsModule.forRoot({ global: true })],
    controllers: [AiGrpcController],
    providers: [{ provide: AiPort, useValue: port }],
  })
  class FakeAiServiceModule {}

  const server = await NestFactory.createMicroservice(FakeAiServiceModule, {
    ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: url }), [AI_GRPC_PACKAGE]),
    logger: false,
  });
  await server.listen();
  return server;
}
