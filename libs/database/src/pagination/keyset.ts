import {
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
} from '@app/common';
import { asc, desc, gt, lt, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { clamp, isNil, last } from 'lodash-es';
import { z } from 'zod';

/*
 * Keyset ("seek") pagination on uuidv7 primary keys. uuidv7 ids are time-ordered, so
 * `ORDER BY id DESC` = newest first and `WHERE id < $cursor` resumes exactly after the last row
 * with one index range scan — page 1000 costs the same as page 1, unlike OFFSET.
 *
 *   const rows = await db.select().from(users)
 *     .where(and(filters, keysetWhere(users.id, q.cursor)))
 *     .orderBy(keysetOrder(users.id))
 *     .limit(keysetFetchLimit(q.limit));          // limit + 1 → tells us whether a next page exists
 *   return keysetPage(rows, q.limit);             // { items, nextCursor }
 */

export type KeysetDirection = 'asc' | 'desc';

/** Decoded payload of an id cursor. */
export interface IdCursor {
  id: string;
}

const idCursorSchema: z.ZodType<IdCursor> = z.object({ id: z.uuid() });

/** Clamps a requested page size into `[1, MAX_PAGE_LIMIT]` (default `DEFAULT_PAGE_LIMIT`). */
export function normalizePageLimit(limit?: number | null): number {
  if (isNil(limit) || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return clamp(Math.trunc(limit), 1, MAX_PAGE_LIMIT);
}

/** SQL `LIMIT` for a keyset query: the page size plus one look-ahead row. */
export function keysetFetchLimit(limit?: number | null): number {
  return normalizePageLimit(limit) + 1;
}

/** Opaque cursor pointing just after the row with this id. */
export function encodeIdCursor(id: string): string {
  return encodeCursor({ id });
}

/**
 * Decodes a client-supplied cursor. Garbage → `DomainValidationException` (422, code
 * `INVALID_CURSOR`), never a 500 and never an unvalidated value reaching SQL.
 */
export function decodeIdCursor(cursor: string): IdCursor {
  return decodeCursor(cursor, idCursorSchema);
}

/**
 * `WHERE` fragment resuming after `cursor` (`undefined` when there is no cursor, which `and()`
 * ignores). Operators bind the value through the column codec (unlike raw `sql` templates).
 */
export function keysetWhere(
  column: PgColumn,
  cursor: string | null | undefined,
  direction: KeysetDirection = 'desc',
): SQL | undefined {
  if (isNil(cursor) || cursor === '') return undefined;
  const { id } = decodeIdCursor(cursor);
  return direction === 'desc' ? lt(column, id) : gt(column, id);
}

/**
 * Matching `ORDER BY`. Index note (research data-libs GOTCHA 2): a plain ASC btree (the PK) is
 * scanned backwards for DESC — don't declare `.desc()` indexes (drizzle emits NULLS LAST).
 */
export function keysetOrder(column: PgColumn, direction: KeysetDirection = 'desc'): SQL {
  return direction === 'desc' ? desc(column) : asc(column);
}

/**
 * Turns the rows of a `LIMIT keysetFetchLimit(limit)` query into a page with a custom cursor
 * (composite keys such as `(createdAt, id)`). Only when the look-ahead row exists is there a
 * next page, so the last page never yields a cursor to an empty page.
 */
export function keysetPageBy<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => Record<string, unknown>,
): CursorPage<T> {
  const size = normalizePageLimit(limit);
  const items = rows.slice(0, size);
  const lastItem = last(items);
  const hasMore = rows.length > size && lastItem !== undefined;
  return { items, nextCursor: hasMore ? encodeCursor(cursorOf(lastItem)) : null };
}

/** `keysetPageBy` for the common case: uuidv7 `id` cursor (pairs with `keysetWhere`). */
export function keysetPage<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
): CursorPage<T> {
  return keysetPageBy(rows, limit, (row) => ({ id: row.id }));
}
