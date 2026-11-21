import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AiCallInput,
  AiClient,
  AiDisabledError,
  AiInputTooLargeError,
  AiModelNotAllowedError,
  type AiSdkGenerateResult,
  AiTimeoutError,
  aiInputChars,
  aiUsageOf,
} from '@platform/ai';
import { generateId, type Principal } from '@platform/common';
import { type AiConfig, aiConfig } from '@platform/config';
import { Transactional } from '@platform/database';
import {
  ChatIdempotencyKeyReusedException,
  ConversationNotFoundException,
} from '../../domain/ai.errors.js';
import type {
  Conversation,
  Message,
  MessageContent,
  UsageOutcome,
  UsageRecord,
} from '../../domain/ai.types.js';
import { historyWindow, toModelMessage, withoutRetriedCuts } from '../history-window.js';
import type { SendMessageRequest } from '../ports/ai.port.js';
import { ConversationsRepository } from '../repositories/conversations.repository.js';
import { MessagesRepository } from '../repositories/messages.repository.js';
import { UsageRepository } from '../repositories/usage.repository.js';
import { AiChatTools, type AiToolCallOptions } from '../tools/ai-chat-tools.js';

/** The prompt part of a chat turn's `AiClient` call: the messages, the tools, their instructions. */
export type ChatPrompt = Pick<AiCallInput, 'messages' | 'system' | 'tools'>;
/** What a call added to the conversation: assistant messages and tool results, step by step. */
export type ResponseMessage = AiSdkGenerateResult['responseMessages'][number];

/** What the read before the call found. */
export type Prepared =
  | { readonly kind: 'replay'; readonly message: Message }
  | { readonly kind: 'call'; readonly conversation: Conversation; readonly history: Message[] };

/** What the write after the call did. */
export type Stored =
  | { readonly kind: 'stored'; readonly message: Message }
  /** A concurrent request with the same key stored its reply first. */
  | { readonly kind: 'replay'; readonly message: Message }
  /**
   * The conversation was deleted (or is no longer the caller's) during the call: only the usage
   * row was stored (`messageId` null), and the unit of work committed it.
   */
  | { readonly kind: 'gone' };

/** Errors `AiClient` throws before any model call: nothing was spent, so no usage row. */
const REFUSED_BEFORE_CALL = [AiDisabledError, AiModelNotAllowedError, AiInputTooLargeError];

/** An assistant message that calls no tool: the turn's answer (stored as the reply). */
const isAnswer = (message: ResponseMessage): boolean =>
  message.role === 'assistant' &&
  (typeof message.content === 'string' ||
    !message.content.some((part) => part.type === 'tool-call'));

/** SDK message content as stored in the `jsonb` column (plain JSON: no `undefined` fields). */
const toMessageContent = (content: ResponseMessage['content']): MessageContent =>
  typeof content === 'string' ? content : (JSON.parse(JSON.stringify(content)) as MessageContent);

/**
 * The unit-of-work steps one chat turn shares, streamed or not (`SendMessageHandler`,
 * `StreamMessageHandler`):
 *
 * 1. `prepare`, as the caller: the conversation (404 when it is not the caller's), a stored reply
 *    for the `Idempotency-Key` (same request hash → a replay, another → 409), and the history.
 * 2. The model call with `promptOf` (the history window sized to `AI_MAX_INPUT_CHARS`), with no
 *    transaction open (the subclass).
 * 3. `store`, as the caller: the conversation again, locked first (`findByIdForUpdate`; the
 *    messages policy is row-local, so ownership is checked here, not by the database), the
 *    assistant reply with the key and request hash first (the unique key decides a concurrent
 *    replay), the user message, the usage row and the conversation's `updatedAt`. The lock makes a
 *    concurrent delete wait for this unit of work, which then deletes the new messages too; a
 *    conversation deleted before it (`gone`) gets the usage row only, committed, and a 404.
 *
 * A call that failed before any reply stores no message and records a usage row with the failure
 * outcome and what its completed model calls were billed (`recordFailure`, `aiUsageOf`); a call
 * refused by a guard (disabled, model, input size) records nothing.
 *
 * Tools (`AiChatTools`, when the app binds `AiToolSources`): the call is offered the read-only
 * tools bound to the caller (`toolOptions`, in `promptOf`), and the tool calls and results of its
 * steps are stored as messages between the user message and the reply (`stepMessages`). The last
 * of its `AI_MAX_TOOL_STEPS` steps may not call a tool (`AiClient`), so the reply is an answer in
 * text even when the model called tools on every step before it.
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
    /** Always bound by `AiCoreModule`; optional so a spec can build a handler without tools. */
    protected readonly tools?: AiChatTools,
  ) {}

  /** The tools and their instructions for the caller's call; none when no sources are bound. */
  protected toolOptions(caller: Principal): AiToolCallOptions | Record<string, never> {
    return this.tools?.forCaller(caller) ?? {};
  }

  /**
   * The intermediate messages of a call (assistant tool calls, tool results), in order, as rows of
   * the conversation: every response message but a final answer, which is stored as the reply.
   * Created after the user message and before the reply, so the uuidv7 ids keep that order.
   */
  protected stepMessages(
    request: SendMessageRequest,
    model: string,
    response: readonly ResponseMessage[],
  ): Message[] {
    const last = response.at(-1);
    const steps = last !== undefined && isAnswer(last) ? response.slice(0, -1) : response;
    return steps.map((message) =>
      this.newMessage(request, {
        role: message.role,
        content: toMessageContent(message.content),
        model: message.role === 'assistant' ? model : null,
      }),
    );
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

  /**
   * The prompt of the caller's call: the tools and their instructions (`toolOptions`), the history
   * window, then the new message. Besides its count and token limits, the window holds only what
   * `AI_MAX_INPUT_CHARS` leaves once the new message and the instructions are counted, measured as
   * the client's guard measures (`aiInputChars`): a long conversation drops its oldest messages
   * instead of being refused, and a new message too large on its own leaves no history and gets
   * the guard's 422 `AI_INPUT_TOO_LARGE`. A cut exchange that was asked again (a retry after a
   * stream cut short) is left out before the window is measured (`withoutRetriedCuts`).
   */
  protected promptOf(
    caller: Principal,
    history: readonly Message[],
    userMessage: Message,
  ): ChatPrompt {
    const tools = this.toolOptions(caller);
    const message = toModelMessage(userMessage);
    const window = historyWindow(withoutRetriedCuts(history, userMessage), {
      maxMessages: this.config.historyMaxMessages,
      maxTokens: this.config.historyMaxTokens,
      maxChars: this.config.maxInputChars - aiInputChars([message], tools.system),
    });
    return { ...tools, messages: [...window.map(toModelMessage), message] };
  }

  @Transactional()
  protected async store(
    userMessage: Message,
    reply: Message,
    usage: UsageRecord,
    steps: readonly Message[] = [],
  ): Promise<Stored> {
    const { tenantId, conversationId } = reply;
    // As the caller, in this unit of work: the row-local messages policy cannot check who owns
    // the conversation a message names, so the conversation must be the caller's here. Locked
    // (FOR UPDATE) until the unit ends, first: a delete that comes now waits for the commit, so
    // `touch` cannot miss the row and roll the usage row back with the reply.
    const conversation = await this.conversations.findByIdForUpdate(tenantId, conversationId);
    if (conversation === null) {
      // Deleted first (or while the lock was awaited): the tokens were spent all the same. This
      // returns, so the unit of work commits the usage row; the turn then answers 404.
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
    for (const step of steps) await this.messages.append(step);
    await this.usage.record(usage);
    await this.conversations.touch(tenantId, conversationId, reply.createdAt);
    return { kind: 'stored', message: appended.message };
  }

  /**
   * Best effort: the model error is what the caller must see, not a database error. The row holds
   * what the model calls that ended before the failure were billed (`aiUsageOf`): a failed tool
   * loop still paid for its steps. None ended: 0 tokens, cost unknown.
   */
  protected async recordFailure(
    request: SendMessageRequest,
    model: string,
    error: unknown,
    latencyMs: number,
    outcome: UsageOutcome = error instanceof AiTimeoutError ? 'timeout' : 'error',
  ): Promise<void> {
    if (REFUSED_BEFORE_CALL.some((type) => error instanceof type)) return;
    const billed = aiUsageOf(error);
    try {
      await this.usage.record({
        tenantId: request.tenantId,
        id: generateId(),
        userId: request.userId,
        conversationId: request.conversationId,
        messageId: null,
        model,
        inputTokens: billed?.inputTokens ?? 0,
        outputTokens: billed?.outputTokens ?? 0,
        costUsd: billed?.costUsd ?? null,
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
