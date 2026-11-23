import type { LedgerSystemRepository } from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import type { RunEntryRefs } from '../reconcile-ledger.command.js';
import { keysetPages } from './keyset-pages.js';

type RefLister = Pick<LedgerSystemRepository, 'listEntryRefs'>;

/** Every ref of all tenants posted in `[from, to)`, read page by page (`pageSize`). */
export async function listAllEntryRefs(
  system: RefLister,
  from: Date,
  to: Date,
  pageSize: number,
): Promise<LedgerEntryRef[]> {
  const refs: LedgerEntryRef[] = [];
  for await (const page of keysetPages(
    pageSize,
    (last: LedgerEntryRef) => ({ tenantId: last.tenantId, id: last.entryId }),
    (after) => system.listEntryRefs(from, to, after, pageSize),
  )) {
    refs.push(...page);
  }
  return refs;
}

/**
 * The refs of one reconciliation run, read once (`ReconciliationContext.entryRefs`): the first
 * call takes `readAt = now` and lists every ref posted in `[from, readAt)`; later calls resolve
 * with the same read. Only a successful read is kept: after a failure the next call reads again,
 * so a check whose read failed does not take the next check down with it.
 */
export function memoizedEntryRefs(
  system: RefLister,
  from: Date,
  pageSize: number,
): () => Promise<RunEntryRefs> {
  let read: Promise<RunEntryRefs> | undefined;
  return () => {
    read ??= (async () => {
      const readAt = new Date();
      return { readAt, rows: await listAllEntryRefs(system, from, readAt, pageSize) };
    })().catch((error: unknown) => {
      read = undefined;
      throw error;
    });
    return read;
  };
}
