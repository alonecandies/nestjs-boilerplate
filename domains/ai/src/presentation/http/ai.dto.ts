import type { CursorPage } from '@platform/common';
import { MAX_CURSOR_LENGTH } from '@platform/common';
import { z } from 'zod';
import { AI_LIMITS } from '../../ai.constants.js';
import type { SendMessageResult } from '../../application/ports/ai.port.js';
import {
  type Conversation,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  type Message,
} from '../../domain/ai.types.js';

/*
 * REST request and response schemas (Nest-native Standard Schema). Responses are documented with
 * `@ApiOkResponse({ standardSchema })` and enforced by `StandardSchemaSerializerInterceptor`. No
 * `.meta({ id })` on query/param objects: Swagger expands them into individual parameters.
 */

const model = z.string().trim().min(1).max(AI_LIMITS.MODEL_MAX_LENGTH);

export const createConversationBodySchema = z
  .strictObject({
    title: z.string().trim().min(1).max(AI_LIMITS.TITLE_MAX_LENGTH).optional(),
    model: model.optional().describe('Default `AI_DEFAULT_MODEL`; must be allowed.'),
  })
  .meta({ id: 'CreateConversationBody' });
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>;

export const sendMessageBodySchema = z
  .strictObject({
    content: z.string().trim().min(1).max(AI_LIMITS.MESSAGE_MAX_LENGTH).describe('Your message.'),
    model: model.optional().describe("Default: the conversation's model; must be allowed."),
  })
  .meta({ id: 'SendMessageBody' });
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export const pageQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_LIMITS.MAX_PAGE_SIZE)
    .default(AI_LIMITS.DEFAULT_PAGE_SIZE)
    .describe('Page size (newest first).'),
  cursor: z
    .string()
    .min(1)
    .max(MAX_CURSOR_LENGTH)
    .optional()
    .describe('`nextCursor` of the previous page.'),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const conversationIdParamSchema = z.uuid();

export const conversationResponseSchema = z
  .object({
    id: z.uuid(),
    title: z.string().nullable(),
    model: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime().describe('Last activity.'),
  })
  .meta({ id: 'AiConversation', description: 'One of your AI conversations.' });
export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

export const conversationPageResponseSchema = z
  .object({
    items: z.array(conversationResponseSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor`; `null` on the last page.'),
  })
  .meta({ id: 'AiConversationPage' });
export type ConversationPageResponse = z.infer<typeof conversationPageResponseSchema>;

export const messageResponseSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    role: z.enum(MESSAGE_ROLES),
    content: z
      .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
      .describe('Text, or AI SDK message parts (tool calls and results).'),
    status: z.enum(MESSAGE_STATUSES),
    model: z.string().nullable().describe('The model that wrote an assistant message.'),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AiMessage' });
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const messagePageResponseSchema = z
  .object({
    items: z.array(messageResponseSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor`; `null` on the last page.'),
  })
  .meta({ id: 'AiMessagePage' });
export type MessagePageResponse = z.infer<typeof messagePageResponseSchema>;

export const sendMessageResponseSchema = z
  .object({
    message: messageResponseSchema.describe("The assistant's reply."),
    replayed: z
      .boolean()
      .describe('`true` when an `Idempotency-Key` replay returned the stored reply.'),
  })
  .meta({ id: 'AiSendMessageResult' });
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

export function toConversationResponse(conversation: Conversation): ConversationResponse {
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function toConversationPageResponse(
  page: CursorPage<Conversation>,
): ConversationPageResponse {
  return { items: page.items.map(toConversationResponse), nextCursor: page.nextCursor };
}

export function toMessageResponse(message: Message): MessageResponse {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content as MessageResponse['content'],
    status: message.status,
    model: message.model,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toMessagePageResponse(page: CursorPage<Message>): MessagePageResponse {
  return { items: page.items.map(toMessageResponse), nextCursor: page.nextCursor };
}

export function toSendMessageResponse(result: SendMessageResult): SendMessageResponse {
  return { message: toMessageResponse(result.message), replayed: result.replayed };
}
