/**
 * Environment of the e2e process. Applied from `vi.hoisted` (before any other import runs),
 * because `ObservabilityModule.forRoot()` reads it while `AppModule`'s decorators evaluate — so
 * this file must not import anything.
 *
 * Every client that is not replaced by a fake points at port 1, where nothing listens: the suite
 * can never reach a real (or the developer's) Redis, Postgres, Cassandra, Kafka, SMTP or S3.
 */
export const MONOLITH_E2E_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERVICE_NAME: 'monolith-e2e',
  OTEL_SDK_DISABLED: 'true',
  OBSERVE_APP_KEY: '',
  OBSERVE_APP_SECRET: '',
  MAINTENANCE_MODE: 'false',
  REDIS_URL: 'redis://127.0.0.1:1',
  DATABASE_URL: 'postgres://e2e:e2e@127.0.0.1:1/e2e',
  DATABASE_RUN_MIGRATIONS: 'false',
  CASSANDRA_CONTACT_POINTS: '127.0.0.1',
  CASSANDRA_PORT: '1',
  CASSANDRA_RUN_MIGRATIONS: 'false',
  KAFKA_BROKERS: '127.0.0.1:1',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',
  S3_ENDPOINT: 'http://127.0.0.1:1',
};
