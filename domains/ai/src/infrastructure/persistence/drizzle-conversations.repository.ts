import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  assertRowsAffected,
  type DrizzleTransactionalAdapter,
  decodeIdCursor,
  inUnitOfWork,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  TransactionHost,
} from '@platform/database';
import { and, eq, lt } from 'drizzle-orm';
import { isNil } from 'lodash-es';
import type {
  ConversationsRepository,
  ListConversationsCriteria,
} from '../../application/repositories/conversations.repository.js';
import type { Conversation } from '../../domain/ai.types.js';
import { type AiSchema, conversations, messages } from './ai.schema.js';

const ofTenant = (tenantId: string, id: string) =>
  and(eq(conversations.tenantId, tenantId), eq(conversations.id, id));

/**
 * Conversations on the runtime pool under RLS. Every method runs through `inUnitOfWork`: it joins
 * the open unit of work, or opens its own with the principal's RLS context. Every query carries
 * `tenant_id` (a router query to one shard on Citus); the policies add the owner.
 */
@Injectable()
export class DrizzleConversationsRepository implements ConversationsRepository {
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<AiSchema>>) {}

  async create(conversation: Conversation): Promise<void> {
    const result = await inUnitOfWork(this.txHost, (tx) =>
      tx.insert(conversations).values({ ...conversation }),
    );
    assertRowsAffected(result, 1, 'conversations.create');
  }

  findById(tenantId: string, id: string): Promise<Conversation | null> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const [row] = await tx.select().from(conversations).where(ofTenant(tenantId, id)).limit(1);
      return row ?? null;
    });
  }

  findByIdForUpdate(tenantId: string, id: string): Promise<Conversation | null> {
    return inUnitOfWork(this.txHost, async (tx) => {
      // tenant_id equality: FOR UPDATE needs the distribution column on Citus (sharding §2.1.6).
      // The lock also needs app_runtime's UPDATE grant and conversations_update's USING (owner).
      const [row] = await tx
        .select()
        .from(conversations)
        .where(ofTenant(tenantId, id))
        .limit(1)
        .for('update');
      return row ?? null;
    });
  }

  async list(criteria: ListConversationsCriteria): Promise<CursorPage<Conversation>> {
    // Decoded (and validated: a forged cursor is a 422, never SQL) before the unit of work opens.
    const { tenantId, userId, cursor } = criteria;
    const cursorId = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, userId),
            cursorId === undefined ? undefined : lt(conversations.id, cursorId),
          ),
        )
        .orderBy(keysetOrder(conversations.id))
        .limit(keysetFetchLimit(criteria.limit)),
    );
    return keysetPage(rows, criteria.limit);
  }

  async touch(tenantId: string, id: string, updatedAt: Date): Promise<void> {
    // A conversation the policies hide matches no row: the count check turns that into an error.
    const result = await inUnitOfWork(this.txHost, (tx) =>
      tx.update(conversations).set({ updatedAt }).where(ofTenant(tenantId, id)),
    );
    assertRowsAffected(result, 1, 'conversations.touch');
  }

  delete(tenantId: string, id: string): Promise<boolean> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const deleted = await tx
        .delete(conversations)
        .where(ofTenant(tenantId, id))
        .returning({ id: conversations.id });
      if (deleted.length === 0) return false;
      // Same tenant, so the same shard: one router statement, in the same transaction.
      await tx
        .delete(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, id)));
      return true;
    });
  }
}
