import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { z } from 'zod';
import { HTTP_HEADERS } from '../constants/headers.constants.js';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from '../constants/idempotency-key.constants.js';
import { getHeaderValue, getRequest } from '../context/execution-context.util.js';
import { toValidationIssues } from '../errors/validation-issue.js';
import type { ValidationErrorBody } from '../pipes/validation.js';

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Only letters, digits and . _ : - are allowed');

/**
 * The optional `Idempotency-Key` header, validated (`IDEMPOTENCY_KEY_FORMAT`). Absent or empty →
 * `undefined`; a repeated header → its first value. An invalid key is a 400 with the same body
 * shape as the validation pipes (`errors[].path` = `headers.idempotency-key`), so clients handle
 * every request-validation failure alike.
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
