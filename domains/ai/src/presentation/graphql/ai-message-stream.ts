import type { GqlContext } from '@platform/graphql';
import type { MessageResponse } from '../http/ai.dto.js';
import { toAiMessageModel } from './models/ai-message.model.js';
import type {
  AiMessageStreamEventModel,
  AiMessageStreamEventType,
} from './models/ai-message-stream-event.model.js';

/** Prefix of the GraphQL PubSub triggers of the `aiMessageStream` subscription. */
export const AI_MESSAGE_STREAM_TRIGGER = 'aiMessageStream';

/**
 * Per-(tenant, user, conversation) trigger (`aiMessageStream:<tenantId>:<userId>:<conversationId>`):
 * `streamAiMessage` publishes on the trigger of its token's tenant and user, and each subscription
 * listens on the trigger of its own token's tenant and user only (the B4 pattern of
 * `notificationCreated`). Another user, or the same user signed in to another tenant, never hears
 * the turn; with RedisPubSub an event wakes only its owner's iterators.
 */
export const aiMessageStreamTrigger = (
  tenantId: string,
  userId: string,
  conversationId: string,
): string => `${AI_MESSAGE_STREAM_TRIGGER}:${tenantId}:${userId}:${conversationId}`;

/**
 * What `streamAiMessage` publishes: plain JSON (RedisPubSub serialises it), with the owner's
 * tenant and user for the subscription filter. `resolve` drops them.
 */
export interface AiMessageStreamPush {
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly type: AiMessageStreamEventType;
  readonly delta?: string;
  /** The stored reply as REST `AiMessage` (`DONE`). */
  readonly message?: MessageResponse;
  readonly replayed?: boolean;
  readonly errorCode?: string;
}

/**
 * Subscribers receive only their own turns, in the tenant their token is for, for the conversation
 * they asked about. The trigger is already per (tenant, user, conversation); this filter is defence
 * in depth: a payload published on the wrong trigger still reaches nobody else.
 */
export function isOwnStreamEvent(
  payload: AiMessageStreamPush,
  variables: { conversationId?: unknown },
  context: GqlContext,
): boolean {
  const user = context.req.user;
  if (user === undefined) return false;
  return (
    typeof payload.tenantId === 'string' &&
    payload.tenantId === user.tenantId &&
    payload.userId === user.id &&
    payload.conversationId === variables.conversationId
  );
}

export function toAiMessageStreamEvent(payload: AiMessageStreamPush): AiMessageStreamEventModel {
  return {
    conversationId: payload.conversationId,
    type: payload.type,
    delta: payload.delta ?? null,
    message: payload.message === undefined ? null : toAiMessageModel(payload.message),
    replayed: payload.replayed ?? null,
    errorCode: payload.errorCode ?? null,
  };
}
