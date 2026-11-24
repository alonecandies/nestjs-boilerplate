import { generateKeyPairSync } from 'node:crypto';
import type * as Fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grpcConfig } from './grpc.config.js';

// Every read goes through the real `readFileSync`; the mock only counts them.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const b64 = (text: string): string => Buffer.from(text).toString('base64');

const write = (content: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'grpc-principal-keys-')), 'key');
  writeFileSync(file, content);
  return file;
};

const readsOf = (file: string): number =>
  vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file).length;

describe('grpc namespace: principal key files', () => {
  it('reads each _FILE key once per parse (the checks and the value share one read)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signingFile = write(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const publicFile = write(
      `k1=${b64(publicKey.export({ type: 'spki', format: 'pem' }).toString())}\n`,
    );
    vi.mocked(readFileSync).mockClear();

    const cfg = grpcConfig.parse({
      GRPC_PRINCIPAL_ASSERTION: 'warn',
      GRPC_PRINCIPAL_SIGNING_KEY_FILE: signingFile,
      GRPC_PRINCIPAL_SIGNING_KEY_ID: 'k1',
      GRPC_PRINCIPAL_PUBLIC_KEYS_FILE: publicFile,
    }).principalAssertion;

    expect(cfg.signingKey?.keyId).toBe('k1');
    expect(cfg.publicKeys.map((key) => key.keyId)).toEqual(['k1']);
    expect(readsOf(signingFile)).toBe(1);
    expect(readsOf(publicFile)).toBe(1);
  });
});
