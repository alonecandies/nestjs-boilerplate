import { verify } from 'node:crypto';
import type { ImmudbState } from '../immudb.types.js';
import { concat, u32, u64 } from './bytes.js';

/** `ImmutableState.ToBytes` (pkg/api/schema/state.go): u32 len(db) ‖ db ‖ u64 txId ‖ txHash. */
export function stateSignedBytes(state: ImmudbState): Uint8Array {
  const db = new TextEncoder().encode(state.database);
  return concat([u32(db.length), db, u64(state.txId), state.txHash]);
}

/** ECDSA P-256 over sha256(stateSignedBytes), ASN.1 DER (pkg/signer/ecdsa.go `Verify`). */
export function verifyStateSignature(state: ImmudbState, publicKeyPem: string): boolean {
  if (state.signature === null) return false;
  try {
    return verify(
      'sha256',
      stateSignedBytes(state),
      { key: publicKeyPem, dsaEncoding: 'der' },
      state.signature,
    );
  } catch {
    return false;
  }
}
