import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorOf } from '../../test/error-of.js';
import { grpcConfig } from './grpc.config.js';

const b64 = (text: string): string => Buffer.from(text).toString('base64');

function p256Pair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const edge = p256Pair();
const next = p256Pair();
const PROD = { NODE_ENV: 'production', GRPC_ALLOW_INSECURE: 'true' } as const;

const write = (content: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'grpc-principal-')), 'key');
  writeFileSync(file, content);
  return file;
};

const issueKeys = (env: Record<string, string>): unknown[] =>
  errorOf(() => grpcConfig.parse(env)).issues.map((issue) => issue.path[0]);

describe('grpc namespace: principal assertions', () => {
  it('is off by default, with no signing key and no public keys', () => {
    expect(grpcConfig.parse({}).principalAssertion).toEqual({
      mode: 'off',
      ttlSec: 120,
      signingKey: undefined,
      publicKeys: [],
    });
  });

  it('reads the signing key (base64 PEM) with its key id, and the TTL', () => {
    const cfg = grpcConfig.parse({
      GRPC_PRINCIPAL_SIGNING_KEY: b64(edge.privatePem),
      GRPC_PRINCIPAL_SIGNING_KEY_ID: 'edge-2026-11',
      GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '300',
    }).principalAssertion;
    expect(cfg.signingKey).toEqual({ keyId: 'edge-2026-11', pem: edge.privatePem });
    expect(cfg.ttlSec).toBe(300);
  });

  it('reads the signing key from a file (a PEM with a comment line, or its base64)', () => {
    const pemFile = write(`# a comment line\n${edge.privatePem}`);
    expect(
      grpcConfig.parse({
        GRPC_PRINCIPAL_SIGNING_KEY_FILE: pemFile,
        GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1',
      }).principalAssertion.signingKey?.pem,
    ).toContain('BEGIN PRIVATE KEY');
    const b64File = write(`${b64(edge.privatePem)}\n`);
    expect(
      grpcConfig.parse({
        GRPC_PRINCIPAL_SIGNING_KEY_FILE: b64File,
        GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1',
      }).principalAssertion.signingKey?.pem,
    ).toBe(edge.privatePem);
  });

  it('reads several public keys (kid=base64 PEM, comma-separated) for a rotation', () => {
    const cfg = grpcConfig.parse({
      GRPC_PRINCIPAL_ASSERTION: 'warn',
      GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(edge.publicPem)}, k2=${b64(next.publicPem)}`,
    }).principalAssertion;
    expect(cfg.mode).toBe('warn');
    expect(cfg.publicKeys).toEqual([
      { keyId: 'k1', pem: edge.publicPem },
      { keyId: 'k2', pem: next.publicPem },
    ]);
  });

  it('reads the public keys from a file (one entry per line, # comments skipped)', () => {
    const file = write(`# compose-generated\nk1=${b64(edge.publicPem)}\n`);
    expect(
      grpcConfig.parse({ GRPC_PRINCIPAL_PUBLIC_KEYS_FILE: file }).principalAssertion.publicKeys,
    ).toEqual([{ keyId: 'k1', pem: edge.publicPem }]);
  });

  it.each([
    ['an unknown mode', { GRPC_PRINCIPAL_ASSERTION: 'audit' }, 'GRPC_PRINCIPAL_ASSERTION'],
    [
      'warn without a public key',
      { GRPC_PRINCIPAL_ASSERTION: 'warn' },
      'GRPC_PRINCIPAL_PUBLIC_KEYS',
    ],
    [
      'a signing key without its key id',
      { GRPC_PRINCIPAL_SIGNING_KEY: b64(edge.privatePem) },
      'GRPC_PRINCIPAL_SIGNING_KEY_ID',
    ],
    [
      'a signing key that is a public key',
      { GRPC_PRINCIPAL_SIGNING_KEY: b64(edge.publicPem), GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1' },
      'GRPC_PRINCIPAL_SIGNING_KEY',
    ],
    [
      'a public key entry that is a private key',
      { GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(edge.privatePem)}` },
      'GRPC_PRINCIPAL_PUBLIC_KEYS',
    ],
    [
      'a public key entry without a key id',
      { GRPC_PRINCIPAL_PUBLIC_KEYS: b64(edge.publicPem) },
      'GRPC_PRINCIPAL_PUBLIC_KEYS',
    ],
    [
      'a duplicated key id',
      { GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(edge.publicPem)},k1=${b64(next.publicPem)}` },
      'GRPC_PRINCIPAL_PUBLIC_KEYS',
    ],
    [
      'both signing key variants',
      {
        GRPC_PRINCIPAL_SIGNING_KEY: b64(edge.privatePem),
        GRPC_PRINCIPAL_SIGNING_KEY_FILE: '/nope',
        GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1',
      },
      'GRPC_PRINCIPAL_SIGNING_KEY_FILE',
    ],
    [
      'an unreadable signing key file',
      { GRPC_PRINCIPAL_SIGNING_KEY_FILE: '/does/not/exist', GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1' },
      'GRPC_PRINCIPAL_SIGNING_KEY_FILE',
    ],
    [
      'a TTL below 10 s',
      { GRPC_PRINCIPAL_ASSERTION_TTL_SEC: '5' },
      'GRPC_PRINCIPAL_ASSERTION_TTL_SEC',
    ],
  ])('rejects %s', (_label, env, key) => {
    expect(issueKeys(env)).toContain(key);
  });

  it('refuses a non-P-256 key (ES256 only)', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(issueKeys({ GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(pem)}` })).toContain(
      'GRPC_PRINCIPAL_PUBLIC_KEYS',
    );
  });

  describe('production refuses the compose-local key pair like other known local secrets', () => {
    it('refuses a compose-local key id or a marked PEM on either side', () => {
      expect(
        issueKeys({
          ...PROD,
          GRPC_PRINCIPAL_SIGNING_KEY: b64(edge.privatePem),
          GRPC_PRINCIPAL_SIGNING_KEY_ID: 'compose-local',
        }),
      ).toContain('GRPC_PRINCIPAL_SIGNING_KEY_ID');
      expect(
        issueKeys({
          ...PROD,
          GRPC_PRINCIPAL_SIGNING_KEY_FILE: write(`# compose-local key\n${edge.privatePem}`),
          GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1',
        }),
      ).toContain('GRPC_PRINCIPAL_SIGNING_KEY_FILE');
      expect(
        issueKeys({
          ...PROD,
          GRPC_PRINCIPAL_ASSERTION: 'warn',
          GRPC_PRINCIPAL_PUBLIC_KEYS_FILE: write(`compose-local=${b64(edge.publicPem)}\n`),
        }),
      ).toContain('GRPC_PRINCIPAL_PUBLIC_KEYS_FILE');
    });

    it('accepts them with ALLOW_KNOWN_LOCAL_SECRETS (the compose stack) and real keys anywhere', () => {
      const local = {
        GRPC_PRINCIPAL_ASSERTION: 'warn',
        GRPC_PRINCIPAL_PUBLIC_KEYS: `compose-local=${b64(edge.publicPem)}`,
      };
      expect(
        grpcConfig.parse({ ...PROD, ...local, ALLOW_KNOWN_LOCAL_SECRETS: 'true' })
          .principalAssertion.mode,
      ).toBe('warn');
      expect(
        grpcConfig.parse({
          ...PROD,
          GRPC_PRINCIPAL_ASSERTION: 'warn',
          GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(edge.publicPem)}`,
        }).principalAssertion.publicKeys,
      ).toHaveLength(1);
    });

    it('never echoes key material in an error', () => {
      const error = errorOf(() =>
        grpcConfig.parse({ GRPC_PRINCIPAL_PUBLIC_KEYS: `k1=${b64(edge.privatePem)}` }),
      );
      expect(error.message).not.toContain(b64(edge.privatePem).slice(0, 40));
      expect(error.message).not.toContain('PRIVATE KEY-----\n');
    });
  });
});
