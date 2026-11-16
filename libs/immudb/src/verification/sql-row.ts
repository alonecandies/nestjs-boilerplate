import { ImmudbError } from '../errors/immudb.error.js';
import type { VerifiableSQLEntry } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbRow, ImmudbState, ImmudbValue } from '../immudb.types.js';
import { concat, u32, u64 } from './bytes.js';
import { fromProtoDualProof, verifyDualProof } from './dual-proof.js';
import { entrySpecDigestFor } from './entry-digest.js';
import { verifyHtreeInclusion } from './htree.js';
import { txHeaderAlh } from './tx-header.js';

/** pkg/client/sql.go `SQLPrefix`; embedded/sql/stmt.go `RowPrefix`, `PKIndexID`. */
const SQL_PREFIX = 2;
const ROW_PREFIX = new TextEncoder().encode('R.');
const PK_INDEX_ID = 0;
const KEY_NULL = 0x20;
const KEY_NOT_NULL = 0x80;

function fail(message: string): never {
  throw new ImmudbError('verification-failed', message);
}

/** `EncodeRawValueAsKey` (embedded/sql/catalog.go) for VARCHAR and INTEGER keys. */
export function encodeKeyValue(value: ImmudbValue, type: string, maxLen: number): Uint8Array {
  if (value === null) return Uint8Array.of(KEY_NULL);
  switch (type) {
    case 'VARCHAR': {
      if (typeof value !== 'string') fail('a VARCHAR primary key needs a string');
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > maxLen) fail('primary key value is longer than its column');
      const out = new Uint8Array(1 + maxLen + 4);
      out[0] = KEY_NOT_NULL;
      out.set(bytes, 1);
      out.set(u32(bytes.length), 1 + maxLen);
      return out;
    }
    case 'INTEGER': {
      if (typeof value !== 'bigint' || maxLen !== 8) fail('an INTEGER primary key needs a bigint');
      const out = concat([Uint8Array.of(KEY_NOT_NULL), u64(value)]);
      out[1] = (out[1] ?? 0) ^ 0x80; // lexical order of signed values
      return out;
    }
    default:
      return fail(`unsupported primary key type ${type}`);
  }
}

function decodeValue(raw: Uint8Array, type: string): ImmudbValue {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  switch (type) {
    case 'VARCHAR':
      return new TextDecoder().decode(raw);
    case 'INTEGER':
      return raw.length === 8 ? view.getBigInt64(0) : fail('corrupted INTEGER value');
    case 'BOOLEAN':
      return raw.length === 1 ? raw[0] === 1 : fail('corrupted BOOLEAN value');
    case 'BLOB':
      return new Uint8Array(raw);
    case 'TIMESTAMP':
      return raw.length === 8
        ? new Date(Number(view.getBigInt64(0) / 1_000n))
        : fail('corrupted TIMESTAMP value');
    case 'UUID': {
      if (raw.length !== 16) fail('corrupted UUID value');
      const hex = Buffer.from(raw).toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    default:
      return fail(`unsupported column type ${type}`);
  }
}

/** `decodeRow` (pkg/client/sql.go): u32 count, then (u32 colId, u32 length, value) per column. */
export function decodeRowValue(
  encoded: Uint8Array,
  colTypes: Readonly<Record<number, string>>,
  colNames: Readonly<Record<number, string>>,
  maxColId: number,
): ImmudbRow {
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  let offset = 0;
  const take = (n: number): void => {
    if (offset + n > encoded.length) fail('corrupted row value');
  };
  take(4);
  const count = view.getUint32(offset);
  offset += 4;
  const row: ImmudbRow = {};
  for (let i = 0; i < count; i++) {
    take(8);
    const colId = view.getUint32(offset);
    const length = view.getUint32(offset + 4);
    offset += 8;
    take(length);
    const raw = encoded.subarray(offset, offset + length);
    offset += length;
    const type = colTypes[colId];
    if (type === undefined) {
      if (colId > maxColId) fail('corrupted row value: unknown column');
      continue; // a dropped column
    }
    row[colNames[colId] ?? fail('corrupted row value: unnamed column')] = decodeValue(raw, type);
  }
  return row;
}

/** Port of `immuClient.VerifyRow` (pkg/client/sql.go), returning the proven row instead of comparing. */
export function verifySqlEntry(
  entry: VerifiableSQLEntry,
  pk: readonly ImmudbValue[],
  trusted: ImmudbState,
  verifySignature?: (state: ImmudbState) => boolean,
): { row: ImmudbRow; txId: bigint; state: ImmudbState } {
  const sqlEntry = entry.sqlEntry ?? fail('the server sent no SQL entry');
  const verifiableTx = entry.verifiableTx ?? fail('the server sent no verifiable tx');
  const header = verifiableTx.tx?.header ?? fail('the server sent no tx header');
  const proof = fromProtoDualProof(verifiableTx.dualProof) ?? fail('the server sent no dual proof');
  if (pk.length === 0 || entry.PKIDs.length !== pk.length) fail('primary key arity mismatch');

  const keyParts = pk.map((value, i) => {
    const id = entry.PKIDs[i] ?? fail('missing primary key column');
    const type = entry.ColTypesById[id] ?? fail('missing primary key type');
    const maxLen = entry.ColLenById[id] ?? fail('missing primary key length');
    return encodeKeyValue(value, type, maxLen);
  });
  const key = concat([
    Uint8Array.of(SQL_PREFIX),
    ROW_PREFIX,
    u32(entry.DatabaseId),
    u32(entry.TableId),
    u32(PK_INDEX_ID),
    ...keyParts,
  ]);
  const value = new Uint8Array(sqlEntry.value);
  const row = decodeRowValue(value, entry.ColTypesById, entry.ColNamesById, entry.MaxColId);

  const rowTx = BigInt(sqlEntry.tx);
  const forward = trusted.txId <= rowTx;
  const eh = forward ? proof.targetTxHeader.eh : proof.sourceTxHeader.eh;
  const sourceId = forward ? trusted.txId : rowTx;
  const sourceAlh = forward ? trusted.txHash : txHeaderAlh(proof.sourceTxHeader);
  const targetId = forward ? rowTx : trusted.txId;
  const targetAlh = forward ? txHeaderAlh(proof.targetTxHeader) : trusted.txHash;

  const inclusion = entry.inclusionProof;
  const included = verifyHtreeInclusion(
    inclusion === undefined
      ? null
      : {
          leaf: inclusion.leaf,
          width: inclusion.width,
          terms: inclusion.terms.map((term) => new Uint8Array(term)),
        },
    entrySpecDigestFor(header.version)(key, value),
    eh,
  );
  if (!included) fail(`row is not included in tx ${rowTx}`);
  if (trusted.txId > 0n && !verifyDualProof(proof, sourceId, targetId, sourceAlh, targetAlh)) {
    fail(`no valid dual proof between tx ${sourceId} and tx ${targetId}`);
  }
  const signature = verifiableTx.signature?.signature;
  const state: ImmudbState = {
    database: trusted.database,
    txId: targetId,
    txHash: targetAlh,
    signature: signature !== undefined && signature.length > 0 ? new Uint8Array(signature) : null,
  };
  if (verifySignature !== undefined && !verifySignature(state)) {
    fail(`state signature of tx ${targetId} does not verify`);
  }
  return { row, txId: rowTx, state };
}
