import { AccessTokenDenylist, AuthModule, type Role, TokenService } from '@app/auth';
import { generateId, provideCommonEnhancers } from '@app/common';
import { storageConfig } from '@app/config';
import { InMemoryStorageService, StorageModule, StorageService } from '@app/storage';
import { createFastifyTestApp } from '@app/testing';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { FilesModule } from '../files.module.js';

/**
 * Test-only helper (a `*.test.ts` file: ignored by the SWC build, not collected by Vitest).
 * Boots `FilesModule` the way the gateway/monolith do — real AuthModule guards and
 * TokenService, the common enhancers (validation pipes + problem+json filter), a Fastify adapter
 * that auto-registers @fastify/multipart — with an in-memory `StorageService` and no Redis.
 */
export interface FilesTestApp {
  app: NestFastifyApplication;
  storage: InMemoryStorageService;
  /** A real signed access token (dev secret) for a user with `roles`. */
  tokenFor(roles: readonly Role[], userId?: string): Promise<string>;
}

/** Stands in for the Redis-backed denylist: nothing is revoked. */
const openDenylist: Pick<AccessTokenDenylist, 'enabled' | 'deny' | 'isDenied'> = {
  enabled: false,
  deny: async (): Promise<void> => undefined,
  isDenied: async (): Promise<boolean> => false,
};

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true }),
    AuthModule.forRootAsync(),
    StorageModule.forRootAsync({ driver: 'memory' }),
    FilesModule,
  ],
  providers: [...provideCommonEnhancers({ exposeInternalErrors: true })],
})
class FilesTestModule {}

export interface FilesTestAppOptions {
  /** `STORAGE_MAX_UPLOAD_BYTES` (default 4096). */
  maxUploadBytes?: number;
  /** e.g. an adapter that pre-registers @fastify/multipart, like `createHttpApp({ multipart })`. */
  adapter?: FastifyAdapter;
}

export async function createFilesTestApp(options: FilesTestAppOptions = {}): Promise<FilesTestApp> {
  const builder = Test.createTestingModule({ imports: [FilesTestModule] })
    .overrideProvider(AccessTokenDenylist)
    .useValue(openDenylist)
    .overrideProvider(storageConfig.KEY)
    .useValue(
      storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: String(options.maxUploadBytes ?? 4096) }),
    );
  const app = await createFastifyTestApp(builder, undefined, {
    appOptions: { logger: false },
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
  });

  const storage = app.get(StorageService);
  if (!(storage instanceof InMemoryStorageService)) throw new Error('expected the memory driver');
  const tokens = app.get(TokenService);

  return {
    app,
    storage,
    tokenFor: async (roles, userId = generateId()) =>
      (await tokens.issueAccessToken({ id: userId, email: `${userId}@example.com`, roles })).token,
  };
}
