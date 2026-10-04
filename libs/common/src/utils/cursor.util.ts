import type { z } from 'zod';
import { DomainValidationException } from '../errors/domain.exception.js';

/** Hard cap before decoding: a cursor is a few ids/timestamps, never kilobytes. */
export const MAX_CURSOR_LENGTH = 512;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const invalidCursor = (message: string): DomainValidationException =>
  new DomainValidationException('Invalid pagination cursor', {
    code: 'INVALID_CURSOR',
    issues: [{ path: 'cursor', message }],
  });

/** Opaque keyset cursor: base64url(JSON). Opaque so clients can't depend on (or forge) its layout. */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor produced by `encodeCursor`. Cursors are client-controlled input,
 * so garbage (bad base64, bad JSON, wrong shape) is a 422 `INVALID_CURSOR`, never a 500.
 */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    throw invalidCursor('Cursor is malformed');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('Cursor is malformed');
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw invalidCursor('Cursor does not match the expected shape');
  return result.data;
}
