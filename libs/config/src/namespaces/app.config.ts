import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import {
  zBool,
  zCsv,
  zInt,
  zNodeEnv,
  zPort,
  zServiceName,
  zStr,
  zTrustProxy,
} from '../env/env.helpers.js';

export const appEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    SERVICE_NAME: zServiceName(),
    HOST: zStr('0.0.0.0'),
    PORT: zPort(3000),
    CORS_ORIGINS: zCsv('http://localhost:3000,http://localhost:5173'),
    // Default: trust nobody (req.ip = socket address). Behind a load balancer / ingress, list ITS
    // addresses or CIDRs. `true` trusts every hop, so any client could pick its own req.ip (and its
    // own per-IP throttle bucket) with X-Forwarded-For: rejected in production below.
    TRUST_PROXY: zTrustProxy(false),
    BODY_LIMIT_BYTES: zInt(1_048_576, { min: 1 }),
    // > the load balancer's idle timeout (typically 60s), otherwise the LB reuses sockets the
    // server already closed → sporadic 502s.
    HTTP_KEEP_ALIVE_TIMEOUT_MS: zInt(72_000, { min: 0 }),
    HTTP_REQUEST_TIMEOUT_MS: zInt(30_000, { min: 0 }),
    CLUSTER_WORKERS: zInt(1, { min: 0, max: 1024 }),
    SHUTDOWN_TIMEOUT_MS: zInt(10_000, { min: 0 }),
    MAINTENANCE_MODE: zBool(false),
    DOCS_ENABLED: zBool(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'TRUST_PROXY=true trusts a client-supplied X-Forwarded-For: in production list the load balancer IPs/CIDRs instead',
      });
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    serviceName: env.SERVICE_NAME,
    host: env.HOST,
    port: env.PORT,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    keepAliveTimeoutMs: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS,
    /** `0` = one worker per core (`os.availableParallelism()`); `1` = no cluster. */
    clusterWorkers: env.CLUSTER_WORKERS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    maintenanceMode: env.MAINTENANCE_MODE,
    /** Swagger/Scalar docs; off in production unless explicitly enabled. */
    docsEnabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
  }));

/** Process-wide settings: HTTP server, CORS, cluster, shutdown, maintenance, docs. */
export const appConfig = defineConfigNamespace('app', appEnvSchema);
export type AppConfig = ConfigType<typeof appConfig>;
