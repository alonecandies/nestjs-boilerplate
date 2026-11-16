import { equalBytes, LEAF_PREFIX, node, sha256 } from './bytes.js';

export interface InclusionProofData {
  readonly leaf: number;
  readonly width: number;
  readonly terms: readonly Uint8Array[];
}

/** Port of htree.VerifyInclusion (immudb v1.9DOM.1 embedded/htree/htree.go). */
export function verifyHtreeInclusion(
  proof: InclusionProofData | null,
  digest: Uint8Array,
  root: Uint8Array,
): boolean {
  if (proof === null) return false;
  let calc = sha256(Uint8Array.of(LEAF_PREFIX), digest);
  let i = proof.leaf;
  let r = proof.width - 1;
  for (const term of proof.terms) {
    calc = i % 2 === 0 && i !== r ? node(calc, term) : node(term, calc);
    i = Math.trunc(i / 2);
    r = Math.trunc(r / 2);
  }
  return i === r && equalBytes(root, calc);
}
