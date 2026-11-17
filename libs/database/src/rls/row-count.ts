/**
 * Under RLS a write the policies hide affects 0 rows instead of failing: a runtime repository
 * that expects to change a row checks the count and throws, so a refused write never passes as
 * a success.
 */
export class RowCountMismatchError extends Error {
  override readonly name = 'RowCountMismatchError';

  constructor(
    readonly expected: number,
    readonly actual: number,
    what: string,
  ) {
    super(`${what}: expected ${expected} row(s) affected, got ${actual}`);
  }
}

/** `result` is a postgres.js result (`RowList.count`): rows inserted, updated or deleted. */
export function assertRowsAffected(
  result: { count: number },
  expected: number,
  what: string,
): void {
  if (result.count !== expected) throw new RowCountMismatchError(expected, result.count, what);
}
