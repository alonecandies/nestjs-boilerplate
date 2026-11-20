/*
 * Preloaded with `node --import ./dist/instrument.js dist/main.js`: OpenTelemetry must hook the
 * module loader BEFORE Nest, postgres.js, grpc-js or the AI SDK (fetch/undici) are imported, so this
 * file imports nothing but the Nest-free `./otel` subpath. No-op unless an OTLP endpoint is
 * configured.
 */
import { startTracing } from '@platform/observability/otel';

await startTracing({ serviceName: 'ai-service' });
