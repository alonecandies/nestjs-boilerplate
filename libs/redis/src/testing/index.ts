/**
 * @app/redis/testing — test doubles for code that depends on @app/redis. Not imported by
 * production code (separate subpath so it never lands in a service's module graph).
 */
export * from './in-memory-redis.js';
