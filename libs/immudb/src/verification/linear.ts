import { verifyAhtreeInclusion } from './ahtree.js';
import { equalBytes, leafFor, sha256, u64 } from './bytes.js';

export interface LinearProofData {
  readonly sourceTxId: bigint;
  readonly targetTxId: bigint;
  readonly terms: readonly Uint8Array[];
}

export interface LinearAdvanceProofData {
  readonly linearProofTerms: readonly Uint8Array[];
  readonly inclusionProofs: readonly (readonly Uint8Array[])[];
}

/** hash(txId ‖ alh ‖ innerHash). */
export function advanceLinearHash(alh: Uint8Array, txId: bigint, term: Uint8Array): Uint8Array {
  return sha256(u64(txId), alh, term);
}

export function verifyLinearProof(
  proof: LinearProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean {
  if (proof === null || proof.sourceTxId !== sourceTxId || proof.targetTxId !== targetTxId) {
    return false;
  }
  const [first, ...rest] = proof.terms;
  if (
    proof.sourceTxId === 0n ||
    proof.sourceTxId > proof.targetTxId ||
    first === undefined ||
    !equalBytes(sourceAlh, first)
  ) {
    return false;
  }
  if (BigInt(proof.terms.length) !== targetTxId - sourceTxId + 1n) return false;
  let calculated = first;
  rest.forEach((term, i) => {
    calculated = advanceLinearHash(calculated, proof.sourceTxId + BigInt(i + 1), term);
  });
  return equalBytes(targetAlh, calculated);
}

export function verifyLinearAdvanceProof(
  proof: LinearAdvanceProofData | null,
  startTxId: bigint,
  endTxId: bigint,
  endAlh: Uint8Array,
  treeRoot: Uint8Array,
  treeSize: bigint,
): boolean {
  if (endTxId < startTxId) return false;
  if (endTxId <= startTxId + 1n) return true;
  if (
    proof === null ||
    BigInt(proof.linearProofTerms.length) !== endTxId - startTxId ||
    BigInt(proof.inclusionProofs.length) !== endTxId - startTxId - 1n
  ) {
    return false;
  }
  let calculated = proof.linearProofTerms[0];
  for (let txId = startTxId + 1n; txId < endTxId; txId++) {
    const k = Number(txId - startTxId);
    const inclusion = proof.inclusionProofs[k - 1];
    const term = proof.linearProofTerms[k];
    if (calculated === undefined || inclusion === undefined || term === undefined) return false;
    if (!verifyAhtreeInclusion(inclusion, txId, treeSize, leafFor(calculated), treeRoot)) {
      return false;
    }
    calculated = advanceLinearHash(calculated, txId + 1n, term);
  }
  return calculated !== undefined && equalBytes(calculated, endAlh);
}
