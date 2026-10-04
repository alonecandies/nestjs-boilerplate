import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the plain `instanceof` checks against `@nestjs/microservices` classes (`KafkaContext`,
 * `KafkaRetriableException`, `RpcException`, `GrpcException`) in this package. They hold only if
 * the copy this package imports is the copy `@nestjs/core` loads the transports from, which
 * `bunfig.toml`'s hoisted linker guarantees. An isolated install created a second, peer-variant
 * copy: every check silently became false in the apps (no dead-lettering, no Kafka CLS context,
 * Nest's RpcExceptions mapped to INTERNAL). This test fails before that can ship again.
 */
describe('single @nestjs/microservices copy', () => {
  it('resolves to the same file from this package and from @nestjs/core', () => {
    const fromHere = createRequire(import.meta.url);
    const fromCore = createRequire(fromHere.resolve('@nestjs/core'));
    expect(realpathSync(fromCore.resolve('@nestjs/microservices'))).toBe(
      realpathSync(fromHere.resolve('@nestjs/microservices')),
    );
  });
});
