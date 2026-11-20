import {
  AI_GRPC_PACKAGE,
  AI_SERVICE_NAME,
  type AiServiceClient,
  type StreamMessageEvent,
} from '@domain/ai-contracts';
import type { Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { CursorPage } from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import {
  callerContextFromCls,
  createOutgoingMetadata,
  type GrpcCircuitBreaker,
  GrpcCircuitBreakers,
  grpcCall,
  grpcClientCode,
  grpcErrorToDomainException,
  isCallerError,
  isGrpcServiceError,
  parseGrpcOperation,
  readErrorTrailers,
  recordGrpcCall,
} from '@platform/transport';
import { ClsService } from 'nestjs-cls';
import type { Observable, Subscription } from 'rxjs';
import { AI_GRPC_UPSTREAM, AI_SERVICE_ANSWER_CODES } from '../../../ai.constants.js';
import {
  fromConversationContract,
  fromConversationPageContract,
  fromMessagePageContract,
  fromSendMessageResultContract,
  fromStreamEventContract,
} from '../../../application/mappers/ai-contract.mapper.js';
import type {
  AiPort,
  ChatStreamEvent,
  ConversationRequest,
  CreateConversationRequest,
  ListConversationsRequest,
  ListMessagesRequest,
  SendMessageRequest,
  SendMessageResult,
  StreamMessageRequest,
} from '../../../application/ports/ai.port.js';
import type { Conversation, Message } from '../../../domain/ai.types.js';
import { type AiGrpcClientConfig, aiGrpcClientConfig } from './ai-grpc-client.config.js';

const operation = (method: string): string =>
  `${AI_GRPC_PACKAGE.package}.${AI_SERVICE_NAME}/${method}`;

/**
 * The `ai` circuit breaker's error filter (`true` = not a failure of ai-service): the caller's own
 * mistakes (`isCallerError`) and every status ai-service answered with one of its model-call codes
 * (`AI_DISABLED`, `AI_TIMEOUT`, `AI_UPSTREAM_ERROR`, …). A disabled feature or a slow model is not
 * an outage of the service, and must not open the breaker for the conversation reads too.
 */
export function isAiServiceAnswer(error: unknown): boolean {
  if (isCallerError(error)) return true;
  if (!isGrpcServiceError(error)) return false;
  const code = readErrorTrailers(error.metadata).code;
  return code !== undefined && (AI_SERVICE_ANSWER_CODES as readonly string[]).includes(code);
}

/**
 * `AiPort` over gRPC (gateway → ai-service): per-call deadline (`GRPC_DEADLINE_MS`, or
 * `AI_GRPC_CHAT_DEADLINE_MS` for a chat turn), the `ai` circuit breaker, request/correlation id
 * and the caller's principal in metadata, and upstream failures mapped back to the same
 * `DomainException`s the local adapter throws (`grpcCall`). Records come back exactly as the local
 * adapter returns them (`from*Contract`).
 *
 * `streamMessage` resolves on ai-service's `started` event (a refusal rejects it, before any event)
 * and then yields its events. Aborting the request's `signal`, or a consumer that stops reading,
 * cancels the call: ai-service aborts the model call and stores the reply so far as `incomplete`.
 */
@Injectable()
export class AiGrpcAdapter implements AiPort, OnModuleInit {
  private client: AiServiceClient;

  constructor(
    @Inject(AI_GRPC_PACKAGE.clientToken) private readonly grpc: ClientGrpc,
    @Inject(grpcConfig.KEY) private readonly config: GrpcConfig,
    @Inject(aiGrpcClientConfig.KEY) private readonly ai: AiGrpcClientConfig,
    private readonly breakers: GrpcCircuitBreakers,
    @Optional() private readonly cls?: ClsService,
  ) {}

  onModuleInit(): void {
    this.client = this.grpc.getService<AiServiceClient>(AI_SERVICE_NAME);
  }

  async createConversation(input: CreateConversationRequest): Promise<Conversation> {
    const conversation = await this.call('CreateConversation', (md) =>
      this.client.createConversation(
        { tenantId: input.tenantId, userId: input.userId, title: input.title, model: input.model },
        md,
      ),
    );
    return fromConversationContract(conversation);
  }

  async listConversations(input: ListConversationsRequest): Promise<CursorPage<Conversation>> {
    const page = await this.call('ListConversations', (md) =>
      this.client.listConversations(
        {
          tenantId: input.tenantId,
          userId: input.userId,
          limit: input.limit ?? 0,
          cursor: input.cursor,
        },
        md,
      ),
    );
    return fromConversationPageContract(page);
  }

  async getConversation(input: ConversationRequest): Promise<Conversation> {
    const conversation = await this.call('GetConversation', (md) =>
      this.client.getConversation(conversationRequest(input), md),
    );
    return fromConversationContract(conversation);
  }

  async deleteConversation(input: ConversationRequest): Promise<void> {
    await this.call('DeleteConversation', (md) =>
      this.client.deleteConversation(conversationRequest(input), md),
    );
  }

  async listMessages(input: ListMessagesRequest): Promise<CursorPage<Message>> {
    const page = await this.call('ListMessages', (md) =>
      this.client.listMessages(
        {
          ...conversationRequest(input),
          limit: input.limit ?? 0,
          cursor: input.cursor,
        },
        md,
      ),
    );
    return fromMessagePageContract(page);
  }

  async sendMessage(input: SendMessageRequest): Promise<SendMessageResult> {
    const result = await this.call(
      'SendMessage',
      (md) => this.client.sendMessage(sendRequest(input), md),
      this.ai.chatDeadlineMs,
    );
    return fromSendMessageResultContract(result);
  }

  async streamMessage(input: StreamMessageRequest): Promise<AsyncIterable<ChatStreamEvent>> {
    const { signal } = input;
    signal?.throwIfAborted();
    const op = operation('StreamMessage');
    const stream = new GrpcEventStream(
      this.client.streamMessage(sendRequest(input), this.metadata()),
      op,
      signal,
    );
    // The breaker sees the opening only (refusals, an unreachable service): the stream's later
    // failures are the model's and reach the consumer.
    await stream.started(this.breakers.get(AI_GRPC_UPSTREAM));
    return stream;
  }

  private metadata(): Metadata {
    return createOutgoingMetadata(callerContextFromCls(this.cls));
  }

  private call<T>(
    method: string,
    invoke: (metadata: Metadata) => Observable<T>,
    timeoutMs = this.config.deadlineMs,
  ): Promise<T> {
    return grpcCall(invoke(this.metadata()), {
      timeoutMs,
      operation: operation(method),
      breaker: this.breakers.get(AI_GRPC_UPSTREAM),
    });
  }
}

const conversationRequest = (input: ConversationRequest) => ({
  tenantId: input.tenantId,
  userId: input.userId,
  conversationId: input.conversationId,
});

const sendRequest = (input: SendMessageRequest) => ({
  ...conversationRequest(input),
  content: input.content,
  model: input.model,
  idempotencyKey: input.idempotencyKey,
});

/**
 * One server-streamed call as an `AsyncIterable` of port events. It subscribes at once (the call
 * starts), buffers events until they are read, and maps a failure with `grpcErrorToDomainException`.
 * Unsubscribing (the signal aborts, the consumer stops reading) cancels the gRPC call.
 */
class GrpcEventStream implements AsyncIterable<ChatStreamEvent> {
  private readonly buffer: ChatStreamEvent[] = [];
  private failure: { error: unknown } | undefined;
  private ended = false;
  private isStarted = false;
  private closed = false;
  private waiter: (() => void) | undefined;
  /** Wakes a pending `started()` (started, aborted or failed). */
  private starting: (() => void) | undefined;
  private readonly subscription: Subscription;
  private readonly startedAt = performance.now();
  private recorded = false;

  constructor(
    source: Observable<StreamMessageEvent>,
    private readonly op: string,
    private readonly signal: AbortSignal | undefined,
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.subscription = source.subscribe({
      next: (event) => this.onEvent(event),
      error: (error: unknown) => this.fail(error, grpcClientCode(error)),
      complete: () => this.finish(),
    });
    if (this.closed) this.subscription.unsubscribe();
  }

  /**
   * Resolves on `started` (or on the caller's abort: the iterator then throws its reason); rejects,
   * mapped, when the call fails or ends before it. Run through the breaker, which sees the raw error.
   */
  async started(breaker: GrpcCircuitBreaker): Promise<void> {
    const opening = async (): Promise<void> => {
      if (!this.isStarted && !this.aborted() && this.failure === undefined) {
        await new Promise<void>((resolve) => {
          this.starting = resolve;
        });
      }
      // The raw error, so the breaker's filter can read its status and trailers.
      if (!this.isStarted && !this.aborted() && this.failure !== undefined) {
        throw this.failure.error;
      }
    };
    try {
      await breaker.fire(opening);
    } catch (error) {
      this.close();
      throw grpcErrorToDomainException(error, this.op);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatStreamEvent> {
    try {
      for (;;) {
        const event = this.buffer.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        if (this.failure !== undefined) throw this.mapped(this.failure.error);
        if (this.ended) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    } finally {
      // After the end there is nothing to cancel; otherwise (break, throw, abort) cancel the call.
      this.close();
    }
  }

  private readonly onAbort = (): void => {
    this.fail(this.signal?.reason, 'CANCELLED');
    this.close();
  };

  private aborted(): boolean {
    return this.signal?.aborted === true;
  }

  private mapped(error: unknown): unknown {
    // The caller's own abort reason stays as is (the edge knows the client left).
    if (this.aborted() && error === this.signal?.reason) return error;
    return grpcErrorToDomainException(error, this.op);
  }

  private onEvent(event: StreamMessageEvent): void {
    let mapped: ChatStreamEvent | 'started';
    try {
      mapped = fromStreamEventContract(event);
    } catch (error) {
      this.fail(error, 'UNKNOWN');
      this.close();
      return;
    }
    if (mapped === 'started') {
      this.isStarted = true;
      this.settleStarting();
      return;
    }
    this.buffer.push(mapped);
    this.wake();
  }

  private fail(error: unknown, code: string): void {
    if (this.failure !== undefined || this.ended) return;
    this.failure = { error };
    this.record(code);
    this.settleStarting();
    this.wake();
  }

  private finish(): void {
    if (this.failure !== undefined) return;
    if (!this.isStarted) {
      // A stream that ends without `started` breaks the contract (a 502 at the edge).
      this.fail(new Error('ai-service ended the stream before it started'), 'UNKNOWN');
      return;
    }
    this.ended = true;
    this.record('OK');
    this.wake();
  }

  /** Wakes a pending `started()`, which then reads the state (started, aborted or failed). */
  private settleStarting(): void {
    const starting = this.starting;
    this.starting = undefined;
    starting?.();
  }

  private record(code: string): void {
    if (this.recorded) return;
    this.recorded = true;
    const seconds = (performance.now() - this.startedAt) / 1_000;
    recordGrpcCall('client', parseGrpcOperation(this.op), code, seconds);
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    // Still undefined while the constructor subscribes; it unsubscribes right after.
    (this.subscription as Subscription | undefined)?.unsubscribe();
  }
}
