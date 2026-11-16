import { createHash } from 'node:crypto';

/** Prefixes of immudb's Merkle trees (htree and ahtree): leaf 0, inner node 1. */
export const LEAF_PREFIX = 0;
export const NODE_PREFIX = 1;

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u16(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n);
  return out;
}

export function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** 8 bytes big-endian; negative values as two's complement (Go `uint64(int64)`). */
export function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, n));
  return out;
}

/** `leafFor` (store/verification.go): an ahtree leaf over an Alh. */
export function leafFor(digest: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(LEAF_PREFIX), digest);
}

export function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(NODE_PREFIX), left, right);
}
