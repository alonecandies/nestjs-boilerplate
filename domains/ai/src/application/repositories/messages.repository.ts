import type { CursorPage } from '@platform/common';
import type { Message } from '../../domain/ai.types.js';

export interface AppendMessageResult {
  readonly message: Message;
  /** `false` when the conversation already had a message with this `idempotencyKey`: `message` is the stored one. */
  readonly created: boolean;
}

export interface ListMessagesCriteria {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly limit: number;
  /** Opaque keyset cursor (`nextCursor` of the previous page); absent = first page. */
  readonly cursor?: string | null | undefined;
}

/**
 * Message persistence (implemented by `DrizzleMessagesRepository`, under RLS, with the same unit
 * of work rules as `ConversationsRepository`). Messages are written once and never changed; they
 * go with their conversation (`ConversationsRepository.delete`).
 */
export abstract class MessagesRepository {
  /**
   * Inserts a message. When `idempotencyKey` is set and the conversation already has a message
   * with that key, nothing is inserted and the stored message is returned (`created: false`); the
   * caller compares `requestHash` to tell a replay from a reused key.
   */
  abstract append(message: Message): Promise<AppendMessageResult>;

  /** The conversation's message with this `Idempotency-Key`, or `null`. */
  abstract findByIdempotencyKey(
    tenantId: string,
    conversationId: string,
    idempotencyKey: string,
  ): Promise<Message | null>;

  /** The history window: the conversation's `limit` newest messages, oldest first. */
  abstract listRecent(tenantId: string, conversationId: string, limit: number): Promise<Message[]>;

  /**
   * One page of the conversation, newest first (uuidv7 order), resuming after `cursor`.
   * @throws DomainValidationException (`INVALID_CURSOR`) a cursor this API did not issue
   */
  abstract list(criteria: ListMessagesCriteria): Promise<CursorPage<Message>>;
}
