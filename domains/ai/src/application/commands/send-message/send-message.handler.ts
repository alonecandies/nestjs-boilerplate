import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  type AiCallInput,
  AiClient,
  AiDisabledError,
  type AiGenerateResult,
  AiInputTooLargeError,
  AiModelNotAllowedError,
  AiTimeoutError,
} from '@platform/ai';
import { generateId } from '@platform/common';
import { type AiConfig, aiConfig } from '@platform/config';
import { Transactional } from '@platform/database';
import {
  ChatIdempotencyKeyReusedException,
  ConversationNotFoundException,
} from '../../../domain/ai.errors.js';
import type { Conversation, Message, UsageOutcome, UsageRecord } from '../../../domain/ai.types.js';
import { chatRequestHash } from '../../../domain/chat-request-hash.js';
import { requireCaller } from '../../caller-scope.js';
import { historyWindow } from '../../history-window.js';
import type { SendMessageRequest, SendMessageResult } from '../../ports/ai.port.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { MessagesRepository } from '../../repositories/messages.repository.js';
import { UsageRepository } from '../../repositories/usage.repository.js';
import { SendMessageCommand } from './send-message.command.js';

type ModelMessage = AiCallInput['messages'][number];

/** What the read before the call found. */
type Prepared =
  | { readonly kind: 'replay'; readonly message: Message }
  | { readonly kind: 'call'; readonly conversation: Conversation; readonly history: Message[] };

/** What the write after the call did. */
type Stored =
  | { readonly kind: 'stored'; readonly message: Message }
  /** A concurrent request with the same key stored its reply first. */
  | { readonly kind: 'replay'; readonly message: Message }
  /** The conversation was deleted (or is no longer the caller's) during the call. */
  | { readonly kind: 'gone' };

/** Errors `AiClient` throws before any model call: nothing was spent, so no usage row. */
const REFUSED_BEFORE_CALL = [AiDisabledError, AiModelNotAllowedError, AiInputTooLargeError];

const toModelMessage = (message: Message): ModelMessage =>
  ({ role: message.role, content: message.content }) as unknown as ModelMessage;

/**
 * One chat turn, non-streaming:
 *
 * 1. Read, in one unit of work as the caller: the conversation (404 when it is not the caller's),
 *    a stored reply for the `Idempotency-Key` (same request hash → returned without a call,
 *    another → 409), and the history (`AI_HISTORY_MAX_MESSAGES` newest).
 * 2. Call the model with the history window (count and approximate token budget) then the new user
 *    message. No transaction is open during the call.
 * 3. Write, in one unit of work as the caller: the conversation again (the messages policy is
 *    row-local, so ownership is checked here, not by the database), the assistant reply with the
 *    key and request hash first (the unique key decides a concurrent replay), the user message,
 *    the usage row and the conversation's `updatedAt`.
 *
 * A failed call stores no message and records a usage row with the failure outcome (`error`,
 * `timeout`); a call refused by a guard (disabled, model, input size) records nothing. Logs carry
 * ids, model and token counts only, never message text.
 */
@CommandHandler(SendMessageCommand)
export class SendMessageHandler implements ICommandHandler<SendMessageCommand> {
  private readonly logger = new Logger(SendMessageHandler.name);

  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
    private readonly usage: UsageRepository,
    private readonly ai: AiClient,
    @Inject(aiConfig.KEY) private readonly config: AiConfig,
  ) {}

  async execute({ request }: SendMessageCommand): Promise<SendMessageResult> {
    requireCaller(request);
    if (!this.config.enabled) throw new AiDisabledError();
    const requestHash = chatRequestHash(request);

    const prepared = await this.prepare(request, requestHash);
    if (prepared.kind === 'replay') return { message: prepared.message, replayed: true };

    const model = request.model ?? prepared.conversation.model;
    const userMessage = this.newMessage(request, { role: 'user', content: request.content });
    const window = historyWindow(prepared.history, {
      maxMessages: this.config.historyMaxMessages,
      maxTokens: this.config.historyMaxTokens,
    });
    const startedAt = performance.now();
    let result: AiGenerateResult;
    try {
      result = await this.ai.generate({
        model,
        messages: [...window.map(toModelMessage), toModelMessage(userMessage)],
      });
    } catch (error) {
      await this.recordFailure(request, model, error, Math.round(performance.now() - startedAt));
      throw error;
    }

    const reply = this.newMessage(request, {
      role: 'assistant',
      content: result.text,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      idempotencyKey: request.idempotencyKey ?? null,
      requestHash: request.idempotencyKey === undefined ? null : requestHash,
    });
    const usage: UsageRecord = {
      tenantId: request.tenantId,
      id: generateId(),
      userId: request.userId,
      conversationId: request.conversationId,
      messageId: reply.id,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd ?? null,
      latencyMs: result.latencyMs,
      outcome: 'success',
      createdAt: reply.createdAt,
    };
    const stored = await this.store(userMessage, reply, usage);
    this.logger.debug(
      `AI chat turn conversation=${request.conversationId} message=${reply.id} model=${result.model} ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} stored=${stored.kind}`,
    );
    switch (stored.kind) {
      case 'gone':
        throw new ConversationNotFoundException(request.conversationId);
      case 'replay':
        return { message: matchReplay(stored.message, requestHash), replayed: true };
      default:
        return { message: stored.message, replayed: false };
    }
  }

  @Transactional()
  protected async prepare(request: SendMessageRequest, requestHash: string): Promise<Prepared> {
    const { tenantId, conversationId } = request;
    const conversation = await this.conversations.findById(tenantId, conversationId);
    if (conversation === null) throw new ConversationNotFoundException(conversationId);
    if (request.idempotencyKey !== undefined) {
      const stored = await this.messages.findByIdempotencyKey(
        tenantId,
        conversationId,
        request.idempotencyKey,
      );
      if (stored !== null) return { kind: 'replay', message: matchReplay(stored, requestHash) };
    }
    const history = await this.messages.listRecent(
      tenantId,
      conversationId,
      this.config.historyMaxMessages,
    );
    return { kind: 'call', conversation, history };
  }

  @Transactional()
  protected async store(userMessage: Message, reply: Message, usage: UsageRecord): Promise<Stored> {
    const { tenantId, conversationId } = reply;
    // As the caller, in this unit of work: the row-local messages policy cannot check who owns
    // the conversation a message names, so the conversation must be the caller's here.
    const conversation = await this.conversations.findById(tenantId, conversationId);
    if (conversation === null) {
      await this.usage.record({ ...usage, messageId: null });
      return { kind: 'gone' };
    }
    const appended = await this.messages.append(reply);
    if (!appended.created) {
      // The tokens were spent all the same; the reply that counts is the stored one.
      await this.usage.record({ ...usage, messageId: null });
      return { kind: 'replay', message: appended.message };
    }
    await this.messages.append(userMessage);
    await this.usage.record(usage);
    await this.conversations.touch(tenantId, conversationId, reply.createdAt);
    return { kind: 'stored', message: appended.message };
  }

  /** Best effort: the model error is what the caller must see, not a database error. */
  private async recordFailure(
    request: SendMessageRequest,
    model: string,
    error: unknown,
    latencyMs: number,
  ): Promise<void> {
    if (REFUSED_BEFORE_CALL.some((type) => error instanceof type)) return;
    const outcome: UsageOutcome = error instanceof AiTimeoutError ? 'timeout' : 'error';
    try {
      await this.usage.record({
        tenantId: request.tenantId,
        id: generateId(),
        userId: request.userId,
        conversationId: request.conversationId,
        messageId: null,
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        latencyMs,
        outcome,
        createdAt: new Date(),
      });
    } catch (recordError) {
      this.logger.warn(
        `Could not record the failed AI call of conversation ${request.conversationId}: ` +
          (recordError instanceof Error ? recordError.name : typeof recordError),
      );
    }
  }

  private newMessage(
    request: SendMessageRequest,
    fields: Pick<Message, 'role' | 'content'> & Partial<Message>,
  ): Message {
    return {
      tenantId: request.tenantId,
      id: generateId(),
      conversationId: request.conversationId,
      userId: request.userId,
      status: 'complete',
      model: null,
      inputTokens: null,
      outputTokens: null,
      idempotencyKey: null,
      requestHash: null,
      createdAt: new Date(),
      ...fields,
    };
  }
}

/** The stored reply when it answered the same request; a reused key is a 409. */
function matchReplay(stored: Message, requestHash: string): Message {
  if (stored.requestHash !== requestHash) throw new ChatIdempotencyKeyReusedException();
  return stored;
}
