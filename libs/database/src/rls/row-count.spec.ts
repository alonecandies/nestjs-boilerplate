import { describe, expect, it } from 'vitest';
import { assertRowsAffected, RowCountMismatchError } from './row-count.js';

describe('assertRowsAffected', () => {
  it('passes when the counts are equal', () => {
    expect(() => assertRowsAffected({ count: 1 }, 1, 'orders.update')).not.toThrow();
    expect(() => assertRowsAffected({ count: 0 }, 0, 'orders.delete')).not.toThrow();
  });

  it('throws RowCountMismatchError carrying both numbers on a mismatch', () => {
    let caught: unknown;
    try {
      assertRowsAffected({ count: 0 }, 1, 'orders.update');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RowCountMismatchError);
    expect(caught).toMatchObject({ name: 'RowCountMismatchError', expected: 1, actual: 0 });
    expect((caught as Error).message).toBe('orders.update: expected 1 row(s) affected, got 0');
  });

  it('also throws when more rows changed than expected', () => {
    expect(() => assertRowsAffected({ count: 3 }, 1, 'orders.update')).toThrow(
      RowCountMismatchError,
    );
  });
});
