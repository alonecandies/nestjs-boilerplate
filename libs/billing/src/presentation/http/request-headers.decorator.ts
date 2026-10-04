import {
  getHeaderValue,
  getRequest,
  HTTP_HEADERS,
  toValidationIssues,
  type ValidationErrorBody,
} from '@app/common';
import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { z } from 'zod';
import { BILLING_LIMITS, IDEMPOTENCY_KEY_PATTERN } from '../../billing.constants.js';

export const idempotencyKeySchema = z
  .string()
  .min(BILLING_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(BILLING_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Only letters, digits and . _ : - are allowed');

const headerOf = (ctx: ExecutionContext, name: string): string | undefined =>
  getHeaderValue(getRequest(ctx)?.headers, name);

/**
 * First value of a request header (`undefined` when absent or empty). Unlike `@Headers(name)`
 * it never yields `string[]` for a repeated header.
 */
export const HeaderValue: (name: string) => ParameterDecorator = createParamDecorator(
  (name: string, ctx: ExecutionContext): string | undefined => headerOf(ctx, name),
);

/**
 * The optional `Idempotency-Key` header, validated (8–255 chars of `[A-Za-z0-9._:-]`). An invalid
 * key is a 400 with the same body shape as the validation pipes (`errors[].path` =
 * `headers.idempotency-key`), so clients handle every request-validation failure alike.
 */
export const IdempotencyKey: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const value = headerOf(ctx, HTTP_HEADERS.IDEMPOTENCY_KEY);
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
