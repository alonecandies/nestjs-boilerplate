import { describe, expect, it } from 'vitest';
import {
  ImmuServiceClient,
  NewTxRequest,
  SQLQueryRequest,
  SQLValue,
  TxMode,
} from '../src/generated/immudb/schema/schema.pb.js';
import { IMMUDB_SERVER_VERSION, IMMUDB_TEST_IMAGE } from '../src/index.js';

describe('generated immudb client', () => {
  it('targets the pinned server version', () => {
    expect(IMMUDB_TEST_IMAGE).toBe(`codenotary/immudb:${IMMUDB_SERVER_VERSION}`);
  });

  it.each([
    ['openSession', '/immudb.schema.ImmuService/OpenSession'],
    ['newTx', '/immudb.schema.ImmuService/NewTx'],
    ['txSqlExec', '/immudb.schema.ImmuService/TxSQLExec'],
    ['txSqlQuery', '/immudb.schema.ImmuService/TxSQLQuery'],
    ['commit', '/immudb.schema.ImmuService/Commit'],
    ['rollback', '/immudb.schema.ImmuService/Rollback'],
    ['currentState', '/immudb.schema.ImmuService/CurrentState'],
    ['verifiableTxById', '/immudb.schema.ImmuService/VerifiableTxById'],
    ['verifiableSqlGet', '/immudb.schema.ImmuService/VerifiableSQLGet'],
    ['changeSqlPrivileges', '/immudb.schema.ImmuService/ChangeSQLPrivileges'],
    ['createDatabaseV2', '/immudb.schema.ImmuService/CreateDatabaseV2'],
  ] as const)('%s calls %s', (method, path) => {
    expect(ImmuServiceClient.service[method].path).toBe(path);
  });

  it('round-trips int64 beyond 2^53 and negatives as decimal strings', () => {
    for (const n of ['9007199254740993', '-9007199254740993', '-1']) {
      const wire = SQLValue.encode({ value: { $case: 'n', value: n } }).finish();
      expect(SQLValue.decode(wire)).toEqual({ value: { $case: 'n', value: n } });
    }
  });

  it('fills scalar defaults with fromPartial and never sets deprecated fields', () => {
    expect(NewTxRequest.fromPartial({ mode: TxMode.ReadWrite })).toEqual({
      mode: 'ReadWrite',
      unsafeMVCC: false,
    });
    expect(SQLQueryRequest.fromPartial({ sql: 'SELECT 1' })).toMatchObject({
      sql: 'SELECT 1',
      params: [],
      acceptStream: false,
    });
  });
});
