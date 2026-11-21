import { createPrincipal, generateId, type Principal, runWithPrincipal } from '@platform/common';
import { RowCountMismatchError } from '@platform/database';
import { describe, expect, it } from 'vitest';
import type { ConversationsRepository } from '../application/repositories/conversations.repository.js';
import type { MessagesRepository } from '../application/repositories/messages.repository.js';
import type { UsageRepository } from '../application/repositories/usage.repository.js';
import type { Conversation, Message, UsageRecord } from '../domain/ai.types.js';
import { makeConversation, makeMessage, makeUsage } from './ai-fixtures.js';

export interface AiRepositoriesUnderTest {
  readonly conversations: ConversationsRepository;
  readonly messages: MessagesRepository;
  readonly usage: UsageRepository;
  /** Every usage row of `tenantId`, oldest first, read past RLS (the superuser, or the store). */
  readonly usageRowsOf: (tenantId: string) => Promise<UsageRecord[]>;
}

/** The SQLSTATE or error code a call fails with (drizzle wraps the driver error as `cause`). */
async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no error';
  } catch (error) {
    const { cause, code } = error as { cause?: { code?: string }; code?: string };
    return cause?.code ?? code ?? String(error);
  }
}

const byIdDesc = <T extends { id: string }>(rows: readonly T[]): T[] =>
  rows.toSorted((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/**
 * The behaviour every implementation of the three ai repositories shares, RLS included: run by the
 * in-memory twins' unit spec and by the Drizzle repositories' int spec on Citus. Each case uses
 * fresh tenants and users, so a shared database works without cleanup.
 */
export function describeAiRepositoriesContract(
  name: string,
  subject: () => AiRepositoriesUnderTest,
): void {
  describe(`ai repositories contract: ${name}`, () => {
    /** Two tenants; u1 and u2 in tenant t, u1 also in t2. */
    const world = () => {
      const t = generateId();
      const t2 = generateId();
      const u1 = generateId();
      const u2 = generateId();
      const principal = (userId: string, tenantId: string): Principal =>
        createPrincipal({ userId, tenantId, roles: ['member'] });
      return {
        t,
        t2,
        u1,
        u2,
        u1InT: principal(u1, t),
        u2InT: principal(u2, t),
        u1InT2: principal(u1, t2),
      };
    };
    const as = <T>(principal: Principal, work: () => Promise<T>): Promise<T> =>
      runWithPrincipal(principal, work);
    const repos = () => subject();

    /** A conversation of `principal` with `count` messages. */
    const seed = async (
      principal: Principal,
      count = 0,
    ): Promise<{ conversation: Conversation; messages: Message[] }> => {
      const conversation = makeConversation({
        tenantId: principal.tenantId ?? expect.fail('tenant-less principal'),
        userId: principal.userId,
      });
      await as(principal, () => repos().conversations.create(conversation));
      const messages: Message[] = [];
      for (let i = 0; i < count; i += 1) {
        const message = makeMessage(conversation, { content: `m${i}` });
        await as(principal, () => repos().messages.append(message));
        messages.push(message);
      }
      return { conversation, messages };
    };

    describe('conversations', () => {
      it('the owner reads its conversation back; another user or tenant reads null', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);

        await expect(
          as(w.u1InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toEqual(conversation);
        await expect(
          as(w.u2InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toBeNull();
        await expect(
          as(w.u1InT2, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toBeNull();
      });

      it('findByIdForUpdate reads as findById does: the owner its conversation, anyone else null', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        const lock = (principal: Principal, id = conversation.id) =>
          as(principal, () => repos().conversations.findByIdForUpdate(w.t, id));

        // On Postgres the row lock also needs the UPDATE grant and the update policy's USING.
        await expect(lock(w.u1InT)).resolves.toEqual(conversation);
        await expect(lock(w.u2InT)).resolves.toBeNull();
        await expect(lock(w.u1InT2)).resolves.toBeNull();
        await expect(lock(w.u1InT, generateId())).resolves.toBeNull();
      });

      it('creating one for another user or tenant fails with the policy error and stores nothing', async () => {
        const w = world();
        const forU2 = makeConversation({ tenantId: w.t, userId: w.u2 });
        const inT2 = makeConversation({ tenantId: w.t2, userId: w.u1 });

        await expect(
          failureOf(as(w.u1InT, () => repos().conversations.create(forU2))),
        ).resolves.toBe('42501');
        await expect(
          failureOf(as(w.u1InT, () => repos().conversations.create(inT2))),
        ).resolves.toBe('42501');
        await expect(
          as(w.u2InT, () => repos().conversations.findById(w.t, forU2.id)),
        ).resolves.toBeNull();
        await expect(
          as(w.u1InT2, () => repos().conversations.findById(w.t2, inT2.id)),
        ).resolves.toBeNull();
      });

      it("lists the user's conversations newest first, page by page, and nobody else's", async () => {
        const w = world();
        const mine = [
          (await seed(w.u1InT)).conversation,
          (await seed(w.u1InT)).conversation,
          (await seed(w.u1InT)).conversation,
        ];
        await seed(w.u2InT);
        await seed(w.u1InT2);
        const expected = byIdDesc(mine).map((c) => c.id);

        const first = await as(w.u1InT, () =>
          repos().conversations.list({ tenantId: w.t, userId: w.u1, limit: 2 }),
        );
        expect(first.items.map((c) => c.id)).toEqual(expected.slice(0, 2));
        expect(first.nextCursor).not.toBeNull();
        const second = await as(w.u1InT, () =>
          repos().conversations.list({
            tenantId: w.t,
            userId: w.u1,
            limit: 2,
            cursor: first.nextCursor,
          }),
        );
        expect(second.items.map((c) => c.id)).toEqual(expected.slice(2));
        expect(second.nextCursor).toBeNull();

        // Asking for u2's list as u1: the policies return nothing of u2's.
        const other = await as(w.u1InT, () =>
          repos().conversations.list({ tenantId: w.t, userId: w.u2, limit: 10 }),
        );
        expect(other.items).toEqual([]);
      });

      it("touch moves the owner's updatedAt; another user's conversation matches no row", async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        const later = new Date('2026-11-21T08:30:00.123Z');

        await as(w.u1InT, () => repos().conversations.touch(w.t, conversation.id, later));
        await expect(
          as(w.u1InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toEqual({ ...conversation, updatedAt: later });

        await expect(
          as(w.u2InT, () => repos().conversations.touch(w.t, conversation.id, new Date())),
        ).rejects.toBeInstanceOf(RowCountMismatchError);
        await expect(
          as(w.u1InT, () => repos().conversations.touch(w.t, generateId(), new Date())),
        ).rejects.toBeInstanceOf(RowCountMismatchError);
        await expect(
          as(w.u1InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toEqual({ ...conversation, updatedAt: later });
      });

      it('delete removes the conversation with its messages, keeps its usage, and spares the others', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT, 2);
        const kept = await seed(w.u1InT, 1);
        await as(w.u1InT, () => repos().usage.record(makeUsage(conversation)));

        await expect(
          as(w.u2InT, () => repos().conversations.delete(w.t, conversation.id)),
        ).resolves.toBe(false);
        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 10)),
        ).resolves.toHaveLength(2);

        await expect(
          as(w.u1InT, () => repos().conversations.delete(w.t, conversation.id)),
        ).resolves.toBe(true);
        await expect(
          as(w.u1InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toBeNull();
        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 10)),
        ).resolves.toEqual([]);
        await expect(
          as(w.u1InT, () => repos().conversations.delete(w.t, conversation.id)),
        ).resolves.toBe(false);

        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, kept.conversation.id, 10)),
        ).resolves.toEqual(kept.messages);
        await expect(repos().usageRowsOf(w.t)).resolves.toHaveLength(1);
      });
    });

    describe('messages', () => {
      it('appends and reads back; a replayed idempotency key returns the stored message', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        const reply = makeMessage(conversation, {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
          model: 'openai/gpt-4o-mini',
          inputTokens: 5,
          outputTokens: 3,
          idempotencyKey: 'key-1',
          requestHash: 'a'.repeat(64),
        });

        await expect(as(w.u1InT, () => repos().messages.append(reply))).resolves.toEqual({
          message: reply,
          created: true,
        });
        const replay = makeMessage(conversation, { idempotencyKey: 'key-1', content: 'other' });
        await expect(as(w.u1InT, () => repos().messages.append(replay))).resolves.toEqual({
          message: reply,
          created: false,
        });
        await expect(
          as(w.u1InT, () => repos().messages.findByIdempotencyKey(w.t, conversation.id, 'key-1')),
        ).resolves.toEqual(reply);
        await expect(
          as(w.u1InT, () => repos().messages.findByIdempotencyKey(w.t, conversation.id, 'key-2')),
        ).resolves.toBeNull();

        // Without a key, nothing collides.
        const plain = [makeMessage(conversation), makeMessage(conversation)];
        for (const message of plain) {
          await expect(as(w.u1InT, () => repos().messages.append(message))).resolves.toEqual({
            message,
            created: true,
          });
        }
        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 10)),
        ).resolves.toEqual([reply, ...plain]);
      });

      it('stores an incomplete reply as such', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        const partial = makeMessage(conversation, { role: 'assistant', status: 'incomplete' });
        await as(w.u1InT, () => repos().messages.append(partial));
        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 1)),
        ).resolves.toEqual([partial]);
      });

      it('listRecent is the window, oldest first; list pages newest first', async () => {
        const w = world();
        const { conversation, messages } = await seed(w.u1InT, 5);
        const asc = byIdDesc(messages).toReversed();

        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 3)),
        ).resolves.toEqual(asc.slice(2));

        const first = await as(w.u1InT, () =>
          repos().messages.list({ tenantId: w.t, conversationId: conversation.id, limit: 3 }),
        );
        expect(first.items).toEqual(byIdDesc(messages).slice(0, 3));
        const second = await as(w.u1InT, () =>
          repos().messages.list({
            tenantId: w.t,
            conversationId: conversation.id,
            limit: 3,
            cursor: first.nextCursor,
          }),
        );
        expect(second.items).toEqual(byIdDesc(messages).slice(3));
        expect(second.nextCursor).toBeNull();
      });

      it("another user or tenant reads none of the conversation's messages and cannot append as the owner", async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT, 2);
        await as(w.u1InT, () =>
          repos().messages.append(makeMessage(conversation, { idempotencyKey: 'k' })),
        );

        for (const intruder of [w.u2InT, w.u1InT2]) {
          await expect(
            as(intruder, () => repos().messages.listRecent(w.t, conversation.id, 10)),
          ).resolves.toEqual([]);
          await expect(
            as(intruder, () =>
              repos().messages.list({ tenantId: w.t, conversationId: conversation.id, limit: 10 }),
            ),
          ).resolves.toEqual({ items: [], nextCursor: null });
          await expect(
            as(intruder, () => repos().messages.findByIdempotencyKey(w.t, conversation.id, 'k')),
          ).resolves.toBeNull();
          await expect(
            failureOf(as(intruder, () => repos().messages.append(makeMessage(conversation)))),
          ).resolves.toBe('42501');
        }
        await expect(
          as(w.u1InT, () => repos().messages.listRecent(w.t, conversation.id, 10)),
        ).resolves.toHaveLength(3);
      });
    });

    describe('usage', () => {
      it("records the caller's usage, success and failure alike", async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        const ok = makeUsage(conversation, { messageId: generateId() });
        const failed = makeUsage(conversation, {
          outcome: 'timeout',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        });

        await as(w.u1InT, () => repos().usage.record(ok));
        await as(w.u1InT, () => repos().usage.record(failed));
        await expect(repos().usageRowsOf(w.t)).resolves.toEqual([ok, failed]);
      });

      it('recording for another user or tenant fails with the policy error', async () => {
        const w = world();
        const { conversation } = await seed(w.u1InT);
        await expect(
          failureOf(as(w.u2InT, () => repos().usage.record(makeUsage(conversation)))),
        ).resolves.toBe('42501');
        await expect(
          failureOf(as(w.u1InT2, () => repos().usage.record(makeUsage(conversation)))),
        ).resolves.toBe('42501');
        await expect(repos().usageRowsOf(w.t)).resolves.toEqual([]);
      });
    });

    describe('without a principal', () => {
      it('every method is refused before any statement (RLS_NO_PRINCIPAL)', async () => {
        const w = world();
        const conversation = makeConversation({ tenantId: w.t, userId: w.u1 });
        const calls: Record<string, () => Promise<unknown>> = {
          'conversations.create': () => repos().conversations.create(conversation),
          'conversations.findById': () => repos().conversations.findById(w.t, conversation.id),
          'conversations.findByIdForUpdate': () =>
            repos().conversations.findByIdForUpdate(w.t, conversation.id),
          'conversations.list': () =>
            repos().conversations.list({ tenantId: w.t, userId: w.u1, limit: 10 }),
          'conversations.touch': () =>
            repos().conversations.touch(w.t, conversation.id, new Date()),
          'conversations.delete': () => repos().conversations.delete(w.t, conversation.id),
          'messages.append': () => repos().messages.append(makeMessage(conversation)),
          'messages.findByIdempotencyKey': () =>
            repos().messages.findByIdempotencyKey(w.t, conversation.id, 'k'),
          'messages.listRecent': () => repos().messages.listRecent(w.t, conversation.id, 10),
          'messages.list': () =>
            repos().messages.list({ tenantId: w.t, conversationId: conversation.id, limit: 10 }),
          'usage.record': () => repos().usage.record(makeUsage(conversation)),
        };
        for (const [method, call] of Object.entries(calls)) {
          await expect(call(), method).rejects.toMatchObject({
            name: 'RlsContextError',
            code: 'RLS_NO_PRINCIPAL',
          });
        }
        await expect(
          as(w.u1InT, () => repos().conversations.findById(w.t, conversation.id)),
        ).resolves.toBeNull();
        await expect(repos().usageRowsOf(w.t)).resolves.toEqual([]);
      });
    });
  });
}
