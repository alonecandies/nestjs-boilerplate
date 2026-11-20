import { type CursorPage, getPrincipal, type Principal } from '@platform/common';
import {
  decodeIdCursor,
  keysetFetchLimit,
  keysetPage,
  RlsContextError,
  RowCountMismatchError,
} from '@platform/database';
import { isNil } from 'lodash-es';
import type {
  ConversationsRepository,
  ListConversationsCriteria,
} from '../application/repositories/conversations.repository.js';
import type {
  AppendMessageResult,
  ListMessagesCriteria,
  MessagesRepository,
} from '../application/repositories/messages.repository.js';
import type { UsageRepository } from '../application/repositories/usage.repository.js';
import type { Conversation, Message, UsageRecord } from '../domain/ai.types.js';

/** The rows behind the twins, read freely by specs (past "RLS"), like the superuser in int specs. */
export interface InMemoryAiStore {
  /** By `${tenantId}/${id}`. */
  readonly conversations: Map<string, Conversation>;
  /** In insertion order. */
  readonly messages: Message[];
  /** In insertion order. */
  readonly usage: UsageRecord[];
}

export interface InMemoryAiPersistence {
  readonly store: InMemoryAiStore;
  readonly conversations: InMemoryConversationsRepository;
  readonly messages: InMemoryMessagesRepository;
  readonly usage: InMemoryUsageRepository;
}

/** Three twins over one store, so a conversation delete takes its messages along. */
export function createInMemoryAiPersistence(): InMemoryAiPersistence {
  const store: InMemoryAiStore = { conversations: new Map(), messages: [], usage: [] };
  return {
    store,
    conversations: new InMemoryConversationsRepository(store),
    messages: new InMemoryMessagesRepository(store),
    usage: new InMemoryUsageRepository(store),
  };
}

/*
 * The twins behave as the Drizzle repositories do under the 0000_init policies: without a principal
 * every call is refused (RLS_NO_PRINCIPAL); a row is visible only to its user in its tenant; an
 * insert for anyone else fails with the policy error (42501); a write to a hidden row matches none.
 */

const keyOf = (tenantId: string, id: string): string => `${tenantId}/${id}`;
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function requirePrincipal(): Principal {
  const principal = getPrincipal();
  if (principal === undefined) {
    throw new RlsContextError('RLS_NO_PRINCIPAL', 'No principal for the unit of work');
  }
  return principal;
}

/** The select / update / delete policies: the row's user in the row's tenant. */
function visibleTo(principal: Principal): (row: { tenantId: string; userId: string }) => boolean {
  return (row) => row.tenantId === principal.tenantId && row.userId === principal.userId;
}

/** The insert policies' WITH CHECK. */
function checkInsert(row: { tenantId: string; userId: string }): void {
  if (!visibleTo(requirePrincipal())(row)) {
    throw Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
  }
}

/** Newest first after the cursor, one look-ahead row, as the keyset helpers expect. */
function pageOf<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  cursor: string | null | undefined,
): CursorPage<T> {
  const after = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
  const page = rows
    .toSorted(byId)
    .toReversed()
    .filter((row) => after === undefined || row.id < after)
    .slice(0, keysetFetchLimit(limit));
  return keysetPage(page, limit);
}

export class InMemoryConversationsRepository implements ConversationsRepository {
  constructor(readonly store: InMemoryAiStore) {}

  async create(conversation: Conversation): Promise<void> {
    checkInsert(conversation);
    const key = keyOf(conversation.tenantId, conversation.id);
    if (this.store.conversations.has(key)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    }
    this.store.conversations.set(key, structuredClone(conversation));
  }

  async findById(tenantId: string, id: string): Promise<Conversation | null> {
    const row = this.visible(tenantId).find((c) => c.id === id);
    return row === undefined ? null : structuredClone(row);
  }

  async list(criteria: ListConversationsCriteria): Promise<CursorPage<Conversation>> {
    const rows = this.visible(criteria.tenantId).filter((c) => c.userId === criteria.userId);
    return pageOf(
      rows.map((c) => structuredClone(c)),
      criteria.limit,
      criteria.cursor,
    );
  }

  async touch(tenantId: string, id: string, updatedAt: Date): Promise<void> {
    const row = this.visible(tenantId).find((c) => c.id === id);
    if (row === undefined) throw new RowCountMismatchError(1, 0, 'conversations.touch');
    this.store.conversations.set(keyOf(tenantId, id), { ...row, updatedAt: new Date(updatedAt) });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const row = this.visible(tenantId).find((c) => c.id === id);
    if (row === undefined) return false;
    this.store.conversations.delete(keyOf(tenantId, id));
    const visible = visibleTo(requirePrincipal());
    const remaining = this.store.messages.filter(
      (m) => !(m.tenantId === tenantId && m.conversationId === id && visible(m)),
    );
    this.store.messages.splice(0, this.store.messages.length, ...remaining);
    return true;
  }

  private visible(tenantId: string): Conversation[] {
    const visible = visibleTo(requirePrincipal());
    return [...this.store.conversations.values()].filter(
      (c) => c.tenantId === tenantId && visible(c),
    );
  }
}

export class InMemoryMessagesRepository implements MessagesRepository {
  constructor(readonly store: InMemoryAiStore) {}

  async append(message: Message): Promise<AppendMessageResult> {
    checkInsert(message);
    if (message.idempotencyKey !== null) {
      // The unique index sees every row, visible or not; then the lookup runs under the policy.
      const clash = this.store.messages.find(
        (m) =>
          m.tenantId === message.tenantId &&
          m.conversationId === message.conversationId &&
          m.idempotencyKey === message.idempotencyKey,
      );
      if (clash !== undefined) {
        const stored = await this.findByIdempotencyKey(
          message.tenantId,
          message.conversationId,
          message.idempotencyKey,
        );
        if (stored === null) throw new Error(`Message ${message.id} conflicts with a hidden row`);
        return { message: stored, created: false };
      }
    }
    this.store.messages.push(structuredClone(message));
    return { message: structuredClone(message), created: true };
  }

  async findByIdempotencyKey(
    tenantId: string,
    conversationId: string,
    idempotencyKey: string,
  ): Promise<Message | null> {
    const row = this.visible(tenantId, conversationId).find(
      (m) => m.idempotencyKey === idempotencyKey,
    );
    return row === undefined ? null : structuredClone(row);
  }

  async listRecent(tenantId: string, conversationId: string, limit: number): Promise<Message[]> {
    const rows = this.visible(tenantId, conversationId).toSorted(byId);
    return (limit > 0 ? rows.slice(-limit) : []).map((m) => structuredClone(m));
  }

  async list(criteria: ListMessagesCriteria): Promise<CursorPage<Message>> {
    const rows = this.visible(criteria.tenantId, criteria.conversationId);
    return pageOf(
      rows.map((m) => structuredClone(m)),
      criteria.limit,
      criteria.cursor,
    );
  }

  private visible(tenantId: string, conversationId: string): Message[] {
    const visible = visibleTo(requirePrincipal());
    return this.store.messages.filter(
      (m) => m.tenantId === tenantId && m.conversationId === conversationId && visible(m),
    );
  }
}

export class InMemoryUsageRepository implements UsageRepository {
  constructor(readonly store: InMemoryAiStore) {}

  async record(entry: UsageRecord): Promise<void> {
    checkInsert(entry);
    this.store.usage.push(structuredClone(entry));
  }
}
