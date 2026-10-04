import { DomainValidationException } from '@app/common';
import { authConfig } from '@app/config';
import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH } from '../auth.constants.js';
import { PasswordHasher } from './password-hasher.service.js';

// Cheap parameters keep the suite fast; production uses the OWASP baseline from config.
const config = authConfig.parse({
  NODE_ENV: 'test',
  ARGON2_MEMORY_COST: '1024',
  ARGON2_TIME_COST: '1',
  ARGON2_PARALLELISM: '1',
});
const hasher = new PasswordHasher(config);

describe('PasswordHasher', () => {
  it('hashes with Argon2id and the configured parameters, salted per hash', async () => {
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(first).not.toBe(second);
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const hashed = await hasher.hash('s3cret!');
    await expect(hasher.verify(hashed, 's3cret!')).resolves.toBe(true);
    await expect(hasher.verify(hashed, 's3cret?')).resolves.toBe(false);
  });

  it('treats malformed hashes and over-long inputs as a failed verification', async () => {
    await expect(hasher.verify('not-a-phc-string', 'x')).resolves.toBe(false);
    const hashed = await hasher.hash('x');
    await expect(hasher.verify(hashed, 'x'.repeat(MAX_PASSWORD_LENGTH + 1))).resolves.toBe(false);
    await expect(hasher.hash('x'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toBeInstanceOf(
      DomainValidationException,
    );
  });

  it('verifyDummy burns a real verification and always fails', async () => {
    await expect(hasher.verifyDummy('anything')).resolves.toBe(false);
    await expect(hasher.verifyDummy('anything-else')).resolves.toBe(false);
  });

  it('needsRehash detects parameter drift and garbage', async () => {
    const hashed = await hasher.hash('pw');
    expect(hasher.needsRehash(hashed)).toBe(false);
    const stronger = new PasswordHasher(
      authConfig.parse({ NODE_ENV: 'test', ARGON2_MEMORY_COST: '2048', ARGON2_TIME_COST: '1' }),
    );
    expect(stronger.needsRehash(hashed)).toBe(true);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });
});
