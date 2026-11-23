import type { LedgerCursor } from '../../../repositories/ledger.system-repository.js';

/**
 * The pages of a keyset list, one array per page, in order. `read(after)` returns the page after
 * the cursor (`null` for the first); the next cursor is `cursorOf` the last row of the page. It
 * stops on an empty page, or on one shorter than `pageSize` without asking for another. A page is
 * read only when the consumer asks for it, so a caller can process page by page.
 */
export async function* keysetPages<T extends { readonly tenantId: string }>(
  pageSize: number,
  cursorOf: (last: T) => LedgerCursor,
  read: (after: LedgerCursor | null) => Promise<readonly T[]>,
): AsyncGenerator<readonly T[], void, undefined> {
  let after: LedgerCursor | null = null;
  for (;;) {
    const page = await read(after);
    const last = page.at(-1);
    if (last === undefined) return;
    yield page;
    if (page.length < pageSize) return;
    after = cursorOf(last);
  }
}
