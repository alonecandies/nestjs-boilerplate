/**
 * @app/testing — test-only helpers (Fastify e2e app factory, Proxy-based auto mocks).
 * Deliberately depends on NO other workspace package so any package can use it without cycles.
 * Only import it from `*.spec.ts` / `test/**` files (it pulls in `vitest`).
 */
export * from './create-test-app.js';
export * from './mocks/create-mock.js';
