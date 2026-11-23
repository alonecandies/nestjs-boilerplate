import { clamp, isNil } from 'lodash-es';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../dto/cursor-pagination.dto.js';

/** A context's own page-size bounds (defaults: `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`). */
export interface PageSizeBounds {
  defaultSize?: number;
  maxSize?: number;
}

/**
 * The one page-size rule for listings, whatever the transport. Absent, `0` (proto3's "not set"),
 * negative or not an integer → the default; otherwise capped at the maximum. Edges validate
 * first, but the core never trusts them.
 */
export function resolvePageSize(limit?: number | null, bounds: PageSizeBounds = {}): number {
  const { defaultSize = DEFAULT_PAGE_LIMIT, maxSize = MAX_PAGE_LIMIT } = bounds;
  if (isNil(limit) || !Number.isInteger(limit) || limit <= 0) return defaultSize;
  return clamp(limit, 1, maxSize);
}
