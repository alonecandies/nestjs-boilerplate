import { mapValues } from 'lodash-es';
import type { EnvSource } from './env/parse-env.js';
import { EnvValidationError } from './env/parse-env.js';
import { type AppConfig, appConfig } from './namespaces/app.config.js';
import { type AuthConfig, authConfig } from './namespaces/auth.config.js';
import { type CacheConfig, cacheConfig } from './namespaces/cache.config.js';
import { type CassandraConfig, cassandraConfig } from './namespaces/cassandra.config.js';
import { type DatabaseConfig, databaseConfig } from './namespaces/database.config.js';
import { type GraphqlConfig, graphqlConfig } from './namespaces/graphql.config.js';
import { type GrpcConfig, grpcConfig } from './namespaces/grpc.config.js';
import { type KafkaConfig, kafkaConfig } from './namespaces/kafka.config.js';
import { type MailConfig, mailConfig } from './namespaces/mail.config.js';
import {
  type ObservabilityConfig,
  observabilityConfig,
} from './namespaces/observability.config.js';
import { type RedisConfig, redisConfig } from './namespaces/redis.config.js';
import { type StorageConfig, storageConfig } from './namespaces/storage.config.js';
import { type StripeConfig, stripeConfig } from './namespaces/stripe.config.js';
import { type ThrottleConfig, throttleConfig } from './namespaces/throttle.config.js';

/** Every namespace keyed by name — the single registry for docs, tests and `validateAllEnv`. */
export const CONFIG_NAMESPACES = {
  app: appConfig,
  observability: observabilityConfig,
  database: databaseConfig,
  cassandra: cassandraConfig,
  redis: redisConfig,
  kafka: kafkaConfig,
  grpc: grpcConfig,
  auth: authConfig,
  throttle: throttleConfig,
  cache: cacheConfig,
  graphql: graphqlConfig,
  mail: mailConfig,
  storage: storageConfig,
  stripe: stripeConfig,
} as const;

export type ConfigNamespaceName = keyof typeof CONFIG_NAMESPACES;

/** All namespace factories (e.g. `ConfigModule.forRoot({ load: ALL_CONFIG_NAMESPACES })` in tests). */
export const ALL_CONFIG_NAMESPACES = Object.values(CONFIG_NAMESPACES);

export interface AllConfig {
  app: AppConfig;
  observability: ObservabilityConfig;
  database: DatabaseConfig;
  cassandra: CassandraConfig;
  redis: RedisConfig;
  kafka: KafkaConfig;
  grpc: GrpcConfig;
  auth: AuthConfig;
  throttle: ThrottleConfig;
  cache: CacheConfig;
  graphql: GraphqlConfig;
  mail: MailConfig;
  storage: StorageConfig;
  stripe: StripeConfig;
}

/**
 * Validates EVERY namespace against `env` and reports all problems at once (instead of one
 * namespace per boot attempt). Script/CI-friendly: `node -e "import('@app/config').then(m => m.validateAllEnv())"`.
 * Throws an `EnvValidationError` (namespace `'*'`) listing every invalid variable.
 */
export function validateAllEnv(env: EnvSource = process.env): AllConfig {
  const failures: EnvValidationError[] = [];
  const parsed = mapValues(CONFIG_NAMESPACES, (ns): unknown => {
    try {
      return ns.parse(env);
    } catch (error) {
      if (error instanceof EnvValidationError) {
        failures.push(error);
        return undefined;
      }
      throw error;
    }
  });
  if (failures.length > 0) {
    const issues = failures.flatMap((failure) =>
      failure.issues.map((issue) => ({ ...issue, path: [failure.namespace, ...issue.path] })),
    );
    throw new EnvValidationError('*', issues);
  }
  return parsed as unknown as AllConfig;
}
