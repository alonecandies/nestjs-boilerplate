import { normalizeEmail } from '@app/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import { isString } from 'lodash-es';

/*
 * class-transformer normalisers for DTOs and GraphQL inputs. They run inside the global
 * ValidationPipe (plainToInstance) BEFORE class-validator, so validation sees the normalised
 * value. Non-strings pass through untouched and fail the type validators.
 */

/** Trims surrounding whitespace. */
export const TrimString = (): PropertyDecorator =>
  Transform(({ value }: TransformFnParams): unknown => (isString(value) ? value.trim() : value));

/** Trim + lowercase (emails are stored normalised; lookups are then exact matches). */
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: TransformFnParams): unknown =>
    isString(value) ? normalizeEmail(value) : value,
  );
