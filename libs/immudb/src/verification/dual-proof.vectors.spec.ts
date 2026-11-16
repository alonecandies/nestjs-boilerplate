import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerifiableTx } from '../generated/immudb/schema/schema.pb.js';
import { equalBytes } from './bytes.js';
import { type DualProofData, fromProtoDualProof, verifyDualProof } from './dual-proof.js';
import { txHeaderAlh } from './tx-header.js';

interface Vectors {
  states: { txId: string; txHash: string }[];
  dualProofs: { sourceTxId: string; targetTxId: string; verifiableTx: unknown }[];
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../test/vectors/immudb-1.11.2.json'), 'utf8'),
) as Vectors;
const hashOf = (txId: bigint): Uint8Array => {
  const state = vectors.states.find((s) => BigInt(s.txId) === txId);
  if (state === undefined) throw new Error(`no captured state for tx ${txId}`);
  return new Uint8Array(Buffer.from(state.txHash, 'base64'));
};

/** Every non-empty byte array of the proof, depth-first, with its path. */
function byteLeaves(
  value: unknown,
  path: string,
  out: [string, Uint8Array][] = [],
): [string, Uint8Array][] {
  if (value instanceof Uint8Array) {
    if (value.length > 0) out.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      byteLeaves(item, `${path}[${i}]`, out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      byteLeaves(item, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/** Whether VerifyDualProof reads the component at `path` for this pair (same branches as the Go code). */
function isRead(path: string, proof: DualProofData, source: bigint): boolean {
  const s = proof.sourceTxHeader;
  const t = proof.targetTxHeader;
  if (path.startsWith('inclusionProof')) return source < t.blTxId;
  if (path.startsWith('consistencyProof')) return s.blTxId > 0n;
  if (path.startsWith('lastInclusionProof') || path === 'targetBlTxAlh') return t.blTxId > 0n;
  if (path.startsWith('linearAdvanceProof')) {
    return source < t.blTxId ? source > s.blTxId + 1n : t.blTxId > s.blTxId + 1n;
  }
  return true; // headers (all bytes feed the Alh) and the linear proof
}

describe('VerifyDualProof against immudb 1.11.2 vectors', () => {
  const cases = vectors.dualProofs.map((v) => ({
    source: BigInt(v.sourceTxId),
    target: BigInt(v.targetTxId),
    raw: VerifiableTx.fromJSON(v.verifiableTx),
  }));

  it('captured at least one same-tx, one adjacent and one distant pair', () => {
    expect(cases.some((c) => c.source === c.target)).toBe(true);
    expect(cases.some((c) => c.source === c.target - 1n)).toBe(true);
    expect(cases.some((c) => c.source < c.target - 2n)).toBe(true);
  });

  it.each(vectors.dualProofs.map((v) => [v.sourceTxId, v.targetTxId]))(
    'oracle: Alh of the headers %s → %s equals the states the server reported',
    (source, target) => {
      const c = cases.find((x) => x.source === BigInt(source) && x.target === BigInt(target));
      const proof = fromProtoDualProof(c?.raw.dualProof);
      expect(proof).not.toBeNull();
      if (proof === null) return;
      expect(equalBytes(txHeaderAlh(proof.targetTxHeader), hashOf(BigInt(target)))).toBe(true);
      expect(equalBytes(txHeaderAlh(proof.sourceTxHeader), hashOf(BigInt(source)))).toBe(true);
    },
  );

  it('accepts every captured proof', () => {
    for (const c of cases) {
      const proof = fromProtoDualProof(c.raw.dualProof);
      expect(verifyDualProof(proof, c.source, c.target, hashOf(c.source), hashOf(c.target))).toBe(
        true,
      );
    }
  });

  it('rejects a flipped byte in every component the verifier reads', () => {
    for (const c of cases) {
      const proof = fromProtoDualProof(c.raw.dualProof);
      if (proof === null) throw new Error('missing dual proof');
      const leaves = byteLeaves(proof, '');
      expect(leaves.length).toBeGreaterThan(0);
      leaves.forEach(([path], index) => {
        if (!isRead(path, proof, c.source)) return;
        const tampered = structuredClone(proof);
        const leaf = byteLeaves(tampered, '')[index]?.[1];
        if (leaf === undefined) throw new Error(`lost leaf ${path}`);
        leaf[0] = (leaf[0] ?? 0) ^ 1;
        const ok = verifyDualProof(
          tampered,
          c.source,
          c.target,
          hashOf(c.source),
          hashOf(c.target),
        );
        expect.soft(ok, `${c.source}→${c.target} ${path}`).toBe(false);
      });
    }
  });

  it('rejects wrong ids, swapped direction, tx 0 and a missing proof', () => {
    const c = cases.find((x) => x.source < x.target - 2n);
    if (c === undefined) throw new Error('no distant pair');
    const proof = fromProtoDualProof(c.raw.dualProof);
    const ok = (s: bigint, t: bigint, p = proof) =>
      verifyDualProof(p, s, t, hashOf(c.source), hashOf(c.target));
    expect(ok(c.source + 1n, c.target)).toBe(false);
    expect(ok(c.target, c.source)).toBe(false);
    expect(verifyDualProof(proof, 0n, c.target, hashOf(c.source), hashOf(c.target))).toBe(false);
    expect(ok(c.source, c.target, null)).toBe(false);
    expect(verifyDualProof(proof, c.source, c.target, hashOf(c.target), hashOf(c.target))).toBe(
      false,
    );
  });
});
