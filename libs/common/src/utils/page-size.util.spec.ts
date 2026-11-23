import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../dto/cursor-pagination.dto.js';
import { resolvePageSize } from './page-size.util.js';

describe('resolvePageSize', () => {
  it.each([
    [undefined, DEFAULT_PAGE_LIMIT],
    [null, DEFAULT_PAGE_LIMIT],
    [0, DEFAULT_PAGE_LIMIT], // proto3 "not set"
    [-3, DEFAULT_PAGE_LIMIT],
    [2.5, DEFAULT_PAGE_LIMIT],
    [Number.NaN, DEFAULT_PAGE_LIMIT],
    [Number.POSITIVE_INFINITY, DEFAULT_PAGE_LIMIT],
    [1, 1],
    [37, 37],
    [MAX_PAGE_LIMIT, MAX_PAGE_LIMIT],
    [10_000, MAX_PAGE_LIMIT],
  ])('%s → %s with the platform bounds', (limit, expected) => {
    expect(resolvePageSize(limit)).toBe(expected);
  });

  it('takes a context its own default and maximum', () => {
    const bounds = { defaultSize: 10, maxSize: 50 };
    expect(resolvePageSize(0, bounds)).toBe(10);
    expect(resolvePageSize(undefined, bounds)).toBe(10);
    expect(resolvePageSize(7.5, bounds)).toBe(10);
    expect(resolvePageSize(30, bounds)).toBe(30);
    expect(resolvePageSize(51, bounds)).toBe(50);
    expect(resolvePageSize(500, { maxSize: 200 })).toBe(200);
    expect(resolvePageSize(0, { maxSize: 200 })).toBe(DEFAULT_PAGE_LIMIT);
  });
});
