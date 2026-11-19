import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { validateAllEnv } from '../all-config.js';
import {
  IMMUDB_DEFAULT_ADMIN_PASSWORD,
  IMMUDB_LOCAL_PASSWORD,
  immudbConfig,
} from './immudb.config.js';

const PROD = { NODE_ENV: 'production' } as const;
const STRONG = 'R3al-Secret-Value!';
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n';

describe('immudb config', () => {
  it('defaults to the local compose immudb', () => {
    expect(immudbConfig.parse({})).toEqual({
      address: 'localhost:3322',
      database: 'app',
      credentials: { username: 'app_writer', password: IMMUDB_LOCAL_PASSWORD },
      admin: undefined,
      sessionPoolSize: 4,
      timeoutMs: 5_000,
      keepAliveIntervalMs: 60_000,
      tls: false,
      serverSigningPublicKeyPem: undefined,
      runMigrations: false,
    });
    expect(validateAllEnv({}).immudb.address).toBe('localhost:3322');
  });

  it('the local password satisfies immudb password policy (8-32, upper, digit, symbol)', () => {
    expect(IMMUDB_LOCAL_PASSWORD).toMatch(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,32}$/);
  });

  it('builds admin credentials only when the admin password is set', () => {
    expect(immudbConfig.parse({ IMMUDB_ADMIN_PASSWORD: 'immudb' }).admin).toEqual({
      username: 'immudb',
      password: 'immudb',
    });
  });

  it.each([
    ['IMMUDB_ADDRESS', 'localhost'],
    ['IMMUDB_DATABASE', 'Bad-Name'],
    ['IMMUDB_USERNAME', 'a b'],
    ['IMMUDB_KEEPALIVE_INTERVAL_MS', '180000'],
    ['IMMUDB_SESSION_POOL_SIZE', '0'],
    ['IMMUDB_SERVER_SIGNING_PUBLIC_KEY', 'bm90LWEtcGVt'],
  ])('rejects %s=%s', (key, value) => {
    const error = errorOf(() => immudbConfig.parse({ [key]: value }));
    expect(error.issues.map((issue) => issue.path[0])).toContain(key);
  });

  it('decodes a base64 PEM signing key', () => {
    const encoded = Buffer.from(PEM).toString('base64');
    expect(
      immudbConfig.parse({ IMMUDB_SERVER_SIGNING_PUBLIC_KEY: encoded }).serverSigningPublicKeyPem,
    ).toBe(PEM);
  });

  describe('IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE', () => {
    const write = (content: string): string => {
      const file = join(mkdtempSync(join(tmpdir(), 'immudb-key-')), 'key.pem');
      writeFileSync(file, content);
      return file;
    };

    it('reads a PEM file as is (text before the PEM block included)', () => {
      const file = write(PEM);
      expect(
        immudbConfig.parse({ IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: file })
          .serverSigningPublicKeyPem,
      ).toBe(PEM);
    });

    it('reads a base64 file as well', () => {
      const file = write(`${Buffer.from(PEM).toString('base64')}\n`);
      expect(
        immudbConfig.parse({ IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: file })
          .serverSigningPublicKeyPem,
      ).toBe(PEM);
    });

    it('rejects a missing file, a non-PEM file and both variants together', () => {
      const bad = [
        { IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: join(tmpdir(), 'immudb-no-such-key.pem') },
        { IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: write('not a key') },
        {
          IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE: write(PEM),
          IMMUDB_SERVER_SIGNING_PUBLIC_KEY: Buffer.from(PEM).toString('base64'),
        },
      ];
      for (const env of bad) {
        const error = errorOf(() => immudbConfig.parse(env));
        expect(error.issues.map((issue) => issue.path[0])).toContain(
          'IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE',
        );
      }
    });
  });

  describe('production guards', () => {
    it('refuses the local app password, the default admin password and plaintext gRPC', () => {
      const error = errorOf(() =>
        immudbConfig.parse({ ...PROD, IMMUDB_ADMIN_PASSWORD: IMMUDB_DEFAULT_ADMIN_PASSWORD }),
      );
      expect(error.issues.map((issue) => issue.path[0]).sort()).toEqual([
        'IMMUDB_ADMIN_PASSWORD',
        'IMMUDB_PASSWORD',
        'IMMUDB_TLS',
      ]);
      expect(error.message).not.toContain(IMMUDB_LOCAL_PASSWORD);
    });

    it('accepts real secrets with TLS, or the explicit opt-outs', () => {
      expect(() =>
        immudbConfig.parse({ ...PROD, IMMUDB_PASSWORD: STRONG, IMMUDB_TLS: 'true' }),
      ).not.toThrow();
      expect(() =>
        immudbConfig.parse({
          ...PROD,
          ALLOW_KNOWN_LOCAL_SECRETS: 'true',
          IMMUDB_ALLOW_INSECURE: 'true',
          IMMUDB_ADMIN_PASSWORD: IMMUDB_DEFAULT_ADMIN_PASSWORD,
        }),
      ).not.toThrow();
    });
  });
});
