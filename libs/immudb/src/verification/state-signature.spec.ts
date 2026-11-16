import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ImmudbState } from '../immudb.types.js';
import { stateSignedBytes, verifyStateSignature } from './state-signature.js';

const state: ImmudbState = {
  database: 'ab',
  txId: 1n,
  txHash: new Uint8Array(32).fill(1),
  signature: null,
};

describe('state signatures', () => {
  it('serialises like ImmutableState.ToBytes', () => {
    expect([...stateSignedBytes(state)]).toEqual([
      0,
      0,
      0,
      2,
      97,
      98,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      ...new Uint8Array(32).fill(1),
    ]);
  });

  it('verifies an ECDSA P-256 DER signature and rejects changes, other keys and no signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signature = new Uint8Array(
      sign('sha256', stateSignedBytes(state), { key: privateKey, dsaEncoding: 'der' }),
    );
    const signed = { ...state, signature };
    expect(verifyStateSignature(signed, pem)).toBe(true);
    expect(verifyStateSignature({ ...signed, txId: 2n }, pem)).toBe(false);
    expect(
      verifyStateSignature(signed, other.export({ type: 'spki', format: 'pem' }).toString()),
    ).toBe(false);
    expect(verifyStateSignature(state, pem)).toBe(false);
    expect(verifyStateSignature(signed, 'not a key')).toBe(false);
  });
});
