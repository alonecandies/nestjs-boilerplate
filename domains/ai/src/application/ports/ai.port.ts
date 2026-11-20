import type { CursorPage } from '@platform/common';
import type { Conversation, Message } from '../../domain/ai.types.js';
import type { AiCaller } from '../caller-scope.js';

export type { AiCaller } from '../caller-scope.js';

export interface CreateConversationRequest extends AiCaller {
  readonly title?: string | undefined;
  /** Default `AI_DEFAULT_MODEL`; must be allowed (else 422 `AI_MODEL_NOT_ALLOWED`). */
  readonly model?: string | undefined;
}

export interface ListConversationsRequest extends AiCaller {
  /** Default 20, at most 100. */
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ConversationRequest extends AiCaller {
  readonly conversationId: string;
}

export interface ListMessagesRequest extends ConversationRequest {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface SendMessageRequest extends ConversationRequest {
  readonly content: string;
  /** Default: the conversation's model; must be allowed (else 422). */
  readonly model?: string | undefined;
  /** Replays with the same key and body return the stored reply; another body is a 409. */
  readonly idempotencyKey?: string | undefined;
}

export interface SendMessageResult {
  /** The assistant's reply. */
  readonly message: Message;
  /** `true` when an `Idempotency-Key` replay returned the stored reply (no model call). */
  readonly replayed: boolean;
}

/**
 * The chat API as presentation code sees it (REST now; GraphQL and gRPC later). Bound to
 * `AiLocalAdapter` (CQRS buses) by `AiApiModule.forLocal()`. Every request carries the caller's
 * tenant and user from the verified token; the handlers re-check them against the principal.
 */
export abstract class AiPort {
  abstract createConversation(input: CreateConversationRequest): Promise<Conversation>;

  /** The caller's conversations, newest first; pass `nextCursor` back as `cursor`. */
  abstract listConversations(input: ListConversationsRequest): Promise<CursorPage<Conversation>>;

  /** @throws ConversationNotFoundException (404) */
  abstract getConversation(input: ConversationRequest): Promise<Conversation>;

  /** Deletes the conversation and its messages (usage rows stay). @throws ConversationNotFoundException */
  abstract deleteConversation(input: ConversationRequest): Promise<void>;

  /** One page of the conversation's messages, newest first. @throws ConversationNotFoundException */
  abstract listMessages(input: ListMessagesRequest): Promise<CursorPage<Message>>;

  /** Sends the user's message with the history window and stores the reply. */
  abstract sendMessage(input: SendMessageRequest): Promise<SendMessageResult>;
}
