import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zNodeEnv, zPort, zServiceName, zStr, zUrl } from '../env/env.helpers.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const observabilityEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    SERVICE_NAME: zServiceName(),
    LOG_LEVEL: zEnum(LOG_LEVELS, 'info'),
    LOG_PRETTY: zBool(),
    METRICS_ENABLED: zBool(true),
    // The separate /metrics listener (never the API port). 0 = OS-picked (tests).
    METRICS_PORT: zPort(9464),
    // Optional shared secret for GET /metrics (`Authorization: Bearer <token>`); unset = open.
    METRICS_BEARER_TOKEN: zStr(undefined, { min: 16 }),
    OTEL_SDK_DISABLED: zBool(),
    OTEL_EXPORTER_OTLP_ENDPOINT: zUrl(),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: zUrl(),
    OBSERVE_APP_KEY: zStr(),
    OBSERVE_APP_SECRET: zStr(),
    OBSERVE_SERVICE_ID: zStr(),
  })
  .transform((env) => {
    const observeEnabled = Boolean(env.OBSERVE_APP_KEY && env.OBSERVE_APP_SECRET);
    return {
      serviceName: env.SERVICE_NAME,
      logLevel: env.LOG_LEVEL,
      /** Pretty logs cost ~5x throughput — dev only by default. */
      logPretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
      metricsEnabled: env.METRICS_ENABLED,
      /** Port of the metrics listener (`/metrics` is not served on the API port). */
      metricsPort: env.METRICS_PORT,
      /** When set, `/metrics` answers 404 unless the scrape sends `Authorization: Bearer <token>`. */
      metricsBearerToken: env.METRICS_BEARER_TOKEN,
      observe: {
        /** `@nestjs/observe` is only wired when both credentials are present. */
        enabled: observeEnabled,
        appKey: env.OBSERVE_APP_KEY,
        appSecret: env.OBSERVE_APP_SECRET,
        serviceId: env.OBSERVE_SERVICE_ID ?? env.SERVICE_NAME,
      },
    };
  });

/** Logging (pino), Prometheus metrics, OpenTelemetry tracing and `@nestjs/observe`. */
export const observabilityConfig = defineConfigNamespace('observability', observabilityEnvSchema);
export type ObservabilityConfig = ConfigType<typeof observabilityConfig>;
