import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainValidationException } from '../errors/domain.exception.js';
import { decodeCursor, encodeCursor, MAX_CURSOR_LENGTH } from './cursor.util.js';
import { generateId } from './id.util.js';

const cursorSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });

describe('cursor utils', () => {
  it('round-trips a keyset position through an opaque base64url string', () => {
    const position = { id: generateId(), createdAt: new Date().toISOString() };
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, cursorSchema)).toEqual(position);
  });

  it.each([
    ['empty', ''],
    ['non base64url characters', 'abc+/='],
    ['not JSON', Buffer.from('nope', 'utf8').toString('base64url')],
    ['wrong shape', encodeCursor({ id: 'x' })],
    ['too long', 'a'.repeat(MAX_CURSOR_LENGTH + 1)],
  ])('rejects %s cursors with a 422 INVALID_CURSOR', (_label, cursor) => {
    const error = (() => {
      try {
        decodeCursor(cursor, cursorSchema);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(DomainValidationException);
    expect(error).toMatchObject({ code: 'INVALID_CURSOR', httpStatus: 422 });
    expect((error as DomainValidationException).issues[0]?.path).toBe('cursor');
  });
});
