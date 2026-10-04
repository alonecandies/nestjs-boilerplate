/**
 * @app/bootstrap — process/app factories shared by every app's `main.ts`: the Fastify-based Nest
 * application (`createHttpApp` / `createServiceApp`), `listen`, OpenAPI + Scalar docs, node:cluster
 * supervision and process-level safety nets.
 */
export {
  type ClusterLike,
  ClusterSupervisor,
  type ClusterWorkerLike,
  type RunClusteredOptions,
  resolveWorkerCount,
  runClustered,
  type SignalSource,
  type SupervisorSettings,
} from './cluster/run-clustered.js';
export {
  type ApiDocsOptions,
  OPENAPI_JSON_PATH,
  OPENAPI_YAML_PATH,
  setupApiDocs,
} from './docs/setup-api-docs.js';
export {
  buildFastifyOptions,
  type CreateHttpAppOptions,
  configureHttpApp,
  createHttpApp,
  DEFAULT_MULTIPART_LIMITS,
  type FastifyAdapterOptions,
  type HttpAppSetupOptions,
  type MultipartLimits,
} from './http/create-http-app.js';
export { type ListenOptions, listen } from './http/listen.js';
export { createServiceApp } from './http/microservice-app.js';
export { DOCS_CONTENT_SECURITY_POLICY, defaultHelmetOptions } from './http/security.js';
export {
  armShutdownTimer,
  installProcessHandlers,
  type ProcessHandlersOptions,
} from './process/process-handlers.js';
