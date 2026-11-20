import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  getHeaderValue,
  getRequest,
  HTTP_HEADERS,
  toValidationIssues,
  type ValidationErrorBody,
} from '@platform/common';
import { z } from 'zod';
import { AI_LIMITS, IDEMPOTENCY_KEY_PATTERN } from '../../ai.constants.js';

export const idempotencyKeySchema = z
  .string()
  .min(AI_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(AI_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Only letters, digits and . _ : - are allowed');

/**
 * The optional `Idempotency-Key` header, validated (8–255 chars of `[A-Za-z0-9._:-]`). An invalid
 * key is a 400 with the validation pipes' body shape (`errors[].path` = `headers.idempotency-key`).
 */
export const IdempotencyKey: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const value = getHeaderValue(getRequest(ctx)?.headers, HTTP_HEADERS.IDEMPOTENCY_KEY);
    if (value === undefined) return undefined;
    const result = idempotencyKeySchema.safeParse(value);
    if (result.success) return result.data;
    const body: ValidationErrorBody = {
      message: 'Request validation failed',
      errors: toValidationIssues(result.error.issues).map((issue) => ({
        ...issue,
        path: `headers.${HTTP_HEADERS.IDEMPOTENCY_KEY}`,
      })),
    };
    throw new BadRequestException(body);
  },
);
