import { DomainValidationException } from '@app/common';
import cassandra from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { createFakeCassandraClient } from '../../test/fake-cassandra.js';
import { executePage, MAX_FETCH_SIZE, MAX_PAGE_STATE_LENGTH } from './execute-page.js';

const CQL = 'SELECT id, title FROM notifications_by_user WHERE user_id = ?';
const mapRow = (row: cassandra.types.Row): { id: string; title: string } => ({
  id: String(row.get('id')),
  title: String(row.get('title')),
});

describe('executePage', () => {
  it('runs a prepared, paged query and maps rows + the next page state', async () => {
    const fake = createFakeCassandraClient(() => ({
      rows: [
        { id: 'n2', title: 'b' },
        { id: 'n1', title: 'a' },
      ],
      pageState: '0a0b',
    }));
    const page = await executePage(fake.client, CQL, ['u1'], { fetchSize: 2, mapRow });
    expect(page).toEqual({
      items: [
        { id: 'n2', title: 'b' },
        { id: 'n1', title: 'a' },
      ],
      pageState: '0a0b',
    });
    expect(fake.executed).toEqual([
      { query: CQL, params: ['u1'], options: { prepare: true, fetchSize: 2 } },
    ]);
  });

  it('resumes from a client page state and reports null at the end', async () => {
    const fake = createFakeCassandraClient(() => ({ rows: [{ id: 'n0', title: 'z' }] }));
    const page = await executePage(fake.client, CQL, ['u1'], {
      fetchSize: 2,
      pageState: 'ABCDEF01',
      mapRow,
    });
    expect(page.pageState).toBeNull();
    expect(fake.executed[0]?.options).toMatchObject({ pageState: 'ABCDEF01' });
  });

  it('treats an empty page state as "first page"', async () => {
    const fake = createFakeCassandraClient();
    await executePage(fake.client, CQL, [], { fetchSize: 10, pageState: '', mapRow });
    expect(fake.executed[0]?.options).not.toHaveProperty('pageState');
  });

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [7.8, 7],
    [1_000_000, MAX_FETCH_SIZE],
  ])('clamps fetchSize %d to %d', async (requested, expected) => {
    const fake = createFakeCassandraClient();
    await executePage(fake.client, CQL, [], { fetchSize: requested, mapRow });
    expect(fake.executed[0]?.options?.fetchSize).toBe(expected);
  });

  it('forwards extra query options but never lets them disable prepare or override paging', async () => {
    const fake = createFakeCassandraClient();
    const { consistencies } = cassandra.types;
    await executePage(fake.client, CQL, [], {
      fetchSize: 5,
      mapRow,
      queryOptions: {
        consistency: consistencies.localQuorum,
        isIdempotent: true,
        ...{ prepare: false },
      },
    });
    expect(fake.executed[0]?.options).toEqual({
      consistency: consistencies.localQuorum,
      isIdempotent: true,
      prepare: true,
      fetchSize: 5,
    });
  });

  it.each([
    ['non-hex', 'not-hex!'],
    ['odd length', 'abc'],
    ['too long', 'ab'.repeat(MAX_PAGE_STATE_LENGTH)],
  ])('rejects a %s page state with 422 INVALID_PAGE_STATE without querying', async (_l, state) => {
    const fake = createFakeCassandraClient();
    const attempt = executePage(fake.client, CQL, [], { fetchSize: 5, pageState: state, mapRow });
    await expect(attempt).rejects.toBeInstanceOf(DomainValidationException);
    await expect(attempt).rejects.toMatchObject({
      code: 'INVALID_PAGE_STATE',
      httpStatus: 422,
      issues: [{ path: 'pageState', message: 'Page state is malformed' }],
    });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('maps a server-side paging-state rejection to 422 (state from another query)', async () => {
    const fake = createFakeCassandraClient(() => {
      throw new Error('Invalid value for the paging state');
    });
    await expect(
      executePage(fake.client, CQL, [], { fetchSize: 5, pageState: 'deadbeef', mapRow }),
    ).rejects.toMatchObject({ code: 'INVALID_PAGE_STATE', httpStatus: 422 });
  });

  it('rethrows other driver errors untouched', async () => {
    const failure = new Error('NoHostAvailableError: All host(s) tried for query failed');
    const fake = createFakeCassandraClient(() => {
      throw failure;
    });
    await expect(
      executePage(fake.client, CQL, [], { fetchSize: 5, pageState: 'deadbeef', mapRow }),
    ).rejects.toBe(failure);
  });
});
