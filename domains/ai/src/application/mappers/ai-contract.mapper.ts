import type {
  ChatUsage as ChatUsageContract,
  Conversation as ConversationContract,
  ConversationPage as ConversationPageContract,
  Message as MessageContract,
  MessagePage as MessagePageContract,
  SendMessageResult as SendMessageResultContract,
  StreamMessageEvent,
} from '@domain/ai-contracts';
import { type CursorPage, ExternalServiceException } from '@platform/common';
import {
  type Conversation,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  type Message,
  type MessageContent,
  type MessageRole,
  type MessageStatus,
} from '../../domain/ai.types.js';
import type { ChatStreamEvent, ChatStreamUsage, SendMessageResult } from '../ports/ai.port.js';

/*
 * ai records <-> `ai.v1` messages. ai-service maps its port results to the contract
 * (`to*Contract`); the gateway's gRPC adapter maps them back (`from*Contract`) so the presentation
 * code sees exactly what the local adapter returns. proto-loader (`defaults: true`, `oneofs: true`)
 * decodes an absent optional scalar as `undefined` and an absent message as `null`: both read as
 * absent here, and absent optionals become the records' `null`.
 */

/** Thrown when ai-service sends a record the contract does not allow (a 502 at the edge). */
function malformed(what: string): ExternalServiceException {
  return new ExternalServiceException(`ai-service sent a malformed ${what}`);
}

function dateOf(value: Date | null | undefined, what: string): Date {
  if (value instanceof Date) return value;
  throw malformed(what);
}

/** `null` for absent (undefined, proto-loader's null), otherwise the value. */
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;
/** `undefined` for absent, otherwise the value (the contract's optional fields). */
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export function toConversationContract(conversation: Conversation): ConversationContract {
  return {
    tenantId: conversation.tenantId,
    id: conversation.id,
    userId: conversation.userId,
    title: orUndefined(conversation.title),
    model: conversation.model,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function fromConversationContract(conversation: ConversationContract): Conversation {
  return {
    tenantId: conversation.tenantId,
    id: conversation.id,
    userId: conversation.userId,
    title: orNull(conversation.title),
    model: conversation.model,
    createdAt: dateOf(conversation.createdAt, 'conversation'),
    updatedAt: dateOf(conversation.updatedAt, 'conversation'),
  };
}

export function toConversationPageContract(
  page: CursorPage<Conversation>,
): ConversationPageContract {
  return {
    items: page.items.map(toConversationContract),
    nextCursor: orUndefined(page.nextCursor),
  };
}

export function fromConversationPageContract(
  page: ConversationPageContract,
): CursorPage<Conversation> {
  return {
    // Repeated fields decode as [] with `defaults: true`; `?? []` also covers another server.
    items: (page.items ?? []).map(fromConversationContract),
    nextCursor: page.nextCursor || null,
  };
}

export function toMessageContract(message: Message): MessageContract {
  return {
    tenantId: message.tenantId,
    id: message.id,
    conversationId: message.conversationId,
    userId: message.userId,
    role: message.role,
    contentJson: JSON.stringify(message.content),
    status: message.status,
    model: orUndefined(message.model),
    inputTokens: orUndefined(message.inputTokens),
    outputTokens: orUndefined(message.outputTokens),
    idempotencyKey: orUndefined(message.idempotencyKey),
    requestHash: orUndefined(message.requestHash),
    createdAt: message.createdAt,
  };
}

function contentOf(json: string): MessageContent {
  let content: unknown;
  try {
    content = JSON.parse(json);
  } catch {
    throw malformed('message content');
  }
  if (typeof content === 'string') return content;
  if (
    Array.isArray(content) &&
    content.every((part) => typeof part === 'object' && part !== null && !Array.isArray(part))
  ) {
    return content as MessageContent;
  }
  throw malformed('message content');
}

const isRole = (value: string): value is MessageRole =>
  (MESSAGE_ROLES as readonly string[]).includes(value);
const isStatus = (value: string): value is MessageStatus =>
  (MESSAGE_STATUSES as readonly string[]).includes(value);

export function fromMessageContract(message: MessageContract | null | undefined): Message {
  if (message == null) throw malformed('message');
  const { role, status } = message;
  if (!isRole(role) || !isStatus(status)) throw malformed('message');
  return {
    tenantId: message.tenantId,
    id: message.id,
    conversationId: message.conversationId,
    userId: message.userId,
    role,
    content: contentOf(message.contentJson),
    status,
    model: orNull(message.model),
    inputTokens: orNull(message.inputTokens),
    outputTokens: orNull(message.outputTokens),
    idempotencyKey: orNull(message.idempotencyKey),
    requestHash: orNull(message.requestHash),
    createdAt: dateOf(message.createdAt, 'message'),
  };
}

export function toMessagePageContract(page: CursorPage<Message>): MessagePageContract {
  return { items: page.items.map(toMessageContract), nextCursor: orUndefined(page.nextCursor) };
}

export function fromMessagePageContract(page: MessagePageContract): CursorPage<Message> {
  return {
    items: (page.items ?? []).map(fromMessageContract),
    nextCursor: page.nextCursor || null,
  };
}

export function toSendMessageResultContract(result: SendMessageResult): SendMessageResultContract {
  return { message: toMessageContract(result.message), replayed: result.replayed };
}

export function fromSendMessageResultContract(
  result: SendMessageResultContract,
): SendMessageResult {
  return { message: fromMessageContract(result.message), replayed: result.replayed };
}

function toUsageContract(usage: ChatStreamUsage): ChatUsageContract {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: orUndefined(usage.costUsd),
  };
}

function fromUsageContract(usage: ChatUsageContract | null | undefined): ChatStreamUsage | null {
  if (usage == null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: orNull(usage.costUsd),
  };
}

/** The `started` event ai-service sends once the turn began (before any delta). */
export const STREAM_STARTED_EVENT: StreamMessageEvent = { started: {} };

export function toStreamEventContract(event: ChatStreamEvent): StreamMessageEvent {
  if (event.type === 'delta') return { delta: { text: event.text } };
  return {
    done: {
      message: toMessageContract(event.message),
      replayed: event.replayed,
      ...(event.usage === null ? {} : { usage: toUsageContract(event.usage) }),
    },
  };
}

/**
 * One `ai.v1.StreamMessageEvent` as the port's event: `started` → `'started'` (the adapter's cue to
 * resolve), `delta` and `done` → the port's `ChatStreamEvent`.
 */
export function fromStreamEventContract(event: StreamMessageEvent): ChatStreamEvent | 'started' {
  if (event.started != null) return 'started';
  if (event.delta != null) return { type: 'delta', text: event.delta.text };
  if (event.done != null) {
    return {
      type: 'done',
      message: fromMessageContract(event.done.message),
      replayed: event.done.replayed,
      usage: fromUsageContract(event.done.usage),
    };
  }
  throw malformed('stream event');
}
