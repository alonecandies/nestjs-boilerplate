import { HttpStatus } from '@nestjs/common';
import { AiDisabledError, AiModelNotAllowedError } from '@platform/ai';
import { aiTestConfig } from '@platform/ai/testing';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { installTestTransactionHost } from '../../test/ai-test.utils.js';
import { AI_LIMITS, AiChatErrorCode } from '../ai.constants.js';
import { makeConversation, makeMessage } from '../testing/ai-fixtures.js';
import {
  createInMemoryAiPersistence,
  type InMemoryAiPersistence,
} from '../testing/in-memory-ai.js';
import { CreateConversationCommand } from './commands/create-conversation/create-conversation.command.js';
import { CreateConversationHandler } from './commands/create-conversation/create-conversation.handler.js';
import { DeleteConversationCommand } from './commands/delete-conversation/delete-conversation.command.js';
import { DeleteConversationHandler } from './commands/delete-conversation/delete-conversation.handler.js';
import { GetConversationHandler } from './queries/get-conversation/get-conversation.handler.js';
import { GetConversationQuery } from './queries/get-conversation/get-conversation.query.js';
import { ListConversationsHandler } from './queries/list-conversations/list-conversations.handler.js';
import { ListConversationsQuery } from './queries/list-conversations/list-conversations.query.js';
import { ListMessagesHandler } from './queries/list-messages/list-messages.handler.js';
import { ListMessagesQuery } from './queries/list-messages/list-messages.query.js';

const TENANT = '0198f0a0-0000-7000-8000-000000000001';
const ADA = { tenantId: TENANT, userId: '0198f0a0-0000-7000-8000-0000000000a1' };
const BOB = { tenantId: TENANT, userId: '0198f0a0-0000-7000-8000-0000000000b2' };
const as = <T>(owner: typeof ADA, fn: () => Promise<T>): Promise<T> =>
  runWithPrincipal(createPrincipal({ ...owner, roles: ['member'] }), fn);
const notFound = { code: AiChatErrorCode.CONVERSATION_NOT_FOUND, httpStatus: HttpStatus.NOT_FOUND };

describe('conversation handlers', () => {
  let db: InMemoryAiPersistence;

  beforeEach(() => {
    db = createInMemoryAiPersistence();
    installTestTransactionHost(db.store);
  });

  describe('CreateConversationHandler', () => {
    const create = (config = aiTestConfig(), request: { title?: string; model?: string } = {}) =>
      as(ADA, () =>
        new CreateConversationHandler(db.conversations, config).execute(
          new CreateConversationCommand({ ...ADA, ...request }),
        ),
      );

    it('creates the caller’s conversation on the default model, untitled', async () => {
      const created = await create();
      expect(created).toMatchObject({ ...ADA, title: null, model: 'mock/default' });
      expect(created.createdAt).toEqual(created.updatedAt);
      expect([...db.store.conversations.values()]).toEqual([created]);
    });

    it('keeps a title and an allowed model, and refuses a model outside the allowlist (422)', async () => {
      expect(await create(aiTestConfig(), { title: 'Plans', model: 'mock/other' })).toMatchObject({
        title: 'Plans',
        model: 'mock/other',
      });
      const error = await create(aiTestConfig(), { model: 'evil/model' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiModelNotAllowedError);
      expect(db.store.conversations.size).toBe(1);
    });

    it('refuses while AI is disabled (503)', async () => {
      const error = await create(aiTestConfig({ enabled: false })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiDisabledError);
      expect(db.store.conversations.size).toBe(0);
    });
  });

  describe('reads and delete', () => {
    const mine = makeConversation(ADA);
    const bobs = makeConversation(BOB);

    beforeEach(async () => {
      await as(ADA, () => db.conversations.create(mine));
      await as(BOB, () => db.conversations.create(bobs));
      await as(ADA, () => db.messages.append(makeMessage(mine, { content: 'one' })));
      await as(ADA, () => db.messages.append(makeMessage(mine, { content: 'two' })));
    });

    it('lists only the caller’s conversations, with a default and a capped page size', async () => {
      const handler = new ListConversationsHandler(db.conversations);
      const page = await as(ADA, () => handler.execute(new ListConversationsQuery({ ...ADA })));
      expect(page).toEqual({ items: [mine], nextCursor: null });
      const capped = await as(ADA, () =>
        handler.execute(new ListConversationsQuery({ ...ADA, limit: 10_000 })),
      );
      expect(capped.items).toEqual([mine]);
      expect(AI_LIMITS.MAX_PAGE_SIZE).toBe(100);
    });

    it('gets the caller’s conversation; another user’s is a 404', async () => {
      const handler = new GetConversationHandler(db.conversations);
      expect(
        await as(ADA, () =>
          handler.execute(new GetConversationQuery({ ...ADA, conversationId: mine.id })),
        ),
      ).toEqual(mine);
      await expect(
        as(ADA, () =>
          handler.execute(new GetConversationQuery({ ...ADA, conversationId: bobs.id })),
        ),
      ).rejects.toMatchObject(notFound);
    });

    it('lists a conversation’s messages newest first; another user’s conversation is a 404', async () => {
      const handler = new ListMessagesHandler(db.conversations, db.messages);
      const page = await as(ADA, () =>
        handler.execute(new ListMessagesQuery({ ...ADA, conversationId: mine.id, limit: 1 })),
      );
      expect(page.items.map((m) => m.content)).toEqual(['two']);
      expect(page.nextCursor).not.toBeNull();
      await expect(
        as(BOB, () => handler.execute(new ListMessagesQuery({ ...BOB, conversationId: mine.id }))),
      ).rejects.toMatchObject(notFound);
    });

    it('deletes the caller’s conversation with its messages; another’s or a missing one is a 404', async () => {
      const handler = new DeleteConversationHandler(db.conversations);
      await expect(
        as(BOB, () =>
          handler.execute(new DeleteConversationCommand({ ...BOB, conversationId: mine.id })),
        ),
      ).rejects.toMatchObject(notFound);
      await as(ADA, () =>
        handler.execute(new DeleteConversationCommand({ ...ADA, conversationId: mine.id })),
      );
      expect(db.store.conversations.has(`${TENANT}/${mine.id}`)).toBe(false);
      expect(db.store.messages).toEqual([]);
      await expect(
        as(ADA, () =>
          handler.execute(new DeleteConversationCommand({ ...ADA, conversationId: generateId() })),
        ),
      ).rejects.toMatchObject(notFound);
    });

    it('refuses a request naming another user than the principal (403)', async () => {
      const handler = new GetConversationHandler(db.conversations);
      await expect(
        as(ADA, () =>
          handler.execute(new GetConversationQuery({ ...BOB, conversationId: bobs.id })),
        ),
      ).rejects.toMatchObject({ code: AiChatErrorCode.TENANT_MISMATCH });
    });
  });
});
