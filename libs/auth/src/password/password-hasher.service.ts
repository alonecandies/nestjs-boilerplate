import { DomainValidationException } from '@app/common';
import { type AuthConfig, authConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { hash, type Options, parseOptions, verify } from '@node-rs/argon2';
import { MAX_PASSWORD_LENGTH } from '../auth.constants.js';

/**
 * `Algorithm.Argon2id` as a number: @node-rs/argon2's `Algorithm` is an ambient `const enum`
 * whose runtime object is EMPTY, unusable under isolatedModules/SWC (research integrations §5).
 * Hashing omits `algorithm` and relies on the library default (Argon2id).
 */
const ARGON2ID = 2;

/**
 * Argon2id password hashing (@node-rs/argon2, native). Cost parameters come from `ARGON2_*` env
 * (OWASP baseline m=19 MiB, t=2, p=1 ≈ 10 ms/hash). Hashing runs on the libuv threadpool, which it
 * shares with fs/dns/zlib/crypto. Keep `UV_THREADPOOL_SIZE` (env, default 4) at or below the CPUs
 * the container may use: more busy hashing threads than CPUs throttle the whole cgroup, event loop
 * included (measured: 16 threads on a 2-CPU cap took p95 from 36 ms to 304 ms — see
 * docs/PERFORMANCE.md). Each concurrent hash holds `memoryCost × parallelism` KiB.
 */
@Injectable()
export class PasswordHasher {
  private readonly options: Options;
  private dummyHash: Promise<string> | undefined;

  constructor(@Inject(authConfig.KEY) config: AuthConfig) {
    this.options = {
      memoryCost: config.argon2.memoryCost,
      timeCost: config.argon2.timeCost,
      parallelism: config.argon2.parallelism,
      outputLen: 32,
    };
  }

  /** PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) with a fresh random salt. */
  async hash(plain: string): Promise<string> {
    if (plain.length > MAX_PASSWORD_LENGTH) {
      throw new DomainValidationException('Password is too long', {
        code: 'PASSWORD_TOO_LONG',
        issues: [{ path: 'password', message: `At most ${MAX_PASSWORD_LENGTH} characters` }],
      });
    }
    return hash(plain, this.options);
  }

  /**
   * Constant-time comparison inside argon2. Malformed hashes and over-long inputs verify as
   * `false` instead of throwing — a login must fail the same way whatever went wrong.
   */
  async verify(hashed: string, plain: string): Promise<boolean> {
    if (plain.length > MAX_PASSWORD_LENGTH) return false;
    try {
      return await verify(hashed, plain);
    } catch {
      return false;
    }
  }

  /**
   * Burns one verification against a dummy hash and returns `false`. Call it when the user does
   * not exist so "unknown email" and "wrong password" take the same time (no user enumeration).
   */
  async verifyDummy(plain: string): Promise<false> {
    this.dummyHash ??= hash('dummy-password-for-timing-equalisation', this.options);
    await this.verify(await this.dummyHash, plain);
    return false;
  }

  /** `true` when `hashed` was produced with weaker/different parameters → rehash on next login. */
  needsRehash(hashed: string): boolean {
    try {
      const params = parseOptions(hashed);
      return (
        Number(params.algorithm) !== ARGON2ID ||
        params.memoryCost !== this.options.memoryCost ||
        params.timeCost !== this.options.timeCost ||
        params.parallelism !== this.options.parallelism
      );
    } catch {
      return true;
    }
  }
}
