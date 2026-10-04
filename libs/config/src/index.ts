/**
 * @app/config — typed, zod-validated, namespaced environment configuration. The ONLY package
 * allowed to read `process.env` (besides the documented otel/drizzle-kit exceptions).
 *
 * Usage: `ConfigModule.forFeature(redisConfig)` in the module, then
 * `@Inject(redisConfig.KEY) private readonly cfg: RedisConfig` (import `type RedisConfig`).
 */
export * from './all-config.js';
export * from './app-config.module.js';
export * from './define-config-namespace.js';
export * from './env/env.helpers.js';
export * from './env/parse-env.js';
export * from './namespaces/app.config.js';
export * from './namespaces/auth.config.js';
export * from './namespaces/cache.config.js';
export * from './namespaces/cassandra.config.js';
export * from './namespaces/database.config.js';
export * from './namespaces/graphql.config.js';
export * from './namespaces/grpc.config.js';
export * from './namespaces/kafka.config.js';
export * from './namespaces/mail.config.js';
export * from './namespaces/observability.config.js';
export * from './namespaces/redis.config.js';
export * from './namespaces/storage.config.js';
export * from './namespaces/stripe.config.js';
export * from './namespaces/throttle.config.js';
