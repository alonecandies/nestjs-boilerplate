import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyAhtreeConsistency,
  verifyAhtreeInclusion,
  verifyAhtreeLastInclusion,
} from './ahtree.js';
import { equalBytes, leafFor, sha256, u64 } from './bytes.js';
import { entrySpecDigestFor } from './entry-digest.js';
import { verifyHtreeInclusion } from './htree.js';
import { verifyLinearProof } from './linear.js';
import { type TxHeaderData, txHeaderAlh } from './tx-header.js';

const h = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Uint8Array.from(part));
  return new Uint8Array(hash.digest());
};
const d = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('verification primitives', () => {
  it('encodes integers big-endian, negatives as two’s complement', () => {
    expect([...u64(1n)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...u64(-1n)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it('hashes leaves with prefix 0 and nodes with prefix 1', () => {
    expect(equalBytes(leafFor(d(7)), h([0], d(7)))).toBe(true);
    expect(equalBytes(sha256(d(1), d(2)), h(d(1), d(2)))).toBe(true);
  });

  it('verifies htree inclusion in a two-leaf tree and rejects the wrong side', () => {
    const l0 = h([0], d(1));
    const l1 = h([0], d(2));
    const root = h([1], l0, l1);
    expect(verifyHtreeInclusion({ leaf: 0, width: 2, terms: [l1] }, d(1), root)).toBe(true);
    expect(verifyHtreeInclusion({ leaf: 1, width: 2, terms: [l0] }, d(2), root)).toBe(true);
    expect(verifyHtreeInclusion({ leaf: 1, width: 2, terms: [l1] }, d(1), root)).toBe(false);
    expect(verifyHtreeInclusion(null, d(1), root)).toBe(false);
  });

  it('verifies ahtree inclusion, consistency and last inclusion for sizes 1..2', () => {
    const a = leafFor(d(1));
    const b = leafFor(d(2));
    const root2 = h([1], a, b);
    expect(verifyAhtreeInclusion([], 1n, 1n, a, a)).toBe(true);
    expect(verifyAhtreeInclusion([b], 1n, 2n, a, root2)).toBe(true);
    expect(verifyAhtreeInclusion([a], 2n, 2n, b, root2)).toBe(true);
    expect(verifyAhtreeInclusion([], 1n, 2n, a, root2)).toBe(false);
    expect(verifyAhtreeInclusion([b], 0n, 2n, a, root2)).toBe(false);
    expect(verifyAhtreeConsistency([], 2n, 2n, root2, root2)).toBe(true);
    expect(verifyAhtreeConsistency([a, b], 1n, 2n, a, root2)).toBe(true);
    expect(verifyAhtreeConsistency([a, b], 2n, 1n, a, root2)).toBe(false);
    expect(verifyAhtreeLastInclusion([a], 2n, b, root2)).toBe(true);
    expect(verifyAhtreeLastInclusion([a], 0n, b, root2)).toBe(false);
  });

  it('computes Alh = sha256(id ‖ prevAlh ‖ innerHash) for header versions 0 and 1', () => {
    const base: TxHeaderData = {
      id: 5n,
      prevAlh: d(9),
      ts: 1_794_182_400n,
      version: 1,
      metadata: null,
      nEntries: 2,
      eh: d(3),
      blTxId: 4n,
      blRoot: d(4),
    };
    const v1Inner = h(u64(base.ts), [0, 1], [0, 0], [0, 0, 0, 2], d(3), u64(4n), d(4));
    expect(equalBytes(txHeaderAlh(base), h(u64(5n), d(9), v1Inner))).toBe(true);
    const v0Inner = h(u64(base.ts), [0, 0], [0, 2], d(3), u64(4n), d(4));
    expect(equalBytes(txHeaderAlh({ ...base, version: 0 }), h(u64(5n), d(9), v0Inner))).toBe(true);
    const md = { truncatedTxId: 3n, extra: Uint8Array.from([7]) };
    const mdBytes = [0, ...u64(3n), 1, 0, 1, 7];
    const mdInner = h(
      u64(base.ts),
      [0, 1],
      [0, mdBytes.length],
      mdBytes,
      [0, 0, 0, 2],
      d(3),
      u64(4n),
      d(4),
    );
    expect(equalBytes(txHeaderAlh({ ...base, metadata: md }), h(u64(5n), d(9), mdInner))).toBe(
      true,
    );
    expect(() => txHeaderAlh({ ...base, version: 2 })).toThrow(/version 2/);
  });

  it('verifies a linear proof by advancing Alh with each inner hash', () => {
    const term = d(8);
    const target = h(u64(2n), d(1), term);
    const proof = { sourceTxId: 1n, targetTxId: 2n, terms: [d(1), term] };
    expect(verifyLinearProof(proof, 1n, 2n, d(1), target)).toBe(true);
    expect(verifyLinearProof(proof, 1n, 2n, d(2), target)).toBe(false);
    expect(verifyLinearProof({ ...proof, terms: [d(1)] }, 1n, 2n, d(1), target)).toBe(false);
  });

  it('digests SQL entries per tx version', () => {
    const key = Uint8Array.from([1, 2]);
    const value = Uint8Array.from([3]);
    expect(equalBytes(entrySpecDigestFor(0)(key, value), h(key, h(value)))).toBe(true);
    expect(equalBytes(entrySpecDigestFor(1)(key, value), h([0, 0], [0, 2], key, h(value)))).toBe(
      true,
    );
    expect(() => entrySpecDigestFor(9)).toThrow(/version 9/);
  });
});
