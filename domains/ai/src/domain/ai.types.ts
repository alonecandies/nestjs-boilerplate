/*
 * The ai context's records. Dependency-free: ai.schema.ts imports this file, and drizzle-kit loads
 * the schema without workspace packages.
 */

/** Who wrote a message: the AI SDK's `ModelMessage` roles. */
export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * `complete`: the whole message. `incomplete`: an assistant reply cut short (the client left
 * mid-stream, or the call failed after the first tokens); stored once, never completed later.
 */
export const MESSAGE_STATUSES = ['complete', 'incomplete'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** How a model call ended: the `outcome` label of `ai_requests_total` (@platform/ai). */
export const USAGE_OUTCOMES = ['success', 'error', 'timeout', 'aborted'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

/** A JSON value, as stored in a `jsonb` column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A message's content as the AI SDK's `ModelMessage.content` has it: plain text, or parts (text,
 * tool calls, tool results), each a JSON object.
 */
export type MessageContent = string | readonly { readonly [key: string]: JsonValue }[];

/** One chat thread of one user in one tenant. */
export interface Conversation {
  readonly tenantId: string;
  /** uuidv7: ids sort by creation time. */
  readonly id: string;
  /** The owner: only this user reads or changes the thread (RLS). */
  readonly userId: string;
  /** `null` until named. */
  readonly title: string | null;
  /** The model the thread uses unless a message asks for another. */
  readonly model: string;
  readonly createdAt: Date;
  /** Moves with every stored exchange: the thread's last activity. */
  readonly updatedAt: Date;
}

/** One message of a conversation. `userId` is the conversation owner's, copied for row-local RLS. */
export interface Message {
  readonly tenantId: string;
  /** uuidv7: the conversation's order. */
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: MessageRole;
  readonly content: MessageContent;
  readonly status: MessageStatus;
  /** The model that wrote an assistant message; `null` for the others. */
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** The client's `Idempotency-Key`: unique per conversation; `null` never collides. */
  readonly idempotencyKey: string | null;
  /** sha256 hex of the normalized request, to tell a replay from a reused key. */
  readonly requestHash: string | null;
  readonly createdAt: Date;
}

/** One model call, kept for usage reporting: written once, never changed or deleted. */
export interface UsageRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  /** The assistant message the call produced; `null` when it produced none (a failure). */
  readonly messageId: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** OpenRouter's reported cost in USD; `null` when not reported. */
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly outcome: UsageOutcome;
  readonly createdAt: Date;
}
