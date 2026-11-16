import { ImmudbError } from '../errors/immudb.error.js';
import { sha256, u16 } from './bytes.js';

/**
 * `EntrySpecDigest_v0/_v1` for SQL rows, which carry no KV metadata (`pkg/client/sql.go` VerifyRow
 * builds the EntrySpec from key and value only).
 */
export function entrySpecDigestFor(
  version: number,
): (key: Uint8Array, value: Uint8Array) => Uint8Array {
  switch (version) {
    case 0:
      return (key, value) => sha256(key, sha256(value));
    case 1:
      return (key, value) => sha256(u16(0), u16(key.length), key, sha256(value));
    default:
      throw new ImmudbError('verification-failed', `unsupported immudb tx version ${version}`);
  }
}
