import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zNodeEnv, zServiceName, zStr, zUrl } from '../env/env.helpers.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const observabilityEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    SERVICE_NAME: zServiceName(),
    LOG_LEVEL: zEnum(LOG_LEVELS, 'info'),
    LOG_PRETTY: zBool(),
    METRICS_ENABLED: zBool(true),
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
    const otlpEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const observeEnabled = Boolean(env.OBSERVE_APP_KEY && env.OBSERVE_APP_SECRET);
    return {
      serviceName: env.SERVICE_NAME,
      logLevel: env.LOG_LEVEL,
      /** Pretty logs cost ~5x throughput — dev only by default. */
      logPretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
      metricsEnabled: env.METRICS_ENABLED,
      /** When set, `/metrics` answers 404 unless the scrape sends `Authorization: Bearer <token>`. */
      metricsBearerToken: env.METRICS_BEARER_TOKEN,
      /** Explicit `OTEL_SDK_DISABLED` wins; otherwise tracing is on only when an OTLP endpoint is set. */
      tracingEnabled:
        env.OTEL_SDK_DISABLED === undefined ? otlpEndpoint !== undefined : !env.OTEL_SDK_DISABLED,
      otlpEndpoint,
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
