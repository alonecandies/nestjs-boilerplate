import { DomainValidationException, encodeCursor, MAX_PAGE_LIMIT } from '@app/common';
import { and, eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import {
  decodeIdCursor,
  encodeIdCursor,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetPageBy,
  keysetWhere,
  normalizePageLimit,
} from './keyset.js';

const items = pgTable('items', {
  id: uuid().primaryKey(),
  ownerId: uuid().notNull(),
  name: text(),
});
const db = drizzle.mock({ schema: { items }, casing: 'snake_case' });

const ID_1 = '0199a1b2-0000-7000-8000-000000000001';
const ID_2 = '0199a1b2-0000-7000-8000-000000000002';
const ID_3 = '0199a1b2-0000-7000-8000-000000000003';
const rows = [{ id: ID_3 }, { id: ID_2 }, { id: ID_1 }];

describe('normalizePageLimit / keysetFetchLimit', () => {
  it('defaults, truncates and clamps into [1, MAX_PAGE_LIMIT]', () => {
    expect(normalizePageLimit(undefined)).toBe(20);
    expect(normalizePageLimit(null)).toBe(20);
    expect(normalizePageLimit(Number.NaN)).toBe(20);
    expect(normalizePageLimit(0)).toBe(1);
    expect(normalizePageLimit(-5)).toBe(1);
    expect(normalizePageLimit(7.9)).toBe(7);
    expect(normalizePageLimit(10_000)).toBe(MAX_PAGE_LIMIT);
  });

  it('fetches one look-ahead row', () => {
    expect(keysetFetchLimit(10)).toBe(11);
    expect(keysetFetchLimit(undefined)).toBe(21);
  });
});

describe('id cursors', () => {
  it('round-trips an opaque base64url cursor', () => {
    const cursor = encodeIdCursor(ID_2);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeIdCursor(cursor)).toEqual({ id: ID_2 });
  });

  it.each([
    ['not base64', '%%%'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['wrong shape', encodeCursor({ createdAt: 1 })],
    ['not a uuid', encodeCursor({ id: '1 OR 1=1' })],
  ])('rejects garbage (%s) with a 422 INVALID_CURSOR', (_label, cursor) => {
    const attempt = (): unknown => decodeIdCursor(cursor);
    expect(attempt).toThrow(DomainValidationException);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_CURSOR', httpStatus: 422 });
    }
  });
});

describe('keysetWhere / keysetOrder', () => {
  it('returns undefined without a cursor so and() drops it', () => {
    expect(keysetWhere(items.id, undefined)).toBeUndefined();
    expect(keysetWhere(items.id, null)).toBeUndefined();
    expect(keysetWhere(items.id, '')).toBeUndefined();
    const query = db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.ownerId, ID_1), keysetWhere(items.id, undefined)))
      .toSQL();
    // and() drops the undefined operand entirely: a single condition, no seek predicate.
    expect(query.sql).toBe('select "id" from "items" where "items"."owner_id" = $1');
    expect(query.params).toEqual([ID_1]);
  });

  it('builds a DESC seek predicate bound through the column (not string-interpolated)', () => {
    const query = db
      .select({ id: items.id })
      .from(items)
      .where(keysetWhere(items.id, encodeIdCursor(ID_2)))
      .orderBy(keysetOrder(items.id))
      .limit(keysetFetchLimit(2))
      .toSQL();
    expect(query.sql).toBe(
      'select "id" from "items" where "items"."id" < $1 order by "items"."id" desc limit $2',
    );
    expect(query.params).toEqual([ID_2, 3]);
  });

  it('supports ascending order', () => {
    const query = db
      .select({ id: items.id })
      .from(items)
      .where(keysetWhere(items.id, encodeIdCursor(ID_2), 'asc'))
      .orderBy(keysetOrder(items.id, 'asc'))
      .toSQL();
    expect(query.sql).toBe(
      'select "id" from "items" where "items"."id" > $1 order by "items"."id" asc',
    );
  });

  it('validates the cursor before any SQL is built', () => {
    expect(() => keysetWhere(items.id, 'garbage!')).toThrow(DomainValidationException);
  });
});

describe('keysetPage', () => {
  it('emits a cursor to the last item when the look-ahead row exists', () => {
    const page = keysetPage(rows, 2);
    expect(page.items).toEqual([{ id: ID_3 }, { id: ID_2 }]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeIdCursor(page.nextCursor ?? '')).toEqual({ id: ID_2 });
  });

  it('returns nextCursor=null on the last page (exactly limit rows or fewer)', () => {
    expect(keysetPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(keysetPage(rows, 50)).toEqual({ items: rows, nextCursor: null });
    expect(keysetPage([], 10)).toEqual({ items: [], nextCursor: null });
  });

  it('does not mutate the input rows', () => {
    const input = [...rows];
    keysetPage(input, 1);
    expect(input).toEqual(rows);
  });

  it('keysetPageBy encodes a custom composite cursor', () => {
    const dated = [
      { id: ID_3, createdAt: '2026-09-03T00:00:00.000Z' },
      { id: ID_2, createdAt: '2026-09-02T00:00:00.000Z' },
    ];
    const page = keysetPageBy(dated, 1, (row) => ({ c: row.createdAt, id: row.id }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(encodeCursor({ c: '2026-09-03T00:00:00.000Z', id: ID_3 }));
  });
});
