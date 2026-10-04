/**
 * Environment of the e2e process. Applied from `vi.hoisted` (before any other import runs),
 * because `ObservabilityModule.forRoot()` reads it while `AppModule`'s decorators evaluate — so
 * this file must not import anything.
 *
 * Every client that is not replaced by a fake points at port 1, where nothing listens: the suite
 * can never reach a real (or the developer's) Redis, Kafka, S3 or upstream gRPC service. The
 * short gRPC deadline bounds the "upstream down" test.
 */
export const GATEWAY_E2E_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERVICE_NAME: 'gateway-e2e',
  OTEL_SDK_DISABLED: 'true',
  OBSERVE_APP_KEY: '',
  OBSERVE_APP_SECRET: '',
  MAINTENANCE_MODE: 'false',
  REDIS_URL: 'redis://127.0.0.1:1',
  KAFKA_BROKERS: '127.0.0.1:1',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  IDENTITY_GRPC_URL: '127.0.0.1:1',
  NOTIFICATIONS_GRPC_URL: '127.0.0.1:1',
  BILLING_GRPC_URL: '127.0.0.1:1',
  GRPC_DEADLINE_MS: '2000',
};
