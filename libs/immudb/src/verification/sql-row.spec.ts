import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerifiableSQLEntry } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbState } from '../immudb.types.js';
import { u32, u64 } from './bytes.js';
import { decodeRowValue, encodeKeyValue, MAX_KEY_LEN, verifySqlEntry } from './sql-row.js';

interface Vectors {
  states: { txId: string; txHash: string }[];
  sqlEntries: {
    pk: string[];
    rowTxId: string;
    proveSinceTx: string;
    expectedRow: { id: string; amount: string; note: string };
    verifiableSqlEntry: unknown;
  }[];
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../test/vectors/immudb-1.11.2.json'), 'utf8'),
) as Vectors;
const stateAt = (txId: string): ImmudbState => {
  const state = vectors.states.find((s) => s.txId === txId);
  if (state === undefined) throw new Error(`no captured state for tx ${txId}`);
  return {
    database: 'defaultdb',
    txId: BigInt(txId),
    txHash: new Uint8Array(Buffer.from(state.txHash, 'base64')),
    signature: null,
  };
};

describe('SQL row encoding', () => {
  it('encodes VARCHAR, INTEGER and NULL primary keys like EncodeRawValueAsKey', () => {
    expect([...encodeKeyValue('ab', 'VARCHAR', 4)]).toEqual([0x80, 97, 98, 0, 0, 0, 0, 0, 2]);
    expect([...encodeKeyValue(-1n, 'INTEGER', 8)]).toEqual([
      0x80, 0x7f, 255, 255, 255, 255, 255, 255, 255,
    ]);
    expect([...encodeKeyValue(1n, 'INTEGER', 8)]).toEqual([0x80, 0x80, 0, 0, 0, 0, 0, 0, 1]);
    expect([...encodeKeyValue(null, 'VARCHAR', 4)]).toEqual([0x20]);
    expect(() => encodeKeyValue('abcde', 'VARCHAR', 4)).toThrow(/longer/);
    expect(() => encodeKeyValue(true, 'BOOLEAN', 1)).toThrow(/unsupported/);
    expect(() => encodeKeyValue('a', 'VARCHAR', MAX_KEY_LEN + 1)).toThrow(/out of range/);
    expect(encodeKeyValue('a', 'VARCHAR', MAX_KEY_LEN)).toHaveLength(1 + MAX_KEY_LEN + 4);
  });

  it('decodes BOOLEAN, BLOB, TIMESTAMP and UUID columns and fills NULL columns', () => {
    const column = (id: number, bytes: number[]): number[] => [
      ...u32(id),
      ...u32(bytes.length),
      ...bytes,
    ];
    const micros = 1_700_000_000_123_456n;
    const value = Uint8Array.from([
      ...u32(5),
      ...column(1, [1]),
      ...column(2, [0]),
      ...column(3, [0xde, 0xad]),
      ...column(4, [...u64(micros)]),
      ...column(5, [...Buffer.from('0123456789abcdef0123456789abcdef', 'hex')]),
    ]);
    const types = {
      1: 'BOOLEAN',
      2: 'BOOLEAN',
      3: 'BLOB',
      4: 'TIMESTAMP',
      5: 'UUID',
      6: 'VARCHAR',
    };
    const names = { 1: 't', 2: 'f', 3: 'bl', 4: 'ts', 5: 'u', 6: 'missing' };
    expect(decodeRowValue(value, types, names, 6)).toEqual({
      t: true,
      f: false,
      bl: Uint8Array.of(0xde, 0xad),
      ts: new Date(1_700_000_000_123),
      u: '01234567-89ab-cdef-0123-456789abcdef',
      missing: null,
    });
    const corrupt = (id: number, bytes: number[]): Uint8Array =>
      Uint8Array.from([...u32(1), ...column(id, bytes)]);
    expect(() => decodeRowValue(corrupt(1, [1, 0]), types, names, 6)).toThrow(/BOOLEAN/);
    expect(() => decodeRowValue(corrupt(4, [1]), types, names, 6)).toThrow(/TIMESTAMP/);
    expect(() => decodeRowValue(corrupt(5, [1]), types, names, 6)).toThrow(/UUID/);
  });

  it('decodes a row value and skips dropped columns', () => {
    const value = Uint8Array.from([
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      2,
      104,
      105, // col 1 VARCHAR "hi"
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      8,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      254, // col 2 INTEGER -2
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      1,
      1, // col 3 dropped (not in colTypes, <= maxColId)
    ]);
    expect(
      decodeRowValue(value, { 1: 'VARCHAR', 2: 'INTEGER' }, { 1: 'id', 2: 'amount' }, 3),
    ).toEqual({ id: 'hi', amount: -2n });
    expect(() =>
      decodeRowValue(value, { 1: 'VARCHAR', 2: 'INTEGER' }, { 1: 'id', 2: 'amount' }, 2),
    ).toThrow(/corrupted/);
    expect(() => decodeRowValue(value.subarray(0, 10), {}, {}, 3)).toThrow(/corrupted/);
  });
});

describe('verifySqlEntry against immudb 1.11.2 vectors', () => {
  it.each(vectors.sqlEntries.map((v) => [v.proveSinceTx, v.rowTxId, v] as const))(
    'verifies row-3 with a trusted state at tx %s (row tx %s)',
    (proveSinceTx, rowTxId, v) => {
      const entry = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
      const result = verifySqlEntry(entry, v.pk, stateAt(proveSinceTx));
      expect(result.row).toEqual({ id: 'row-3', amount: -150n, note: 'n3' });
      expect(result.txId).toBe(BigInt(rowTxId));
      const newest = BigInt(proveSinceTx) > BigInt(rowTxId) ? proveSinceTx : rowTxId;
      expect(result.state.txId).toBe(BigInt(newest));
      expect(Buffer.from(result.state.txHash).toString('base64')).toBe(
        vectors.states.find((s) => s.txId === newest)?.txHash,
      );
    },
  );

  it('rejects a tampered value, another key and a wrong trusted hash', () => {
    const v = vectors.sqlEntries[0];
    if (v === undefined) throw new Error('no SQL vectors');
    const trusted = stateAt(v.proveSinceTx);
    const tampered = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
    const value = tampered.sqlEntry?.value;
    if (value === undefined) throw new Error('no value');
    value[value.length - 1] = (value[value.length - 1] ?? 0) ^ 1;
    expect(() => verifySqlEntry(tampered, v.pk, trusted)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
    const entry = VerifiableSQLEntry.fromJSON(v.verifiableSqlEntry);
    expect(() => verifySqlEntry(entry, ['row-4'], trusted)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
    const wrongHash = { ...trusted, txHash: new Uint8Array(32) };
    expect(() => verifySqlEntry(entry, v.pk, wrongHash)).toThrow(
      expect.objectContaining({ kind: 'verification-failed' }),
    );
  });
});
