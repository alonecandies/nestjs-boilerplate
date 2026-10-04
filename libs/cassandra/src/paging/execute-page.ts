import { DomainValidationException } from '@app/common';
import type cassandra from 'cassandra-driver';
import { clamp, get, isNil } from 'lodash-es';
import type { CassandraClient, CqlParams } from '../cassandra.types.js';

/** Driver paging states are small hex blobs; anything longer is not one of ours. */
export const MAX_PAGE_STATE_LENGTH = 2_048;
/** Hard ceiling for a single page (protects the coordinator and our heap). */
export const MAX_FETCH_SIZE = 5_000;

const HEX = /^(?:[0-9a-f]{2})+$/i;

export interface ExecutePageOptions<T> {
  /** Rows per page (clamped to `[1, MAX_FETCH_SIZE]`). */
  fetchSize: number;
  /** Opaque token from a previous page's `pageState` (client-supplied → validated). */
  pageState?: string | null;
  mapRow: (row: cassandra.types.Row) => T;
  /** Extra per-query options (consistency, isIdempotent, readTimeout…). */
  queryOptions?: Omit<cassandra.QueryOptions, 'fetchSize' | 'pageState' | 'autoPage' | 'prepare'>;
}

export interface CassandraPage<T> {
  items: T[];
  /** Pass back to fetch the next page; `null` = no more pages. */
  pageState: string | null;
}

const invalidPageState = (message: string, cause?: unknown): DomainValidationException =>
  new DomainValidationException('Invalid page state', {
    code: 'INVALID_PAGE_STATE',
    issues: [{ path: 'pageState', message }],
    cause,
  });

/**
 * One page of a prepared query using the driver's native paging (`pageState`) — O(page) on the
 * coordinator regardless of depth, no OFFSET-style re-scans. The page state is only valid for
 * the exact same query + params; a garbage/forged token is a 422 `INVALID_PAGE_STATE`, not a 500.
 * Note: when the partition ends exactly on a page boundary the driver still returns a state and
 * the following page is empty — clients must treat an empty page with `null` state as the end.
 */
export async function executePage<T>(
  client: CassandraClient,
  cql: string,
  params: CqlParams,
  options: ExecutePageOptions<T>,
): Promise<CassandraPage<T>> {
  const { pageState } = options;
  if (!isNil(pageState) && pageState !== '') {
    if (pageState.length > MAX_PAGE_STATE_LENGTH || !HEX.test(pageState)) {
      throw invalidPageState('Page state is malformed');
    }
  }
  let rs: cassandra.types.ResultSet;
  try {
    rs = await client.execute(cql, params, {
      ...options.queryOptions,
      prepare: true,
      fetchSize: clamp(Math.trunc(options.fetchSize) || 1, 1, MAX_FETCH_SIZE),
      ...(isNil(pageState) || pageState === '' ? {} : { pageState }),
    });
  } catch (error) {
    // Well-formed hex that the server can't decode (another query's state, tampered bytes).
    const message: unknown = get(error, 'message');
    if (!isNil(pageState) && typeof message === 'string' && /paging state/i.test(message)) {
      throw invalidPageState('Page state does not belong to this query', error);
    }
    throw error;
  }
  return { items: rs.rows.map(options.mapRow), pageState: rs.pageState ?? null };
}
