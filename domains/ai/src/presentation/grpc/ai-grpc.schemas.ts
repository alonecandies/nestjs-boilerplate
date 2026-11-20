import { MAX_CURSOR_LENGTH } from '@platform/common';
import { z } from 'zod';
import { AI_LIMITS, IDEMPOTENCY_KEY_PATTERN } from '../../ai.constants.js';

/*
 * gRPC payload schemas (`ZodRpcValidationPipe`): the same bounds as the REST bodies. ts-proto request
 * types are interfaces, so class-validator cannot see them. proto-loader (`defaults: true`) decodes
 * an absent optional field as `undefined` or `null`: every optional field accepts both and
 * normalises them to `undefined`, as the port expects. The caller's tenant and user are re-checked
 * against the principal by the handlers.
 */

const absentAsUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

const caller = { tenantId: z.uuid(), userId: z.uuid() };
const model = z
  .string()
  .trim()
  .min(1)
  .max(AI_LIMITS.MODEL_MAX_LENGTH)
  .nullish()
  .transform(absentAsUndefined);
// 0 = "not set" in proto3; the handlers apply the default page size.
const limit = z
  .number()
  .int()
  .min(0)
  .max(AI_LIMITS.MAX_PAGE_SIZE)
  .transform((value) => (value === 0 ? undefined : value));
// Opaque; decoded by the repositories. "" = absent.
const cursor = z
  .string()
  .max(MAX_CURSOR_LENGTH)
  .nullish()
  .transform((value) => (value === '' ? undefined : absentAsUndefined(value)));

export const createConversationRpcSchema = z.object({
  ...caller,
  title: z
    .string()
    .trim()
    .min(1)
    .max(AI_LIMITS.TITLE_MAX_LENGTH)
    .nullish()
    .transform(absentAsUndefined),
  model,
});

export const listConversationsRpcSchema = z.object({ ...caller, limit, cursor });

export const conversationRpcSchema = z.object({ ...caller, conversationId: z.uuid() });

export const listMessagesRpcSchema = z.object({
  ...caller,
  conversationId: z.uuid(),
  limit,
  cursor,
});

export const sendMessageRpcSchema = z.object({
  ...caller,
  conversationId: z.uuid(),
  content: z.string().trim().min(1).max(AI_LIMITS.MESSAGE_MAX_LENGTH),
  model,
  idempotencyKey: z
    .string()
    .min(AI_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH)
    .max(AI_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(IDEMPOTENCY_KEY_PATTERN)
    .nullish()
    .transform(absentAsUndefined),
});
