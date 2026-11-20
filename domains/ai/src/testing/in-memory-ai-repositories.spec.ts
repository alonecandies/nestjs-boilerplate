import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversation, makeMessage } from './ai-fixtures.js';
import { describeAiRepositoriesContract } from './ai-repositories.contract.test.js';
import { createInMemoryAiPersistence, type InMemoryAiPersistence } from './in-memory-ai.js';

let persistence: InMemoryAiPersistence;
beforeEach(() => {
  persistence = createInMemoryAiPersistence();
});

describeAiRepositoriesContract('in-memory twins', () => ({
  conversations: persistence.conversations,
  messages: persistence.messages,
  usage: persistence.usage,
  usageRowsOf: async (tenantId) =>
    persistence.store.usage.filter((row) => row.tenantId === tenantId),
}));

describe('in-memory ai persistence', () => {
  it('hands out copies: changing a returned record changes nothing stored', async () => {
    const tenantId = generateId();
    const principal = createPrincipal({ userId: generateId(), tenantId, roles: ['member'] });
    const conversation = makeConversation({ tenantId, userId: principal.userId });
    await runWithPrincipal(principal, async () => {
      await persistence.conversations.create(conversation);
      await persistence.messages.append(makeMessage(conversation));
      const found = await persistence.conversations.findById(tenantId, conversation.id);
      (found as { title: string | null }).title = 'changed';
      const [message] = await persistence.messages.listRecent(tenantId, conversation.id, 1);
      (message as { content: unknown }).content = 'changed';
    });

    expect(persistence.store.conversations.get(`${tenantId}/${conversation.id}`)?.title).toBeNull();
    expect(persistence.store.messages[0]?.content).toBe('Hello');
  });
});
