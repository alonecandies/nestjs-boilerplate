import { equalBytes, node } from './bytes.js';

/** Ports of immudb v1.9DOM.1 embedded/ahtree/verification.go (tx ids are uint64 → bigint). */
export function evalAhtreeInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  leaf: Uint8Array,
): Uint8Array {
  let i1 = i - 1n;
  let j1 = j - 1n;
  let root = leaf;
  for (const h of proof) {
    root = i1 % 2n === 0n && i1 !== j1 ? node(root, h) : node(h, root);
    i1 >>= 1n;
    j1 >>= 1n;
  }
  return root;
}

export function verifyAhtreeInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean {
  if (i > j || i === 0n || (i < j && proof.length === 0)) return false;
  return equalBytes(root, evalAhtreeInclusion(proof, i, j, leaf));
}

export function evalAhtreeConsistency(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
): [Uint8Array, Uint8Array] {
  let fn = i - 1n;
  let sn = j - 1n;
  while (fn % 2n === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  const [first, ...rest] = proof;
  if (first === undefined) return [new Uint8Array(0), new Uint8Array(0)];
  let ciRoot = first;
  let cjRoot = first;
  for (const h of rest) {
    if (fn % 2n === 1n || fn === sn) {
      ciRoot = node(h, ciRoot);
      cjRoot = node(h, cjRoot);
      while (fn % 2n === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      cjRoot = node(cjRoot, h);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return [ciRoot, cjRoot];
}

export function verifyAhtreeConsistency(
  proof: readonly Uint8Array[],
  i: bigint,
  j: bigint,
  iRoot: Uint8Array,
  jRoot: Uint8Array,
): boolean {
  if (i > j || i === 0n || (i < j && proof.length === 0)) return false;
  if (i === j && proof.length === 0) return equalBytes(iRoot, jRoot);
  const [ciRoot, cjRoot] = evalAhtreeConsistency(proof, i, j);
  return equalBytes(iRoot, ciRoot) && equalBytes(jRoot, cjRoot);
}

export function evalAhtreeLastInclusion(
  proof: readonly Uint8Array[],
  leaf: Uint8Array,
): Uint8Array {
  let root = leaf;
  for (const h of proof) root = node(h, root);
  return root;
}

export function verifyAhtreeLastInclusion(
  proof: readonly Uint8Array[],
  i: bigint,
  leaf: Uint8Array,
  root: Uint8Array,
): boolean {
  if (i === 0n) return false;
  return equalBytes(root, evalAhtreeLastInclusion(proof, leaf));
}
