import { type NestApplicationOptions, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModuleBuilder } from '@nestjs/testing';

export interface FastifyTestAppOptions {
  /** Custom adapter (e.g. `new FastifyAdapter({ bodyLimit })`); a fresh default one otherwise. */
  adapter?: FastifyAdapter;
  /** Passed to `createNestApplication` (e.g. `{ rawBody: true }`, `{ logger: false }`). */
  appOptions?: NestApplicationOptions;
}

/**
 * Compiles a testing module into a READY Fastify app for `app.inject()` e2e tests (no port bound):
 * compile → Fastify adapter → URI versioning (default `v1`, same as `createHttpApp`) →
 * `configure(app)` (global pipes, middleware, WS adapter…) → `init()` → Fastify `ready()`.
 * `ready()` matters: without it plugins registered in `configure` aren't loaded and `inject()`
 * can race them. Close it with `await app.close()` in `afterAll`.
 */
export async function createFastifyTestApp(
  builder: TestingModuleBuilder,
  configure?: (app: NestFastifyApplication) => void | Promise<void>,
  options: FastifyTestAppOptions = {},
): Promise<NestFastifyApplication> {
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    options.adapter ?? new FastifyAdapter(),
    options.appOptions,
  );
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await configure?.(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
