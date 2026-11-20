import type { EnvSource } from './env/parse-env.js';
import { EnvValidationError } from './env/parse-env.js';
import { type AiConfig, aiConfig } from './namespaces/ai.config.js';
import { type AppConfig, appConfig } from './namespaces/app.config.js';
import { type AuthConfig, authConfig } from './namespaces/auth.config.js';
import { type CacheConfig, cacheConfig } from './namespaces/cache.config.js';
import { type CassandraConfig, cassandraConfig } from './namespaces/cassandra.config.js';
import { type DatabaseConfig, databaseConfig } from './namespaces/database.config.js';
import { type GraphqlConfig, graphqlConfig } from './namespaces/graphql.config.js';
import { type GrpcConfig, grpcConfig } from './namespaces/grpc.config.js';
import { type ImmudbConfig, immudbConfig } from './namespaces/immudb.config.js';
import { type KafkaConfig, kafkaConfig } from './namespaces/kafka.config.js';
import { type MailConfig, mailConfig } from './namespaces/mail.config.js';
import {
  type ObservabilityConfig,
  observabilityConfig,
} from './namespaces/observability.config.js';
import { type OutboxConfig, outboxConfig } from './namespaces/outbox.config.js';
import { type RedisConfig, redisConfig } from './namespaces/redis.config.js';
import { type StorageConfig, storageConfig } from './namespaces/storage.config.js';
import { type ThrottleConfig, throttleConfig } from './namespaces/throttle.config.js';

/**
 * Every PLATFORM namespace keyed by name: the registry for docs, tests and `validateAllEnv`.
 * Domains own their namespaces and pass them to `validateAllEnv`.
 */
export const CONFIG_NAMESPACES = {
  app: appConfig,
  observability: observabilityConfig,
  database: databaseConfig,
  cassandra: cassandraConfig,
  immudb: immudbConfig,
  redis: redisConfig,
  kafka: kafkaConfig,
  outbox: outboxConfig,
  grpc: grpcConfig,
  auth: authConfig,
  throttle: throttleConfig,
  cache: cacheConfig,
  graphql: graphqlConfig,
  mail: mailConfig,
  storage: storageConfig,
  ai: aiConfig,
} as const;

export type ConfigNamespaceName = keyof typeof CONFIG_NAMESPACES;

/** All namespace factories (e.g. `ConfigModule.forRoot({ load: ALL_CONFIG_NAMESPACES })` in tests). */
export const ALL_CONFIG_NAMESPACES = Object.values(CONFIG_NAMESPACES);

export interface AllConfig {
  app: AppConfig;
  observability: ObservabilityConfig;
  database: DatabaseConfig;
  cassandra: CassandraConfig;
  immudb: ImmudbConfig;
  redis: RedisConfig;
  kafka: KafkaConfig;
  outbox: OutboxConfig;
  grpc: GrpcConfig;
  auth: AuthConfig;
  throttle: ThrottleConfig;
  cache: CacheConfig;
  graphql: GraphqlConfig;
  mail: MailConfig;
  storage: StorageConfig;
  ai: AiConfig;
}

/** What `validateAllEnv` needs from a namespace: its name and a pure `parse(env)`. */
export interface EnvNamespace<TName extends string = string, TConfig = unknown> {
  readonly namespace: TName;
  parse(env?: EnvSource): TConfig;
}

/** `{ [namespace]: parsed config }` for the domain namespaces passed to `validateAllEnv`. */
export type ConfigOfNamespaces<TNamespaces extends readonly EnvNamespace[]> = {
  [TNamespace in TNamespaces[number] as TNamespace['namespace']]: ReturnType<TNamespace['parse']>;
};

/**
 * Validates every platform namespace plus the domain-owned ones the caller passes (default `[]`,
 * e.g. `validateAllEnv(env, [ordersConfig])`) against `env`, and reports ALL problems at once
 * instead of one namespace per boot attempt. Script/CI-friendly. Throws an `EnvValidationError`
 * (namespace `'*'`, paths `<ns>.<VAR>`) listing every invalid variable, or an `Error` when two
 * namespaces share a name.
 */
export function validateAllEnv<const TExtra extends readonly EnvNamespace[] = []>(
  env: EnvSource = process.env,
  extraNamespaces?: TExtra,
): AllConfig & ConfigOfNamespaces<TExtra> {
  const namespaces: readonly EnvNamespace[] = [
    ...ALL_CONFIG_NAMESPACES,
    ...(extraNamespaces ?? []),
  ];
  const names = new Set<string>();
  for (const { namespace } of namespaces) {
    if (names.has(namespace))
      throw new Error(`Config namespace "${namespace}" is registered twice`);
    names.add(namespace);
  }
  const failures: EnvValidationError[] = [];
  const parsed: Record<string, unknown> = {};
  for (const ns of namespaces) {
    try {
      parsed[ns.namespace] = ns.parse(env);
    } catch (error) {
      if (!(error instanceof EnvValidationError)) throw error;
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const issues = failures.flatMap((failure) =>
      failure.issues.map((issue) => ({ ...issue, path: [failure.namespace, ...issue.path] })),
    );
    throw new EnvValidationError('*', issues);
  }
  return parsed as unknown as AllConfig & ConfigOfNamespaces<TExtra>;
}
