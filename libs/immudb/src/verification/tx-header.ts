import { ImmudbError } from '../errors/immudb.error.js';
import type { TxHeader } from '../generated/immudb/schema/schema.pb.js';
import { concat, sha256, u16, u32, u64 } from './bytes.js';

export interface TxHeaderData {
  readonly id: bigint;
  readonly prevAlh: Uint8Array;
  readonly ts: bigint;
  readonly version: number;
  readonly metadata: { readonly truncatedTxId: bigint; readonly extra: Uint8Array } | null;
  readonly nEntries: number;
  readonly eh: Uint8Array;
  readonly blTxId: bigint;
  readonly blRoot: Uint8Array;
}

/** `TxMetadataFromProto` + `TxMetadata.Bytes()`: attribute 0 truncatedTxId, 1 extra. */
function txMetadataBytes(metadata: TxHeaderData['metadata']): Uint8Array {
  if (metadata === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  if (metadata.truncatedTxId > 0n) parts.push(Uint8Array.of(0), u64(metadata.truncatedTxId));
  if (metadata.extra.length > 0) {
    parts.push(Uint8Array.of(1), u16(metadata.extra.length), metadata.extra);
  }
  return concat(parts);
}

export function fromProtoTxHeader(header: TxHeader): TxHeaderData {
  return {
    id: BigInt(header.id),
    prevAlh: new Uint8Array(header.prevAlh),
    ts: BigInt(header.ts),
    version: header.version,
    metadata:
      header.metadata === undefined
        ? null
        : {
            truncatedTxId: BigInt(header.metadata.truncatedTxID),
            extra: new Uint8Array(header.metadata.extra),
          },
    nEntries: header.nentries,
    eh: new Uint8Array(header.eH),
    blTxId: BigInt(header.blTxId),
    blRoot: new Uint8Array(header.blRoot),
  };
}

/** `TxHeader.innerHash` (embedded/store/tx.go). */
function innerHash(header: TxHeaderData): Uint8Array {
  const parts: Uint8Array[] = [u64(header.ts), u16(header.version)];
  switch (header.version) {
    case 0:
      parts.push(u16(header.nEntries));
      break;
    case 1: {
      const metadata = txMetadataBytes(header.metadata);
      parts.push(u16(metadata.length), metadata, u32(header.nEntries));
      break;
    }
    default:
      throw new ImmudbError(
        'verification-failed',
        `unsupported immudb tx header version ${header.version}`,
      );
  }
  parts.push(header.eh, u64(header.blTxId), header.blRoot);
  return sha256(...parts);
}

/** `TxHeader.Alh`: sha256(id ‖ prevAlh ‖ innerHash). */
export function txHeaderAlh(header: TxHeaderData): Uint8Array {
  return sha256(u64(header.id), header.prevAlh, innerHash(header));
}
