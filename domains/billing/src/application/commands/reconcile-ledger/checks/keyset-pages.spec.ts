import { describe, expect, it, vi } from 'vitest';
import type { LedgerCursor } from '../../../repositories/ledger.system-repository.js';
import { keysetPages } from './keyset-pages.js';

interface Row {
  readonly tenantId: string;
  readonly entryId: string;
}

const row = (n: number): Row => ({ tenantId: 'tenant', entryId: `entry-${n}` });
const cursorOf = (last: Row): LedgerCursor => ({ tenantId: last.tenantId, id: last.entryId });

async function collect<T>(pages: AsyncIterable<readonly T[]>): Promise<T[][]> {
  const out: T[][] = [];
  for await (const page of pages) out.push([...page]);
  return out;
}

describe('keysetPages', () => {
  it('asks for page 2 with the last row of page 1 as the cursor, starting from null', async () => {
    const read = vi
      .fn<(after: LedgerCursor | null) => Promise<readonly Row[]>>()
      .mockResolvedValueOnce([row(1), row(2)])
      .mockResolvedValueOnce([row(3)]);

    const pages = await collect(keysetPages(2, cursorOf, read));

    expect(pages).toEqual([[row(1), row(2)], [row(3)]]);
    expect(read).toHaveBeenNthCalledWith(1, null);
    expect(read).toHaveBeenNthCalledWith(2, { tenantId: 'tenant', id: 'entry-2' });
  });

  it('stops after a short page and never asks for another', async () => {
    const read = vi
      .fn<(after: LedgerCursor | null) => Promise<readonly Row[]>>()
      .mockResolvedValue([row(1)]);

    const pages = await collect(keysetPages(2, cursorOf, read));

    expect(pages).toEqual([[row(1)]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page without yielding it', async () => {
    const read = vi
      .fn<(after: LedgerCursor | null) => Promise<readonly Row[]>>()
      .mockResolvedValueOnce([row(1), row(2)])
      .mockResolvedValueOnce([]);

    const pages = await collect(keysetPages(2, cursorOf, read));

    expect(pages).toEqual([[row(1), row(2)]]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('yields nothing when the first page is empty', async () => {
    const read = vi
      .fn<(after: LedgerCursor | null) => Promise<readonly Row[]>>()
      .mockResolvedValue([]);

    expect(await collect(keysetPages(2, cursorOf, read))).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads the next page only when the consumer asks for it', async () => {
    const read = vi
      .fn<(after: LedgerCursor | null) => Promise<readonly Row[]>>()
      .mockResolvedValue([row(1), row(2)]);

    for await (const _page of keysetPages(2, cursorOf, read)) break;

    expect(read).toHaveBeenCalledTimes(1);
  });
});
