import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
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
  AppendMessageResult,
  ListMessagesCriteria,
  MessagesRepository,
} from '../../application/repositories/messages.repository.js';
import type { Message } from '../../domain/ai.types.js';
import { type AiSchema, messages } from './ai.schema.js';

const ofConversation = (tenantId: string, conversationId: string) =>
  and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId));

/**
 * Messages on the runtime pool under RLS, through `inUnitOfWork` like the conversations. Every
 * query carries `tenant_id` and `conversation_id` (messages_tenant_id_conversation_id_id_idx).
 */
@Injectable()
export class DrizzleMessagesRepository implements MessagesRepository {
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<AiSchema>>) {}

  append(message: Message): Promise<AppendMessageResult> {
    return inUnitOfWork(this.txHost, async (tx) => {
      // The unique (tenant_id, conversation_id, idempotency_key) index turns a replayed key into
      // a no-op; NULL keys never collide.
      const [inserted] = await tx
        .insert(messages)
        .values({ ...message })
        .onConflictDoNothing({
          target: [messages.tenantId, messages.conversationId, messages.idempotencyKey],
        })
        .returning();
      if (inserted !== undefined) return { message: inserted, created: true };

      const key = message.idempotencyKey;
      if (key === null) {
        throw new Error(
          `Message ${message.id} was not inserted although it has no idempotency key`,
        );
      }
      const [existing] = await tx
        .select()
        .from(messages)
        .where(
          and(
            ofConversation(message.tenantId, message.conversationId),
            eq(messages.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        // The conflicting row is hidden from the caller (another user's), or was deleted since.
        throw new Error(`Message ${message.id} conflicts with a row the caller cannot read`);
      }
      return { message: existing, created: false };
    });
  }

  findByIdempotencyKey(
    tenantId: string,
    conversationId: string,
    idempotencyKey: string,
  ): Promise<Message | null> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(
          and(
            ofConversation(tenantId, conversationId),
            eq(messages.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  async listRecent(tenantId: string, conversationId: string, limit: number): Promise<Message[]> {
    const newestFirst = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(messages)
        .where(ofConversation(tenantId, conversationId))
        .orderBy(keysetOrder(messages.id))
        .limit(Math.max(limit, 0)),
    );
    return newestFirst.toReversed();
  }

  async list(criteria: ListMessagesCriteria): Promise<CursorPage<Message>> {
    const { tenantId, conversationId, cursor } = criteria;
    const cursorId = isNil(cursor) || cursor === '' ? undefined : decodeIdCursor(cursor).id;
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(messages)
        .where(
          and(
            ofConversation(tenantId, conversationId),
            cursorId === undefined ? undefined : lt(messages.id, cursorId),
          ),
        )
        .orderBy(keysetOrder(messages.id))
        .limit(keysetFetchLimit(criteria.limit)),
    );
    return keysetPage(rows, criteria.limit);
  }
}
