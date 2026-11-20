import type { CursorPage } from '@platform/common';
import type { Conversation } from '../../domain/ai.types.js';

export interface ListConversationsCriteria {
  /** Always set: listings never cross a tenant (sharding design §2.1.5). */
  readonly tenantId: string;
  /** The owner: the policies return no one else's conversation anyway. */
  readonly userId: string;
  readonly limit: number;
  /** Opaque keyset cursor (`nextCursor` of the previous page); absent = first page. */
  readonly cursor?: string | null | undefined;
}

/**
 * Conversation persistence (implemented by `DrizzleConversationsRepository`, under RLS). Each
 * method joins the open unit of work when there is one, and otherwise opens its own; either way it
 * runs as the CLS principal, and without one it is refused (`RLS_NO_PRINCIPAL`). A conversation
 * of another user or tenant is invisible: reads return nothing, writes match no row, and an insert
 * for someone else fails with the policy error (42501).
 */
export abstract class ConversationsRepository {
  /** Inserts a new conversation for the principal. */
  abstract create(conversation: Conversation): Promise<void>;

  /** Within `tenantId`: another user's or tenant's conversation is `null`. */
  abstract findById(tenantId: string, id: string): Promise<Conversation | null>;

  /**
   * One page of the user's conversations, newest first (uuidv7 order), resuming after `cursor`.
   * @throws DomainValidationException (`INVALID_CURSOR`) a cursor this API did not issue
   */
  abstract list(criteria: ListConversationsCriteria): Promise<CursorPage<Conversation>>;

  /**
   * Sets `updatedAt` (the thread's last activity).
   * @throws RowCountMismatchError the conversation does not exist or is not the caller's
   */
  abstract touch(tenantId: string, id: string, updatedAt: Date): Promise<void>;

  /**
   * Deletes the conversation and all its messages in one unit of work; its usage rows stay.
   * `false` when there was no such conversation of the caller's (nothing deleted).
   */
  abstract delete(tenantId: string, id: string): Promise<boolean>;
}
