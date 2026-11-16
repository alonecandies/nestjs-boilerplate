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
import { verifyLinearAdvanceProof, verifyLinearProof } from './linear.js';
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

  it('verifies a linear advance proof over a 5-tx chain and rejects every tampered part', () => {
    // alh_1 is arbitrary; alh_k = sha256(k ‖ alh_{k-1} ‖ inner_k) for k = 2..5.
    const inner = (k: number): Uint8Array => d(0x20 + k);
    const alh: Uint8Array[] = [new Uint8Array(0), d(0x01)];
    for (let k = 2; k <= 5; k++) alh[k] = h(u64(BigInt(k)), alh[k - 1] ?? [], inner(k));
    const at = (k: number): Uint8Array => alh[k] ?? new Uint8Array(0);
    // ahtree of size 5 over leafFor(alh_k): root = node(node(node(l1, l2), node(l3, l4)), l5).
    const leaf = (k: number): Uint8Array => h([0], at(k));
    const n12 = h([1], leaf(1), leaf(2));
    const n34 = h([1], leaf(3), leaf(4));
    const root = h([1], h([1], n12, n34), leaf(5));
    // From start 2 to end 5: alh_3, then the inner hashes of tx 4 and 5; inclusion of tx 3 and 4.
    const proof = {
      linearProofTerms: [at(3), inner(4), inner(5)],
      inclusionProofs: [
        [leaf(4), n12, leaf(5)],
        [leaf(3), n12, leaf(5)],
      ],
    };
    const verify = (p: Parameters<typeof verifyLinearAdvanceProof>[0], endAlh = at(5)) =>
      verifyLinearAdvanceProof(p, 2n, 5n, endAlh, root, 5n);
    const flip = (b: Uint8Array): Uint8Array => b.map((byte, i) => (i === 0 ? byte ^ 1 : byte));
    const withTerm = (i: number) => proof.linearProofTerms.map((t, j) => (j === i ? flip(t) : t));

    expect(verify(proof)).toBe(true);
    expect(verify({ ...proof, linearProofTerms: withTerm(0) })).toBe(false);
    expect(verify({ ...proof, linearProofTerms: withTerm(1) })).toBe(false);
    expect(verify({ ...proof, linearProofTerms: withTerm(2) })).toBe(false);
    const [first, second] = proof.inclusionProofs;
    if (first === undefined || second === undefined) throw new Error('missing inclusion proof');
    for (const [i, path] of proof.inclusionProofs.entries()) {
      for (const j of path.keys()) {
        const tampered = path.map((t, k) => (k === j ? flip(t) : t));
        const inclusionProofs = i === 0 ? [tampered, second] : [first, tampered];
        expect(verify({ ...proof, inclusionProofs }), `inclusion ${i} term ${j}`).toBe(false);
      }
    }
    expect(verify({ ...proof, inclusionProofs: [first] })).toBe(false);
    expect(verify({ ...proof, linearProofTerms: proof.linearProofTerms.slice(0, 2) })).toBe(false);
    // Trailing extras are never read by the loop: only the length preconditions refuse them.
    expect(verify({ ...proof, inclusionProofs: [first, second, second] })).toBe(false);
    expect(verify({ ...proof, linearProofTerms: [...proof.linearProofTerms, inner(5)] })).toBe(
      false,
    );
    expect(verify(proof, at(4))).toBe(false);
    expect(verify(null)).toBe(false);
    expect(verifyLinearAdvanceProof(proof, 2n, 5n, at(5), root, 4n)).toBe(false);
    // Nothing to prove for adjacent or equal ids; end before start is refused.
    expect(verifyLinearAdvanceProof(null, 2n, 3n, at(3), root, 5n)).toBe(true);
    expect(verifyLinearAdvanceProof(null, 3n, 2n, at(2), root, 5n)).toBe(false);
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
