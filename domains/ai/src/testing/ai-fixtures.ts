import { generateId } from '@platform/common';
import type { Conversation, Message, UsageRecord } from '../domain/ai.types.js';

/** A fixed millisecond instant (the columns keep milliseconds), so a stored record equals its input. */
const AT = new Date('2026-11-20T10:00:00.000Z');

/** A conversation of `userId` in `tenantId`, untitled, on a placeholder model. */
export function makeConversation(
  owner: { tenantId: string; userId: string },
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id: generateId(),
    title: null,
    model: 'openai/gpt-4o-mini',
    createdAt: AT,
    updatedAt: AT,
    ...owner,
    ...overrides,
  };
}

/** A complete user message in `conversation`, owned by the conversation's user. */
export function makeMessage(conversation: Conversation, overrides: Partial<Message> = {}): Message {
  return {
    tenantId: conversation.tenantId,
    id: generateId(),
    conversationId: conversation.id,
    userId: conversation.userId,
    role: 'user',
    content: 'Hello',
    status: 'complete',
    model: null,
    inputTokens: null,
    outputTokens: null,
    idempotencyKey: null,
    requestHash: null,
    createdAt: AT,
    ...overrides,
  };
}

/** A successful call's usage in `conversation`, for the conversation's user. */
export function makeUsage(
  conversation: Conversation,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    tenantId: conversation.tenantId,
    id: generateId(),
    userId: conversation.userId,
    conversationId: conversation.id,
    messageId: null,
    model: conversation.model,
    inputTokens: 12,
    outputTokens: 34,
    costUsd: 0.00012345,
    latencyMs: 420,
    outcome: 'success',
    createdAt: AT,
    ...overrides,
  };
}
