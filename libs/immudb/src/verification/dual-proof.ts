import type { DualProof } from '../generated/immudb/schema/schema.pb.js';
import {
  verifyAhtreeConsistency,
  verifyAhtreeInclusion,
  verifyAhtreeLastInclusion,
} from './ahtree.js';
import { equalBytes, leafFor } from './bytes.js';
import {
  type LinearAdvanceProofData,
  type LinearProofData,
  verifyLinearAdvanceProof,
  verifyLinearProof,
} from './linear.js';
import { fromProtoTxHeader, type TxHeaderData, txHeaderAlh } from './tx-header.js';

export interface DualProofData {
  readonly sourceTxHeader: TxHeaderData;
  readonly targetTxHeader: TxHeaderData;
  readonly inclusionProof: readonly Uint8Array[];
  readonly consistencyProof: readonly Uint8Array[];
  readonly targetBlTxAlh: Uint8Array;
  readonly lastInclusionProof: readonly Uint8Array[];
  readonly linearProof: LinearProofData | null;
  readonly linearAdvanceProof: LinearAdvanceProofData | null;
}

const bytes = (list: readonly Uint8Array[]): Uint8Array[] => list.map((b) => new Uint8Array(b));

const DIGEST_LENGTH = 32;
const isDigest = (b: Uint8Array): boolean => b.length === DIGEST_LENGTH;
const headerDigests = (h: TxHeaderData): Uint8Array[] => [h.prevAlh, h.eh, h.blRoot];

/**
 * Every digest a dual proof carries is 32 bytes. Go's DigestFromProto copies into a fixed array;
 * here a wrong length fails closed (null) so a header cannot be re-split with the same Alh.
 */
function hasDigestLengths(proof: DualProofData): boolean {
  const digests = [
    ...headerDigests(proof.sourceTxHeader),
    ...headerDigests(proof.targetTxHeader),
    proof.targetBlTxAlh,
    ...proof.inclusionProof,
    ...proof.consistencyProof,
    ...proof.lastInclusionProof,
    ...(proof.linearProof?.terms ?? []),
    ...(proof.linearAdvanceProof?.linearProofTerms ?? []),
    ...(proof.linearAdvanceProof?.inclusionProofs.flat() ?? []),
  ];
  return digests.every(isDigest);
}

export function fromProtoDualProof(proof: DualProof | undefined): DualProofData | null {
  if (proof?.sourceTxHeader === undefined || proof.targetTxHeader === undefined) return null;
  const mapped = mapDualProof(proof, proof.sourceTxHeader, proof.targetTxHeader);
  return hasDigestLengths(mapped) ? mapped : null;
}

function mapDualProof(
  proof: DualProof,
  sourceTxHeader: NonNullable<DualProof['sourceTxHeader']>,
  targetTxHeader: NonNullable<DualProof['targetTxHeader']>,
): DualProofData {
  const linear = proof.linearProof;
  const advance = proof.LinearAdvanceProof;
  return {
    sourceTxHeader: fromProtoTxHeader(sourceTxHeader),
    targetTxHeader: fromProtoTxHeader(targetTxHeader),
    inclusionProof: bytes(proof.inclusionProof),
    consistencyProof: bytes(proof.consistencyProof),
    targetBlTxAlh: new Uint8Array(proof.targetBlTxAlh),
    lastInclusionProof: bytes(proof.lastInclusionProof),
    linearProof:
      linear === undefined
        ? null
        : {
            sourceTxId: BigInt(linear.sourceTxId),
            targetTxId: BigInt(linear.TargetTxId),
            terms: bytes(linear.terms),
          },
    linearAdvanceProof:
      advance === undefined
        ? null
        : {
            linearProofTerms: bytes(advance.linearProofTerms),
            inclusionProofs: advance.inclusionProofs.map((p) => bytes(p.terms)),
          },
  };
}

/** Port of store.VerifyDualProof (immudb v1.9DOM.1 embedded/store/verification.go). */
export function verifyDualProof(
  proof: DualProofData | null,
  sourceTxId: bigint,
  targetTxId: bigint,
  sourceAlh: Uint8Array,
  targetAlh: Uint8Array,
): boolean {
  if (
    proof === null ||
    proof.sourceTxHeader.id !== sourceTxId ||
    proof.targetTxHeader.id !== targetTxId
  ) {
    return false;
  }
  const source = proof.sourceTxHeader;
  const target = proof.targetTxHeader;
  if (source.id === 0n || source.id > target.id) return false;
  if (!equalBytes(sourceAlh, txHeaderAlh(source))) return false;
  if (!equalBytes(targetAlh, txHeaderAlh(target))) return false;

  if (
    sourceTxId < target.blTxId &&
    !verifyAhtreeInclusion(
      proof.inclusionProof,
      sourceTxId,
      target.blTxId,
      leafFor(sourceAlh),
      target.blRoot,
    )
  ) {
    return false;
  }
  if (
    source.blTxId > 0n &&
    !verifyAhtreeConsistency(
      proof.consistencyProof,
      source.blTxId,
      target.blTxId,
      source.blRoot,
      target.blRoot,
    )
  ) {
    return false;
  }
  if (
    target.blTxId > 0n &&
    !verifyAhtreeLastInclusion(
      proof.lastInclusionProof,
      target.blTxId,
      leafFor(proof.targetBlTxAlh),
      target.blRoot,
    )
  ) {
    return false;
  }
  if (sourceTxId < target.blTxId) {
    return (
      verifyLinearProof(
        proof.linearProof,
        target.blTxId,
        targetTxId,
        proof.targetBlTxAlh,
        targetAlh,
      ) &&
      verifyLinearAdvanceProof(
        proof.linearAdvanceProof,
        source.blTxId,
        sourceTxId,
        sourceAlh,
        target.blRoot,
        target.blTxId,
      )
    );
  }
  return (
    verifyLinearProof(proof.linearProof, sourceTxId, targetTxId, sourceAlh, targetAlh) &&
    verifyLinearAdvanceProof(
      proof.linearAdvanceProof,
      source.blTxId,
      target.blTxId,
      proof.targetBlTxAlh,
      target.blRoot,
      target.blTxId,
    )
  );
}
