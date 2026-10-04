# @app/config

Typed, zod-validated, namespaced environment configuration. **The only package allowed to read
`process.env`** (documented exceptions: `@app/observability/otel`, `drizzle.config.ts`, test setup).
Every namespace schema is keyed by the **env var names** (so errors name the variable to fix) and
transformed into a camelCase object. Defaults make `bun run dev` work against the local
docker-compose infra with zero `.env`.

## Public API

| Export                                                                           | Signature / notes                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppConfigModule.forRoot(opts?)`                                                 | `(opts?: { load?: ConfigFactory[] }) => DynamicModule` — global `ConfigModule` (cache, `ignoreEnvFile`), loads `app` + `observability`                                                                                                                |
| `xConfig` (14 namespaces)                                                        | `ConfigNamespace<'x', XConfig>` = `registerAs` factory + `KEY` + `namespace` + `schema` + `parse(env?)`                                                                                                                                               |
| `XConfig` types                                                                  | `ConfigType<typeof xConfig>` — import with `import { type XConfig }`                                                                                                                                                                                  |
| `xEnvSchema`                                                                     | the raw zod schema (env names → camelCase output)                                                                                                                                                                                                     |
| `parseEnv(ns, schema, env = process.env)`                                        | returns `z.output<schema>`; throws `EnvValidationError`                                                                                                                                                                                               |
| `EnvValidationError`                                                             | `extends Error`; `namespace`, `issues`; message `Invalid environment for "<ns>":\n<z.prettifyError>`                                                                                                                                                  |
| `defineConfigNamespace(name, schema)`                                            | build your own namespace the same way                                                                                                                                                                                                                 |
| `CONFIG_NAMESPACES`, `ALL_CONFIG_NAMESPACES`, `AllConfig`, `ConfigNamespaceName` | registry of all namespaces                                                                                                                                                                                                                            |
| `validateAllEnv(env = process.env)`                                              | parses every namespace, throws ONE aggregated error (paths `ns.VAR`)                                                                                                                                                                                  |
| Field helpers                                                                    | `zBool(default?)`, `zInt(default?, { min, max })`, `zPort(default?)`, `zCsv(default?, { nonEmpty })`, `zStr(default?, { min, pattern, patternMessage })`, `zUrl(default?, protocolRegex?)`, `zEnum(values, default?)`, `zNodeEnv()`, `zServiceName()` |
| Constants                                                                        | `NODE_ENVS`/`NodeEnv`, `LOG_LEVELS`/`LogLevel`, `CASSANDRA_CONSISTENCIES`, `KAFKA_SASL_MECHANISMS`, `STORAGE_DRIVERS`, `DEV_JWT_ACCESS_SECRET`, `DEV_JWT_REFRESH_SECRET`                                                                              |

Helper conventions: empty/blank values count as **unset** (fall back to the default); booleans accept
`true/false/1/0` (case-insensitive); integers are strict base-10; CSV is trimmed, de-duplicated, empties dropped.

## Namespaces → env vars (defaults)

| ns              | variables                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`           | `NODE_ENV` (development), `SERVICE_NAME` (app), `HOST` (0.0.0.0), `PORT` (3000), `CORS_ORIGINS` (localhost:3000,5173), `TRUST_PROXY` (true), `BODY_LIMIT_BYTES` (1 MiB), `HTTP_KEEP_ALIVE_TIMEOUT_MS` (72000), `HTTP_REQUEST_TIMEOUT_MS` (30000), `CLUSTER_WORKERS` (1; 0 = per core), `SHUTDOWN_TIMEOUT_MS` (10000), `MAINTENANCE_MODE` (false), `DOCS_ENABLED` (!prod) → + `isProduction/isDevelopment/isTest` |
| `observability` | `LOG_LEVEL` (info), `LOG_PRETTY` (dev), `METRICS_ENABLED` (true), `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP[_TRACES]_ENDPOINT` (tracing on only with an endpoint unless explicitly toggled), `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET`/`OBSERVE_SERVICE_ID` → `observe.enabled`                                                                                                                                      |
| `database`      | `DATABASE_URL` (postgres://app:app@localhost:5432/app), `DATABASE_POOL_MAX` (20), `DATABASE_IDLE_TIMEOUT_SEC` (30), `DATABASE_MAX_LIFETIME_SEC` (1800), `DATABASE_CONNECT_TIMEOUT_SEC` (10), `DATABASE_STATEMENT_TIMEOUT_MS` (15000), `DATABASE_PREPARE` (true), `DATABASE_LOG_QUERIES` (false), `DATABASE_RUN_MIGRATIONS` (false)                                                                               |
| `cassandra`     | `CASSANDRA_CONTACT_POINTS` (localhost), `CASSANDRA_PORT` (9042), `CASSANDRA_LOCAL_DC` (datacenter1), `CASSANDRA_KEYSPACE` (app), `CASSANDRA_USERNAME`+`CASSANDRA_PASSWORD`, `CASSANDRA_REPLICATION_FACTOR` (1), `CASSANDRA_CONSISTENCY` (localOne), `CASSANDRA_CORE_CONNECTIONS` (2), `CASSANDRA_REQUEST_TIMEOUT_MS` (12000), `CASSANDRA_RUN_MIGRATIONS` (true)                                                  |
| `redis`         | `REDIS_URL` (redis://localhost:6379), `REDIS_KEY_PREFIX` (app), `REDIS_MAX_RETRIES_PER_REQUEST` (3), `REDIS_CONNECT_TIMEOUT_MS` (10000)                                                                                                                                                                                                                                                                          |
| `kafka`         | `KAFKA_BROKERS` (localhost:9094), `KAFKA_CLIENT_ID`/`KAFKA_GROUP_ID` (SERVICE_NAME), `KAFKA_CONSUMER_CONCURRENCY` (3), `KAFKA_SSL` (false), `KAFKA_SASL_MECHANISM`/`USERNAME`/`PASSWORD`, `KAFKA_CONNECTION_TIMEOUT_MS` (3000), `KAFKA_REQUEST_TIMEOUT_MS` (30000)                                                                                                                                               |
| `grpc`          | `GRPC_URL` (0.0.0.0:50051), `IDENTITY_GRPC_URL` (:50051), `NOTIFICATIONS_GRPC_URL` (:50052), `BILLING_GRPC_URL` (:50053), `GRPC_DEADLINE_MS` (5000), `GRPC_MAX_MESSAGE_BYTES` (4 MiB)                                                                                                                                                                                                                            |
| `auth`          | `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (≥ 32 chars, dev defaults), `JWT_ACCESS_TTL_SEC` (900), `JWT_REFRESH_TTL_SEC` (604800), `JWT_ISSUER`/`JWT_AUDIENCE` (nestjs-boilerplate), `ARGON2_MEMORY_COST` (19456), `ARGON2_TIME_COST` (2), `ARGON2_PARALLELISM` (1), `AUTH_DENYLIST_ENABLED` (true)                                                                                                                |
| `throttle`      | `THROTTLE_TTL_MS` (60000), `THROTTLE_LIMIT` (100), `THROTTLE_AUTH_TTL_MS` (60000), `THROTTLE_AUTH_LIMIT` (10)                                                                                                                                                                                                                                                                                                    |
| `cache`         | `CACHE_TTL_MS` (30000), `CACHE_L1_TTL_MS` (5000, ≤ CACHE_TTL_MS), `CACHE_L1_MAX_ITEMS` (5000)                                                                                                                                                                                                                                                                                                                    |
| `graphql`       | `GRAPHQL_PATH` (/graphql), `GRAPHQL_SANDBOX` (!prod), `GRAPHQL_INTROSPECTION` (!prod), `GRAPHQL_MAX_COMPLEXITY` (250), `GRAPHQL_SCHEMA_FILE`                                                                                                                                                                                                                                                                     |
| `mail`          | `SMTP_HOST` (localhost), `SMTP_PORT` (1025), `SMTP_SECURE` (false), `SMTP_USER`+`SMTP_PASSWORD` → `auth: { user, pass }`, `MAIL_FROM`, `SMTP_POOL` (true), `SMTP_MAX_CONNECTIONS` (5), `MAIL_QUEUE_CONCURRENCY` (5)                                                                                                                                                                                              |
| `storage`       | `STORAGE_DRIVER` (s3\|gcs), `STORAGE_MAX_UPLOAD_BYTES` (25 MiB), `STORAGE_SIGNED_URL_TTL_SEC` (900, ≤ 7 d), `S3_ENDPOINT` (http://localhost:9000), `S3_PUBLIC_ENDPOINT` (= endpoint), `S3_REGION`, `S3_FORCE_PATH_STYLE` (true), `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (rustfsadmin), `S3_BUCKET` (uploads), `GCS_PROJECT_ID`, `GCS_BUCKET`, `GCS_API_ENDPOINT` (http://localhost:4443), `GCS_KEY_FILE`      |
| `stripe`        | `STRIPE_SECRET_KEY` (sk_test_placeholder; `sk_`/`rk_` prefix), `STRIPE_WEBHOOK_SECRET` (whsec_placeholder), `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_MAX_NETWORK_RETRIES` (2), `STRIPE_TIMEOUT_MS` (20000)                                                                                                                                                                                             |

## Usage

```ts
// app.module.ts
@Module({ imports: [AppConfigModule.forRoot(), RedisModule.forRootAsync() /* … */] })
export class AppModule {}

// redis.module.ts — load the namespace where it is injected
@Module({ imports: [ConfigModule.forFeature(redisConfig)], providers: [RedisService] })
export class RedisModule {}

@Injectable()
export class RedisService {
  constructor(@Inject(redisConfig.KEY) private readonly cfg: RedisConfig) {} // `import { type RedisConfig }`
}

// scripts / cluster primary (no Nest): same validation, same defaults
const { url } = databaseConfig.parse(); // or parseEnv('database', databaseEnvSchema)
```

## Gotchas

- Import config **types** with `import { type XConfig }` (they are types; a value import in a decorated
  constructor breaks the ESM link after SWC — tsc TS1484 catches it).
- `.env` is loaded by Node (`--env-file-if-exists`), not by `ConfigModule` (`ignoreEnvFile: true`).
- Factories read `process.env` **when Nest instantiates them** (or when you call `x.parse()`), not at import
  time — test code can set env vars before building the module. Prefer `xConfig.parse({ … })` in unit tests.
- Only `app` and `observability` are global; every other namespace must be loaded with
  `ConfigModule.forFeature(xConfig)` in the consuming module (fail-fast only on env a service really uses).
- In `production`, the dev JWT secrets (and identical access/refresh secrets) are rejected at boot.
- `CASSANDRA_KEYSPACE` and `REDIS_KEY_PREFIX` are restricted to identifier characters (they are interpolated
  into CQL / keys). Paired credentials (`CASSANDRA_USERNAME`+`PASSWORD`, `SMTP_USER`+`PASSWORD`, Kafka SASL)
  must be set together.
- Error messages name variables, never values (env holds secrets).
