/**
 * Tracing preload — runs BEFORE `main.ts` (`node --import ./dist/instrument.js dist/main.js`), so
 * the OpenTelemetry ESM hooks are registered before Fastify, grpc-js, ioredis, kafkajs… are
 * imported. Must not import Nest or anything instrumented. No-op unless an OTLP endpoint is
 * configured (`OTEL_EXPORTER_OTLP_ENDPOINT`) and `OTEL_SDK_DISABLED` is not `true`.
 */
import { startTracing } from '@app/observability/otel';
import { GATEWAY_SERVICE_NAME } from './app.constants.js';

await startTracing({ serviceName: GATEWAY_SERVICE_NAME });
