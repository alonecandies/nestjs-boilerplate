import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AiCallInput,
  AiClient,
  AiDisabledError,
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
} from '../../domain/ai.errors.js';
import type { Conversation, Message, UsageOutcome, UsageRecord } from '../../domain/ai.types.js';
import { historyWindow } from '../history-window.js';
import type { SendMessageRequest } from '../ports/ai.port.js';
import { ConversationsRepository } from '../repositories/conversations.repository.js';
import { MessagesRepository } from '../repositories/messages.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';

export type ModelMessage = AiCallInput['messages'][number];

/** What the read before the call found. */
export type Prepared =
  | { readonly kind: 'replay'; readonly message: Message }
  | { readonly kind: 'call'; readonly conversation: Conversation; readonly history: Message[] };

/** What the write after the call did. */
export type Stored =
  | { readonly kind: 'stored'; readonly message: Message }
  /** A concurrent request with the same key stored its reply first. */
  | { readonly kind: 'replay'; readonly message: Message }
  /** The conversation was deleted (or is no longer the caller's) during the call. */
  | { readonly kind: 'gone' };

/** Errors `AiClient` throws before any model call: nothing was spent, so no usage row. */
const REFUSED_BEFORE_CALL = [AiDisabledError, AiModelNotAllowedError, AiInputTooLargeError];

export const toModelMessage = (message: Message): ModelMessage =>
  ({ role: message.role, content: message.content }) as unknown as ModelMessage;

/**
 * The unit-of-work steps one chat turn shares, streamed or not (`SendMessageHandler`,
 * `StreamMessageHandler`):
 *
 * 1. `prepare`, as the caller: the conversation (404 when it is not the caller's), a stored reply
 *    for the `Idempotency-Key` (same request hash → a replay, another → 409), and the history.
 * 2. The model call, with no transaction open (the subclass).
 * 3. `store`, as the caller: the conversation again (the messages policy is row-local, so ownership
 *    is checked here, not by the database), the assistant reply with the key and request hash first
 *    (the unique key decides a concurrent replay), the user message, the usage row and the
 *    conversation's `updatedAt`.
 *
 * A call that failed before any reply stores no message and records a usage row with the failure
 * outcome (`recordFailure`); a call refused by a guard (disabled, model, input size) records nothing.
 */
@Injectable()
export abstract class ChatTurnHandler {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly conversations: ConversationsRepository,
    protected readonly messages: MessagesRepository,
    protected readonly usage: UsageRepository,
    protected readonly ai: AiClient,
    @Inject(aiConfig.KEY) protected readonly config: AiConfig,
  ) {}

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

  /** The history window (count, then approximate token budget) followed by the new message. */
  protected promptOf(history: readonly Message[], userMessage: Message): ModelMessage[] {
    const window = historyWindow(history, {
      maxMessages: this.config.historyMaxMessages,
      maxTokens: this.config.historyMaxTokens,
    });
    return [...window.map(toModelMessage), toModelMessage(userMessage)];
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
  protected async recordFailure(
    request: SendMessageRequest,
    model: string,
    error: unknown,
    latencyMs: number,
    outcome: UsageOutcome = error instanceof AiTimeoutError ? 'timeout' : 'error',
  ): Promise<void> {
    if (REFUSED_BEFORE_CALL.some((type) => error instanceof type)) return;
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

  protected newMessage(
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
export function matchReplay(stored: Message, requestHash: string): Message {
  if (stored.requestHash !== requestHash) throw new ChatIdempotencyKeyReusedException();
  return stored;
}
